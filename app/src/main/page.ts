// The page under review: one WebContentsView inside the app window, with the overlay injected.
//
// The overlay (built from ../../../overlay/src into dist/page-preload.cjs, see page-preload.ts) is
// the view's preload: Electron runs it before the page's own scripts in every document of the top
// frame, so it needs nothing from the page and survives reloads. It runs in the preload's script
// world (WORLD), which is the page's DOM but not the page's scripts: they can't see the overlay's
// globals or its way back to the app, window.__review, which sends over IPC. No debugger is
// attached, so the page's console and the rest of its runtime events never reach this process.
// This file knows nothing about notes: it hands the overlay's messages to the controller and
// offers load / capture / send. `Page` is what the controller has of it: what a page under review
// does, with no word of Electron in it. What is made of Electron (the view) is on `PageView`,
// which the shell that makes the page keeps; every script run in the page is in this file.
import { WebContentsView, type BrowserWindow, type DownloadItem, type IpcMainEvent, type NativeImage, type Session, type WebContents } from "electron"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { HostMessage, PageMessage } from "../../../overlay/protocol"
import { PHONE, type Device, type Phone, type Rect } from "../shared/types"
import type { Frame } from "./images"

export type PageState = {
  url: string
  loading: boolean
  error?: string
  /** The page's renderer is gone (it crashed, or the system killed it): nothing of the page is
   *  there, its overlay included, until it is loaded again. */
  crashed?: true
  /** The page tried to leave the web for another scheme and was stopped (see "what the page may
   *  do" below): the scheme, with its colon. Until the next document. */
  refused?: string
  canGoBack: boolean
  canGoForward: boolean
  hmr: boolean
}

/** overlay → host, as the overlay's protocol has it. What arrives is only known to have one of
 *  its types (PAGE_EVENTS below): its fields are the page's to fill, and are checked where used. */
export type { PageMessage }

export type Page = {
  state(): PageState
  /** "" shows the empty placeholder. Adds http:// when there is no scheme. */
  load(url: string): void
  reload(): void
  back(): void
  forward(): void
  /** Where the view sits in the window (CSS px); null hides it. */
  setBounds(bounds: Rect | null): void
  /** The page laid out as a phone's browser lays it out, or as it is (Device in shared/types.ts).
   *  How wide the view is stays the window's to say (setBounds). */
  setDevice(device: Device, phone: Phone): void
  /** host → overlay (window.__b42.receive). */
  send(msg: HostMessage): void
  /** The reviewer asked for a note outside this view: Send in a dock the window draws. The next
   *  note the overlay sends is let through as one that came with an Enter here is: one note, and
   *  only within the same second. The window is the app's own; the page's scripts cannot ask. */
  admitNote(): void
  /** A picture of the page as it is drawn now, in device pixels. */
  capture(): Promise<Frame>
  /** Reloads once the reviewer isn't mid-note (overlay busy() is false). No-op when the page hot-reloads itself. */
  reloadWhenIdle(): void
  /** Whether the reviewer is mid-note there (the overlay's busy()). False when the page has no
   *  overlay, or is gone. While the page is loading it waits for the load to end. */
  busy(): Promise<boolean>
  /** The page draws at its full rate, hidden or not, until the function returned is called
   *  (each once; holds may overlap). For a picture, and for what the overlay does on its way to
   *  one: it hides its card two frames before a note is sent. Otherwise a page in a hidden or
   *  minimised window is throttled like a background tab. */
  holdFrames(): () => void
  focus(): void
  /** The browser's developer tools for the page, in a window of their own. */
  openDevTools(): void
  /** The session the page's sites keep their storage, cookies and service workers in, by name
   *  (one per computer, core.ts). Another one than the page is in makes the page again in it,
   *  where it is, at its size, with the placeholder loaded: nothing of a site of one session is
   *  ever shown in another. True when it changed. */
  setPartition(name: string): boolean
  dispose(): void
}

/** A download the page started, held until the reviewer says what becomes of it (see "downloads"
 *  below): nothing of it is where they would find it, and no dialog was shown. */
export type HeldDownload = {
  /** Who asked, as the address bar says a site: "localhost:5173". */
  site: string
  /** The file's name, as the site gave it. */
  file: string
  /** Its size in bytes, when the site said. */
  size?: number
  /** It goes on, and once it has all come it is put at `to` (a file the reviewer chose; one
   *  there is replaced). Resolves once it is there; rejects with what went wrong. */
  save(to: string): Promise<void>
  /** Not saved: it is stopped, and nothing of it is kept. */
  cancel(): void
}

/** The page with the view it is made of: for whoever made it (the Electron shell, the tests that
 *  drive a real one), not for the controller. */
export type PageView = Page & { readonly view: WebContentsView }

type Options = {
  /** The path of page-preload.cjs: the overlay, and the lookup that runs among the page's own scripts. */
  preload: string
  /** The session the page starts in (setPartition changes it). Default "persist:review". */
  partition?: string
  /** overlay → host. */
  onMessage(msg: PageMessage): void
  /** state() changed. */
  onChange(): void
  onShortcut(key: "focus-url" | "toggle-panel" | "focus-chat" | "toggle-review"): void
  /** What a download the page starts becomes: held in a folder of its own under `folder` (one
   *  of the app's, not where the reviewer keeps files) and said to `ask`; `gone` once one that
   *  was asked about and not answered ended by itself (it failed, or the page it was asked on
   *  is closed). Without it, every download is refused. */
  downloads?: { folder: string; ask(download: HeldDownload): void; gone(download: HeldDownload): void }
  log(level: "info" | "warn" | "error", msg: string, data?: unknown): void
}

const PAGE_EVENTS = new Set(["ready", "toggle", "mode", "draft", "note", "pins-placement", "pin", "edits-shown", "frame-shown", "panel"])
/** After a note finishes, give the dev server a moment to write and rebuild before reloading. */
const RELOAD_DELAY = 400
const BUSY_RETRY = 700
/** How long after a real Enter a note may arrive. The overlay sends it two frames after the key. */
const ENTER_WINDOW = 1000

// Signs that a page hot-reloads itself: Vite's client (also Astro, SvelteKit, Remix-Vite), React
// Refresh, webpack/Next/Parcel HMR, or a livereload script. Reloading those would only lose state.
const HMR_PROBE = `!!(window.$RefreshReg$ || window.$RefreshHelpers$ || window.__vite_plugin_react_preamble_installed__ ||
  window.webpackHotUpdate || window.parcelHotUpdate || window.__NEXT_HMR_CB ||
  (window.__NEXT_DATA__ && window.__NEXT_DATA__.buildId === "development") ||
  document.querySelector('script[src*="/@vite/client"],script[src*="react-refresh"],script[src*="webpack-hot"],script[src*="livereload"],nextjs-portal'))`

const BUSY = "!!(window.__b42 && window.__b42.busy && window.__b42.busy())"
/** The script world the overlay and window.__review live in, apart from the page's own: the one
 *  Electron runs a preload in when contextIsolation is on. */
export const WORLD = 999
/** overlay → main, and main → overlay (page-preload.ts has the same two). */
const FROM_OVERLAY = "b42:overlay-says"
const TO_OVERLAY = "b42:host-says"
/** The preload's question at a document's start: is this page shown as a phone's? (Answered at once.) */
const IS_PHONE = "b42:is-phone"

const EMPTY = `<!doctype html><meta charset=utf-8><style>
html{height:100%;background:#f1eadf;color:#0a0a0a;font:14px/1.5 system-ui,sans-serif}
body{height:100%;margin:0;display:grid;place-items:center}
@media (prefers-color-scheme:dark){html{background:#0a0a0a;color:#f1eadf}}
</style><p>Type your dev URL above.</p>`

/** A capture as images.ts takes it: what it does to one, and none of the rest of a NativeImage. */
const frameOf = (image: NativeImage): Frame => ({
  getSize: () => image.getSize(),
  crop: (rect) => frameOf(image.crop(rect)),
  resize: (to) => frameOf(image.resize({ width: to.width, height: to.height, quality: "good" })),
  toJPEG: (quality) => image.toJPEG(quality),
})

/** The placeholder and the blank first page are ours, not the reviewer's: no overlay, no URL to show. */
const internal = (url: string) => /^(data|about):/.test(url)

// ── what the page may do ─────────────────────────────────────────────────────────────────────────
// The page is a site under review, and the site may be another computer's (an agent's over ssh,
// forwarded here): content the reviewer did not write, inside the reviewer's computer. Electron
// grants a page every permission it asks for unless told otherwise, and hands a link of a scheme
// it does not know (an app's, "mailto:") to the system, which opens the app it names. So the
// page's sessions refuse every permission and every check of one, and the page may only go to
// web addresses: anything else is stopped, and the reviewer told which scheme it was.
//
// Nothing the review needs is a permission: the overlay runs in the preload's world and reaches
// the app over IPC; a note's picture is taken by main (capturePage); a picture pasted into a note
// comes with the paste event (no clipboard-read); the developer tools are opened by the app.

/** Where a frame may go: the top one to web pages only; one inside it also to what never leaves
 *  the page (about:blank, srcdoc, data:, blob:), which a site's own frames are made of. */
const WEB = /^https?:/i
const IN_PAGE = /^(https?|about|data|blob):/i
/** The scheme of an address the page tried, for the line that says so: "mailto:". */
const schemeOf = (to: string) => `${/^([a-z][a-z0-9+.-]{0,30}):/i.exec(to)?.[1]?.toLowerCase() ?? "unknown"}:`

/** Each page's view, for the session's handlers: which page a request is from. */
const refusers = new WeakMap<WebContents, (to: string) => void>()
/** …and which page a download is of: what it does with one (it must give it a file then and
 *  there, or Electron shows its own dialog). A download of a view not here is refused. */
const holders = new WeakMap<WebContents, (event: Electron.Event, item: DownloadItem) => void>()
const guarded = new WeakSet<Session>()
/** A session the page is made in refuses everything, once and for every view in it. */
function guard(session: Session) {
  if (guarded.has(session)) return
  guarded.add(session)
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    // A link of another scheme, by whatever way it came (a frame, a redirect): the system would open it.
    if (permission === "openExternal") refusers.get(contents)?.((details as { externalURL?: string }).externalURL ?? "")
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
  // USB, HID and serial devices (WebUSB, WebHID, Web Serial): Electron's default is no, said here too.
  session.setDevicePermissionHandler(() => false)
  // Every download is the page's to hold, or refused (see "downloads" in createPage).
  session.on("will-download", (event, item, contents) => {
    const hold = contents && holders.get(contents)
    if (hold) hold(event, item)
    else event.preventDefault()
  })
}

/** The host of a web address ("localhost:5173"), or "" for anything else (an opaque origin's
 *  "null", a blob's, none). */
const webHost = (address: string) => {
  try {
    const u = new URL(address)
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : ""
  } catch {
    return ""
  }
}

/** A file's name as a site gave it, made a name and nothing more: no folder in it, none of the
 *  characters a file system refuses, not hidden, not empty. */
const fileName = (given: string) => {
  const name = path.basename(given.replace(/\\/g, "/")).replace(/[\x00-\x1f<>:"|?*]/g, "_").replace(/^[.\s]+/, "").trim().slice(0, 200)
  return name || "download"
}

/** A file moved from where it was held to where it was asked for: renamed, or copied when the
 *  two are on different disks. */
async function moveFile(from: string, to: string) {
  try {
    await fs.promises.rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err
    await fs.promises.copyFile(from, to)
    await fs.promises.rm(from, { force: true })
  }
}

export async function createPage(window: BrowserWindow, opts: Options): Promise<PageView> {
  const { log } = opts
  // The pane the window draws around the page has a 10 px radius and a 1 px border.
  const PAGE_RADIUS = 9
  let partition = opts.partition ?? "persist:review"
  const make = () =>
    new WebContentsView({
      webPreferences: {
        partition,
        // The overlay, in a world of its own; top frame only (no nodeIntegrationInSubFrames).
        preload: opts.preload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // Throttled while the window is hidden or minimised, like a background tab; a picture and
        // a note on its way lift that for as long as they need frames (holdFrames).
        backgroundThrottling: true,
        // A page that loads (or reloads after a note) must not pull focus out of the chat box.
        focusOnNavigation: false,
      },
    })
  let view = make()
  view.setBorderRadius(PAGE_RADIUS)
  let wc = view.webContents
  let history = wc.navigationHistory
  window.contentView.addChildView(view)
  /** What every view the page is in listens to (`each` below), wired to the next one made too. */
  const wiring: Array<(w: WebContents) => void> = []
  const each = (f: (w: WebContents) => void) => {
    wiring.push(f)
    f(wc)
  }
  /** A handler of one view's: nothing once the page is in another (a view being closed still
   *  says things: its unload, its renderer ending). */
  const mine =
    <A extends unknown[]>(w: WebContents, fn: (...a: A) => void) =>
    (...a: A): void => {
      if (w === wc) fn(...a)
    }
  each((w) => {
    guard(w.session)
    refusers.set(w, (to) => w === wc && refuse(to))
  })

  let url = ""
  let loading = false
  let error: string | undefined
  /** Why the overlay is missing. Kept apart from `error`, which every new load clears. */
  let overlayError: string | undefined
  let hmr = false
  /** Closing the view is not instant; nothing may touch it once dispose() was called. */
  let disposed = false
  /** When the reviewer last pressed Enter in this view; 0 once that Enter has admitted its note. */
  let enterAt = 0
  /** The last real left click released in the view (see the note check below). */
  let clickAt = 0
  /** When a note was last refused here (see below): at most one answer a second. */
  let refusedAt = 0
  let forgeryLogged = false
  /** The scheme the page last tried to leave for, until the next document (PageState.refused). */
  let refused: string | undefined
  /** The load now under way was redirected to such a scheme by its server, and so failed: why,
   *  for its error (a load fails as ERR_FAILED, which says nothing). */
  let redirectedOut: string | undefined
  const failure = (fallback: string) => (redirectedOut ? `The site sent the page on to an address that is not a web page's ("${redirectedOut}"), which is not allowed.` : fallback)
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  let probeTimer: ReturnType<typeof setTimeout> | undefined
  /** How many holds keep the page drawing (holdFrames), and the one an Enter or a click takes. */
  let holds = 0
  let inputHold: { release(): void; timer: ReturnType<typeof setTimeout> } | undefined

  const gone = () => disposed || wc.isDestroyed()

  // ── the page as a phone's ────────────────────────────────────────────────────────────────────
  // Chromium's own emulation, the kind its developer tools use: the viewport tag counts and
  // scrollbars lie over the page, so a view 390 px wide is a layout 390 px wide (a desktop's
  // scrollbar would leave it 375). The pointer stays a mouse: the overlay's gestures are a
  // mouse's. It belongs to the renderer, and a navigation to another site starts a new one: asked
  // for again once each navigation commits, which is before the new document's first script runs.
  //
  // The page's viewport is the phone's screen whatever room the window has for it: a view
  // narrower than the phone (the window gives it the phone's shape, smaller, when the phone is
  // taller than its room) shows the same page drawn smaller, by the view's width over the
  // phone's. So 100vh is the phone's height in a short window too, and the pointer still lands
  // where it points (Chromium maps it).
  //
  // Not before the first document, though: a view that has loaded nothing has no widget to
  // emulate, and Chromium does not refuse the call, it crashes on it (SIGSEGV, the whole app:
  // a start with the page left as a phone's did). Until a navigation has committed, and while
  // the renderer is gone, what was asked for is only kept: the next commit applies it.
  let device: Device = "desktop"
  let phone: Phone = PHONE
  let committed = false
  /** How much smaller than life the phone is drawn: the view's width over the phone's, 1 at most. */
  const fit = () => {
    const w = view.getBounds().width
    return w > 0 && w < phone.width ? w / phone.width : 1
  }
  let fitted = 1
  /** The view's corners: the pane's (inside its hairline), or a phone's screen's own at the size
   *  it is drawn (no hairline is around those: the system draws them its own way). */
  const shape = () => {
    if (gone()) return
    view.setBorderRadius(device === "phone" ? Math.round(phone.radius * fit()) : PAGE_RADIUS)
  }
  const emulate = () => {
    shape()
    if (gone() || !committed || wc.isCrashed()) return
    if (device === "phone") {
      const size = { width: phone.width, height: phone.height }
      fitted = fit()
      wc.enableDeviceEmulation({ screenPosition: "mobile", screenSize: size, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: size, scale: fitted })
    } else wc.disableDeviceEmulation()
  }
  each((w) => w.on("did-navigate", mine(w, () => {
    committed = true
    if (device === "phone") emulate()
  })))
  // A new document is not a phone's until it is told (emulation goes with the document before
  // it), and by then the page's own scripts may have had it laid out: as a desktop's, where
  // scrollbars take room (Linux, Windows, a Mac set to always show them) 15 px narrower. The zoom
  // a phone gives a page wider than its screen is then worked out from the narrower width, and
  // stays: a page 900 wide is shown 937 wide, with a strip of nothing at its right. So the
  // preload asks, before the page's first script, whether the document is a phone's, and starts
  // one with a scrollbar that takes no room (page-preload.ts), until it has loaded or is made a
  // desktop's (setDevice says so on the same channel). It has to know at once: asked and
  // answered in one go, the one such question in the app.
  // (Answered whatever view asks: a renderer waits on the answer, a view being closed too.)
  each((w) => w.ipc.on(IS_PHONE, (event) => void (event.returnValue = w === wc && device === "phone")))

  // ── overlay → main: window.__review in the preload's world, over IPC ─────────────────────────
  // The preload runs in the top frame only, and the placeholder gets no overlay (page-preload.ts).
  each((w) => w.ipc.on(FROM_OVERLAY, mine(w, (event: IpcMainEvent, payload: unknown) => {
    // Only the document now in the top frame speaks for the overlay; not one that just left.
    if (event.senderFrame !== wc.mainFrame || typeof payload !== "string") return
    let msg: unknown
    try {
      msg = JSON.parse(payload)
    } catch {
      return
    }
    if (typeof msg !== "object" || msg === null || !PAGE_EVENTS.has((msg as { type?: unknown }).type as string)) return
    // The page's scripts can't reach window.__review: it is in the preload's world. This is a
    // second lock behind that one. A note becomes instructions to a coding agent in the
    // reviewer's name: let one through only when the reviewer just pressed Enter in this view,
    // and only one per Enter. A script can't fake that: before-input-event sees real input, not
    // events the page dispatches.
    // A note can also be sent with a button (the note card's ↵, the edit bar's Send): a real click
    // in this view just before counts as the Enter does, once. That is weaker than Enter alone (a
    // page could slip its own note in right after any click of the reviewer's), a trade made
    // knowingly for a button to click.
    if ((msg as PageMessage).type === "note") {
      const since = enterAt || clickAt ? Date.now() - Math.max(enterAt, clickAt) : undefined
      const real = since !== undefined && since <= ENTER_WINDOW
      enterAt = clickAt = 0
      if (!real) {
        if (!forgeryLogged) log("warn", "page: dropped a note that no Enter key press or click came with (sent by the page's own script?)", { url, msSinceInput: since })
        forgeryLogged = true // once per page load: a hostile page would call it in a loop
        // The reviewer's own note can be late too (a page that stalls for a second after Enter).
        // The overlay is told, so the note does not look sent; it ignores an id it is not
        // waiting on, so a page's own script learns nothing and changes nothing with this.
        const id = (msg as { note?: { id?: unknown } }).note?.id
        if (typeof id === "string" && id.length <= 64 && Date.now() - refusedAt > 1000) {
          refusedAt = Date.now()
          send({ type: "captured", id, ok: false, why: "the page was busy. Press Enter again" })
        }
        return
      }
    }
    try {
      opts.onMessage(msg as PageMessage)
    } catch (err) {
      log("error", "page: handling an overlay message failed", { type: (msg as PageMessage).type, error: String(err) })
    }
  })))
  // A preload that fails (a missing file, an error in it) leaves the page without the overlay.
  each((w) => w.on("preload-error", mine(w, (_event, file, err) => {
    overlayError = `Review overlay unavailable: ${String(err)}`
    log("error", "page: the overlay's preload failed, pages load without it", { file, error: String(err) })
    opts.onChange()
  })))

  // ── frames ───────────────────────────────────────────────────────────────────────────────────
  function holdFrames(): () => void {
    if (gone()) return () => {}
    if (holds++ === 0) wc.setBackgroundThrottling(false)
    let held = true
    return () => {
      if (!held) return
      held = false
      if (--holds === 0 && !gone()) wc.setBackgroundThrottling(true)
    }
  }
  /** A real Enter or click may send a note, which the overlay does two frames later: the page
   *  keeps drawing for as long as page.ts would count it (ENTER_WINDOW). */
  function holdForInput() {
    if (inputHold) clearTimeout(inputHold.timer)
    const release = inputHold?.release ?? holdFrames()
    inputHold = { release, timer: setTimeout(() => ((inputHold = undefined), release()), ENTER_WINDOW) }
  }

  /** Navigations the app starts. */
  function navigate(go: () => void) {
    if (!gone()) go()
  }

  // ── state ────────────────────────────────────────────────────────────────────────────────────
  function state(): PageState {
    const shown = error ?? overlayError
    // The entries before the first real page are ours (blank, placeholder): not somewhere to go back to.
    const before = history.canGoBack() ? history.getEntryAtIndex(history.getActiveIndex() - 1)?.url : undefined
    return {
      url,
      loading,
      ...(shown ? { error: shown } : {}),
      ...(wc.isCrashed() ? { crashed: true as const } : {}),
      ...(refused ? { refused } : {}),
      canGoBack: before !== undefined && !internal(before),
      canGoForward: history.canGoForward(),
      hmr,
    }
  }

  async function probeHmr() {
    // (A renderer that just died says it stopped loading: nothing is asked of it.)
    if (gone() || wc.isCrashed()) return
    const at = wc.getURL()
    const found = internal(at) ? false : !!(await wc.executeJavaScript(HMR_PROBE, false).catch(() => false))
    if (gone() || wc.getURL() !== at || found === hmr) return
    hmr = found
    opts.onChange()
  }

  each((w) => w.on("did-start-loading", mine(w, () => {
    loading = true
    error = undefined
    redirectedOut = undefined
    opts.onChange()
  })))
  each((w) => w.on("did-stop-loading", mine(w, () => {
    loading = false
    opts.onChange()
    // Dev clients often attach a moment after load; look twice.
    void probeHmr()
    clearTimeout(probeTimer)
    probeTimer = setTimeout(() => void probeHmr(), 1500)
  })))
  // Only the document now in the top frame can fail the page. A failed load leaves Chromium's
  // error page (chrome-error://chromewebdata/) in a frame of its own, still loading; a good load
  // started before it finishes replaces that frame, and the frame it left then reports its own
  // load as failed (-3, no description), as the main frame, after the good page has committed.
  const current = (processId: number, routingId: number) => {
    const main = wc.mainFrame
    return !main || (main.processId === processId && main.routingId === routingId)
  }
  each((w) => w.on("did-fail-load", mine(w, (_e, code, desc, failed, isMain, processId, routingId) => {
    if (!isMain || code === -3 || !current(processId, routingId)) return // -3: aborted by a newer navigation
    error = failure(`${desc} (${code}) ${failed}`)
    opts.onChange()
  })))
  each((w) => w.on("render-process-gone", mine(w, (_e, details) => {
    error = `The page crashed (${details.reason}). Reload to try again.`
    log("error", "page: renderer gone", { reason: details.reason, exitCode: details.exitCode, url })
    opts.onChange()
  })))
  const navigated = (to: string) => {
    if (!internal(to) && to !== url) {
      url = to
      hmr = false // a different page; did-stop-loading probes again
    }
    opts.onChange() // back/forward may have changed even when the URL didn't
  }
  each((w) => w.on("did-navigate", mine(w, (_e, to) => {
    forgeryLogged = false // a new document (not a hash change, which a page can do in a loop)
    refused = undefined
    navigated(to)
  })))
  each((w) => w.on("did-navigate-in-page", mine(w, (_e, to, isMain) => void (isMain && navigated(to)))))
  // One page under review: links that want a new window open here instead.
  each((w) =>
    w.setWindowOpenHandler(({ url: to }) => {
      // The page picks this URL, not the reviewer: web pages only, as a browser would allow.
      if (w === wc) {
        if (WEB.test(to)) load(to)
        else refuse(to)
      }
      return { action: "deny" }
    }),
  )
  // Anywhere but the web is stopped (see "what the page may do"): a link, a script's
  // `location.href`, a form, in the top frame or one inside it. (Not what the app itself loads.)
  each((w) =>
    w.on(
      "will-frame-navigate",
      mine(w, (event) => {
        if ((event.isMainFrame ? WEB : IN_PAGE).test(event.url)) return
        event.preventDefault()
        refuse(event.url)
      }),
    ),
  )
  // A server's redirect to another scheme, also of a load the app started.
  each((w) =>
    w.on(
      "will-redirect",
      mine(w, (event) => {
        if ((event.isMainFrame ? WEB : IN_PAGE).test(event.url)) return
        event.preventDefault()
        if (event.isMainFrame) redirectedOut = schemeOf(event.url)
        refuse(event.url)
      }),
    ),
  )
  // ── downloads ──────────────────────────────────────────────────────────────────────────────
  // A page can start a download whenever it likes: a link with `download`, a response that says
  // it is an attachment, a script clicking a link to a blob it made, again and again. Electron's
  // way is the system's Save dialog at once, which does not say which site asked. Here a
  // download is held instead: it is given a file in a folder of its own under the app's
  // (opts.downloads.folder) and paused, then and there, and the controller asks the reviewer in
  // the window (core.ts). Saved, it goes on, and once it has all come it is moved to the file
  // they chose; not saved, it is cancelled, and nothing of it is kept.
  //
  // Held, not stopped and asked for again once the reviewer says yes: a download a script made
  // (a blob: address, gone once the page lets go of it) or the answer to a form's POST cannot be
  // asked for again, and a second request could be answered with something else. Electron gives
  // a download its file in will-download or not at all (no file given, it shows its dialog), so
  // the file it is given is the held one, and the move to the reviewer's comes after.
  /** Downloads asked about and not answered yet, of whichever view. */
  const waiting = new Set<HeldDownload>()
  function hold(w: WebContents, event: Electron.Event, item: DownloadItem) {
    const downloads = opts.downloads
    // Only the view the page is in now, and only with somewhere to hold it.
    if (!downloads || w !== wc || gone()) return void event.preventDefault()
    const file = fileName(item.getFilename())
    const dir = path.join(downloads.folder, crypto.randomUUID())
    item.setSavePath(path.join(dir, file))
    item.pause()
    const site = webHost(item.getInitiatorOrigin()) || webHost(url) || "The page"
    const size = item.getTotalBytes()
    const forget = () => void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    /** The download has ended (done): it completed, or it never will. */
    let ended = false
    /** It completed before it was answered: the whole file is held. */
    let arrived = false
    /** Saved: where it goes, and the promise save() gave. */
    let saved: { to: string; resolve(): void; reject(err: Error): void } | undefined
    const place = async () => {
      if (!saved) return
      const { to, resolve, reject } = saved
      try {
        await moveFile(item.getSavePath(), to)
        resolve()
      } catch (err) {
        reject(new Error(`It could not be put in ${to}: ${(err as Error).message}`))
      } finally {
        forget()
      }
    }
    const download: HeldDownload = {
      site,
      file,
      ...(size > 0 ? { size } : {}),
      save(to) {
        if (!waiting.delete(download)) return Promise.reject(new Error("The download is no longer there."))
        const done = new Promise<void>((resolve, reject) => (saved = { to, resolve, reject }))
        if (arrived) void place()
        else if (!ended) item.resume()
        return done
      },
      cancel() {
        if (!waiting.delete(download)) return
        if (ended) forget()
        else item.cancel() // (its done removes the folder)
      },
    }
    item.on("done", (_e, how) => {
      ended = true
      if (how === "completed") {
        if (saved) void place()
        else arrived = true // kept, held, until the reviewer answers
        return
      }
      forget()
      if (saved) saved.reject(new Error(how === "cancelled" ? "The download was cancelled." : "The download stopped before it had all come."))
      else if (waiting.delete(download)) {
        log("warn", "page: a download asked about ended before it was answered", { site, how })
        downloads.gone(download)
      }
    })
    waiting.add(download)
    log("info", "page: a download is held until the reviewer answers", { site, size: size || undefined })
    downloads.ask(download)
  }
  each((w) => holders.set(w, (event, item) => hold(w, event, item)))
  /** The view the waiting downloads were asked in is closing: none of them is answered now. */
  function dropWaiting() {
    for (const d of [...waiting]) {
      d.cancel()
      opts.downloads?.gone(d)
    }
  }

  /** The page tried to go to `to`, of a scheme it may not: said once per scheme and document. */
  function refuse(to: string) {
    const scheme = schemeOf(to)
    if (refused === scheme) return
    refused = scheme
    log("warn", "page: stopped the page from opening an address that is not a web page's", { scheme, url: url.slice(0, 200) })
    opts.onChange()
  }

  each((w) => w.on("before-mouse-event", mine(w, (_event, mouse) => {
    if (mouse.type !== "mouseUp" || mouse.button !== "left") return
    clickAt = Date.now()
    holdForInput()
  })))

  // ── keys while the page has focus ────────────────────────────────────────────────────────────
  // mod+U/P/O/I and mod+shift+P (the modes, the brush) are the overlay's own: they reach the page, and it sends "toggle" or "mode".
  each((w) => w.on("before-input-event", mine(w, (event, input) => {
    if (input.type !== "keyDown") return
    // Enter sends a note (alt+Enter to the background); remembered for the check in the message handler.
    if (input.key === "Enter") {
      enterAt = Date.now()
      holdForInput()
    }
    const mod = process.platform === "darwin" ? input.meta : input.control
    const key = input.key.toLowerCase()
    if (key === "f5" && !mod && !input.alt) {
      event.preventDefault()
      reload()
      return
    }
    if (!mod || input.shift || input.alt) return
    // The app's own mod+R would reload the whole window; reload the page instead.
    if (key === "r") reload()
    else if (key === "l") opts.onShortcut("focus-url")
    else if (key === "\\") opts.onShortcut("toggle-panel")
    else if (key === "k") opts.onShortcut("focus-chat")
    else return
    event.preventDefault()
  })))

  // ── navigation ───────────────────────────────────────────────────────────────────────────────
  function load(to: string) {
    to = to.trim()
    if (to && !/^[a-z][a-z0-9+.-]*:/i.test(to)) to = `http://${to}`
    // Shown at once, before it commits: when the load fails, the URL bar holds what to fix.
    url = to
    hmr = false
    error = undefined
    refused = undefined
    clearTimeout(reloadTimer)
    navigate(() => {
      wc.loadURL(to || `data:text/html,${encodeURIComponent(EMPTY)}`).catch((err: unknown) => {
        // did-fail-load has usually said it better already; an aborted load is not a failure.
        // Electron rejects with Chromium's number in `errno` and its description in `code`, and
        // the description can be empty: the error page's own aborted load (see did-fail-load)
        // rejects the good load's promise as `errno: -3, code: ""`. So the number decides.
        if (error || (err as { errno?: number }).errno === -3 || gone()) return
        error = failure(String(err))
        opts.onChange()
      })
    })
    opts.onChange()
  }

  function send(msg: HostMessage) {
    // A renderer that died has no overlay to hear it, and Electron logs an error for every
    // message it cannot deliver: nothing goes until the page is loaded again.
    if (gone() || wc.isCrashed()) return
    // No overlay on the page (placeholder, mid-navigation) is not an error: nothing listens, and
    // the overlay asks for state on "ready".
    try {
      wc.send(TO_OVERLAY, JSON.stringify(msg))
    } catch {}
  }

  /** Asked in the overlay's world of the top frame. False when there is none, or on an error. */
  async function busy(): Promise<boolean> {
    if (gone() || wc.isCrashed()) return false
    try {
      return (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: BUSY }])) === true
    } catch {
      return false // the document left while we asked
    }
  }

  function reload() {
    clearTimeout(reloadTimer)
    // After a failed load the view shows an error page (or still the previous one): ask for the URL again.
    if (error || wc.getURL() !== url) load(url)
    else navigate(() => wc.reload())
  }

  // Auto-reload: a static page (or a server without hot reload) shows stale content after the
  // agent's edit, and the next note's screenshot would show it too. Wait until the reviewer isn't
  // mid-note, then reload, which keeps the scroll position; pins and drafts live in the host, so
  // they come back.
  function reloadWhenIdle() {
    if (hmr || !url) return
    clearTimeout(reloadTimer)
    const from = url
    const tryNow = async () => {
      if (gone() || url !== from) return // the reviewer went elsewhere: nothing stale to refresh
      const midNote = await busy()
      if (gone() || url !== from) return
      if (midNote) reloadTimer = setTimeout(() => void tryNow(), BUSY_RETRY)
      else reload()
    }
    reloadTimer = setTimeout(() => void tryNow(), RELOAD_DELAY)
  }

  function setPartition(name: string): boolean {
    if (disposed || name === partition) return false
    partition = name
    const old = view
    const at = window.isDestroyed() ? -1 : window.contentView.children.indexOf(old)
    const bounds = old.getBounds()
    const visible = old.getVisible()
    view = make()
    wc = view.webContents
    history = wc.navigationHistory
    for (const f of wiring) f(wc)
    // Where the old one was, as it was: the same size, shown or hidden, its frames held or not.
    if (at >= 0) window.contentView.addChildView(view, at)
    view.setBounds(bounds)
    view.setVisible(visible)
    if (holds > 0) wc.setBackgroundThrottling(false)
    // Nothing of the page before is this one's: a phone's is made so again once it has a document.
    committed = false
    fitted = 1
    overlayError = undefined
    clearTimeout(probeTimer)
    enterAt = clickAt = 0
    shape()
    if (!window.isDestroyed()) window.contentView.removeChildView(old)
    if (!old.webContents.isDestroyed()) old.webContents.close()
    dropWaiting()
    load("")
    return true
  }

  return {
    get view() {
      return view
    },
    state,
    load,
    reload,
    back: () => state().canGoBack && navigate(() => history.goBack()),
    forward: () => history.canGoForward() && navigate(() => history.goForward()),
    setBounds(b) {
      if (!b) return view.setVisible(false)
      view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) })
      view.setVisible(true)
      // A phone's page in a box of another width is drawn at another size.
      if (device === "phone" && fit() !== fitted) emulate()
      else shape()
    },
    setDevice(d, p) {
      if (d === device && p.id === phone.id) return
      device = d
      phone = p
      emulate()
      // A document that started as a phone's and is still loading has a rule of ours for its
      // scrollbar (IS_PHONE above): a desktop's page is told, and takes it back at once.
      if (!gone() && committed && !wc.isCrashed()) wc.send(IS_PHONE, d === "phone")
    },
    send,
    admitNote() {
      if (gone()) return
      enterAt = Date.now()
      holdForInput() // the overlay sends it two frames on: the page draws them, hidden or not
    },
    capture: async () => frameOf(await wc.capturePage()),
    reloadWhenIdle,
    busy,
    holdFrames,
    focus: () => void (gone() || wc.focus()),
    // The overlay is the page's preload, not a debugger's: open or closed, the tools leave it be.
    openDevTools: () => void (gone() || wc.openDevTools({ mode: "detach" })),
    setPartition,
    dispose() {
      disposed = true
      clearTimeout(reloadTimer)
      clearTimeout(probeTimer)
      if (inputHold) clearTimeout(inputHold.timer)
      dropWaiting()
      if (!window.isDestroyed()) window.contentView.removeChildView(view)
      if (!wc.isDestroyed()) wc.close()
    },
  }
}

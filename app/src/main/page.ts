// The page under review: one WebContentsView inside the app window, with the overlay injected.
//
// The overlay (built from ../../../overlay/src into dist/page-preload.cjs, see page-preload.ts) is
// the view's preload: Electron runs it before the page's own scripts in every document of the top
// frame, so it needs nothing from the page and survives reloads. It runs in the preload's script
// world (WORLD), which is the page's DOM but not the page's scripts: they can't see the overlay's
// globals or its way back to the app, window.__review, which sends over IPC. A debugger is
// attached only while a phone's page is in Preview, for the pointer as a finger (setTouch), and
// it only ever asks the Emulation domain: the page's console and the rest of its runtime events
// never reach this process.
// This file knows nothing about notes: it hands the overlay's messages to the controller and
// offers load / capture / send. `Page` is what the controller has of it: what a page under review
// does, with no word of Electron in it. What is made of Electron (the view) is on `PageView`,
// which the shell that makes the page keeps; every script run in the page is in this file.
import { app, nativeTheme, WebContentsView, type BrowserWindow, type DownloadItem, type IpcMainEvent, type NativeImage, type Session, type WebContents } from "electron"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { HostMessage, PageMessage } from "../../../overlay/protocol"
import { PHONE, phoneEdge, viewportOf, type Device, type Phone, type PhoneSurround, type Rect } from "../shared/types"
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
  /** A phone's page: the colour of the status bar above it (AppState's page.tint). */
  tint?: string
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
  /** Where the view sits in the window (the window's own pixels, DIP); null hides it. */
  setBounds(bounds: Rect | null): void
  /** The app window's zoom: a phone's page is drawn up to that much larger than life, as the
   *  window draws the phone around it. Said before the bounds that come with it. */
  setZoom(zoom: number): void
  /** The page laid out as a phone's browser lays it out, or as it is (Device in shared/types.ts).
   *  How wide the view is stays the window's to say (setBounds). */
  setDevice(device: Device, phone: Phone): void
  /** The mouse acts as a finger on the page, as on a phone: no hover, `:hover` only on a tap,
   *  `(hover: none)` and `(pointer: coarse)`, taps for clicks. For a phone's page in Preview;
   *  off, the mouse is a mouse again (what the overlay's modes need). The page is not reloaded
   *  either way. */
  setTouch(on: boolean): void
  /** What the window draws around a phone's screen, which the overlay paints in the screen's
   *  bottom corners over the page (phoneEdge); undefined until the window says. */
  setSurround(around: PhoneSurround | undefined): void
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
 *  below): no dialog was shown, and it is paused in the app's own folder. (What came before the
 *  pause took hold is there too: a fast server's file can have come whole.) */
export type HeldDownload = {
  /** Who asked, as the address bar says a site: "localhost:5173". When `frame`, the page's site,
   *  and what asked is a frame in it of no site of its own (a sandboxed one, a data: one). */
  site: string
  frame?: true
  /** The site the file itself comes from, when it is not the one that asked ("files.example.com"). */
  from?: string
  /** The file's name, as the site gave it. */
  file: string
  /** Its size in bytes, when the site said. */
  size?: number
  /** It goes on, and once it has all come it is put at `to` (a file the reviewer chose; one
   *  there is replaced). Resolves once it is there; rejects with what went wrong (it stopped
   *  coming, nothing more of it came for a while, it could not be put there, or cancel()).
   *  `progress` hears the bytes that have come, as more comes (about once a second at most). */
  save(to: string, progress?: (received: number) => void): Promise<void>
  /** Not saved, or no longer: it is stopped, and nothing of it is kept. */
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
  onShortcut(key: "focus-url" | "toggle-panel" | "focus-chat" | "toggle-review" | "copy-url" | "zoom-in" | "zoom-out" | "zoom-reset"): void
  /** What a download the page starts becomes: held in a file of its own in `folder` (one of
   *  the app's, not where the reviewer keeps files; see holdDownloadsIn) and said to `ask`;
   *  `gone` once one that was asked about and not answered ended by itself (it failed, or the
   *  page it was asked on is closed). Without it, every download is refused. */
  downloads?: {
    folder: string
    ask(download: HeldDownload): void
    gone(download: HeldDownload): void
    /** How long a saved download may go with nothing more of it coming before it is given up
     *  (save() rejects). Default 60 s. */
    stallMs?: number
  }
  log(level: "info" | "warn" | "error", msg: string, data?: unknown): void
}

const PAGE_EVENTS = new Set(["ready", "toggle", "mode", "draft", "note", "pins-placement", "pin", "edits-shown", "frame-shown", "panel"])
/** Exported so tests can shorten them. Milliseconds. */
export const pageTiming = {
  /** After a note finishes, give the dev server a moment to write and rebuild before reloading. */
  reloadDelay: 400,
  busyRetry: 700,
  /** How long after a real Enter a note may arrive. The overlay sends it two frames after the key. */
  enterWindow: 1000,
}

// Signs that a page hot-reloads itself: Vite's client (also Astro, SvelteKit, Remix-Vite), React
// Refresh, webpack/Next/Parcel HMR, or a livereload script. Reloading those would only lose state.
const HMR_PROBE = `!!(window.$RefreshReg$ || window.$RefreshHelpers$ || window.__vite_plugin_react_preamble_installed__ ||
  window.webpackHotUpdate || window.parcelHotUpdate || window.__NEXT_HMR_CB ||
  (window.__NEXT_DATA__ && window.__NEXT_DATA__.buildId === "development") ||
  document.querySelector('script[src*="/@vite/client"],script[src*="react-refresh"],script[src*="webpack-hot"],script[src*="livereload"],nextjs-portal'))`

const BUSY = "!!(window.__b42 && window.__b42.busy && window.__b42.busy())"
/** The colour of a phone's status bar for this page (PageState's tint), asked in the overlay's
 *  world. Its theme-color, the first whose media matches (Chrome on Android colours its bar so,
 *  and Safari did until 26). Else what Safari 26 takes, which ignores theme-color: a bar fixed or
 *  sticky across the page's top (at most 4 px down, 80% of the width at least, over 10 px tall),
 *  its background made opaque; not what scrolls with the page, a hero or a header in the flow.
 *  Else the page's background: the root's, else the body's (CSS gives the body's to the canvas
 *  when the root has none), else the canvas, white or, for a page dark by its color-scheme,
 *  Chromium's dark one. Any way CSS writes a colour is read by drawing it. (Safari 26's rules are
 *  not Apple's documents but what was measured on iPhones: https://1ar.io/updates/safari-26-liquid-glass-web/,
 *  https://hawkshift.com/research/ios-26-safari-status-bar,
 *  https://arpit.blog/articles/2025/11/safari-drops-support-theme-color/.) The overlay's own
 *  element takes no pointer, so no hit test finds it; it is passed over all the same. */
const TINT_PROBE = `(() => {
  const g = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })
  const rgba = (c) => {
    if (!c) return null
    g.fillStyle = "#010203"
    g.fillStyle = c
    if (g.fillStyle === "#010203" && c.trim().toLowerCase() !== "#010203") return null
    g.clearRect(0, 0, 1, 1)
    g.fillRect(0, 0, 1, 1)
    return [...g.getImageData(0, 0, 1, 1).data]
  }
  const hex = (c) => "#" + c.slice(0, 3).map((n) => n.toString(16).padStart(2, "0")).join("")
  const opaque = (c) => (c && c[3] >= 250 ? c : null)
  const meta = [...document.querySelectorAll('meta[name="theme-color" i]')].find((m) => !m.media || matchMedia(m.media).matches)
  const theme = opaque(rgba(meta && meta.content))
  if (theme) return hex(theme)
  for (const el of document.elementsFromPoint(innerWidth / 2, 2)) {
    if (el.localName === "b42-review") continue
    const s = getComputedStyle(el)
    if (s.position !== "fixed" && s.position !== "sticky") continue
    const r = el.getBoundingClientRect()
    if (r.top > 4 || r.width < innerWidth * 0.8 || r.height <= 10) continue
    // (Drawn opaque whatever its alpha; one with no colour of its own leaves it to the page's.)
    const c = rgba(s.backgroundColor)
    if (c && c[3] > 0) return hex(c)
    break
  }
  const root = document.documentElement
  const scheme = getComputedStyle(root).colorScheme
  const dark = /dark/.test(scheme) && (!/light/.test(scheme) || matchMedia("(prefers-color-scheme: dark)").matches)
  return hex(opaque(rgba(getComputedStyle(root).backgroundColor)) ?? (document.body && opaque(rgba(getComputedStyle(document.body).backgroundColor))) ?? (dark ? [18, 18, 18, 255] : [255, 255, 255, 255]))
})()`
/** How long after a tap, a drag or the wheel the status bar's colour is asked again (the page may
 *  have changed its theme, or scrolled a bar of another colour to its top). */
const TINT_AFTER_INPUT = 250
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
// One exception, asked for by the app and not the page: once Figma's extension is in a session
// (extensions.ts), writing to the clipboard is allowed there (allowPermission).

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
/** What a session grants after all, by allowPermission. */
const allowed = new WeakMap<Session, Set<string>>()
/** One permission granted in the page's session from now on, where the app needs it: Figma's
 *  extension (extensions.ts) writes what it captured to the clipboard from the page,
 *  "clipboard-sanitized-write", which Chrome grants a page in front by itself. Writing only: never
 *  reading what is on the clipboard. */
export function allowPermission(session: Session, permission: "clipboard-sanitized-write") {
  const set = allowed.get(session) ?? new Set()
  set.add(permission)
  allowed.set(session, set)
}
/** A session the page is made in refuses everything, once and for every view in it. */
function guard(session: Session) {
  if (guarded.has(session)) return
  guarded.add(session)
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    // A link of another scheme, by whatever way it came (a frame, a redirect): the system would open it.
    if (permission === "openExternal") refusers.get(contents)?.((details as { externalURL?: string }).externalURL ?? "")
    callback(!!allowed.get(session)?.has(permission))
  })
  session.setPermissionCheckHandler((_contents, permission) => !!allowed.get(session)?.has(permission))
  // USB, HID and serial devices (WebUSB, WebHID, Web Serial): Electron's default is no, said here too.
  session.setDevicePermissionHandler(() => false)
  // Every download is the page's to hold, or refused (see "downloads" in createPage).
  session.on("will-download", (event, item, contents) => {
    const hold = contents && holders.get(contents)
    if (hold) hold(event, item)
    else {
      // Not the page's view: one being closed, or the page's developer tools (they share its
      // session; their "Save as…" and screenshots are refused too, and said in the log).
      event.preventDefault()
      console.warn(`[bicycle42] page: a download refused, not of the page's view (${contents?.getType?.() ?? "none"}: ${item.getFilename()})`)
    }
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

/** A file system takes a name of 255 bytes at most (ext4, APFS, NTFS's 255 UTF-16 units): a
 *  name is kept to this many bytes of UTF-8, with room to spare for what a disk adds. */
const NAME_BYTES = 200
/** `text` cut to at most `max` bytes of UTF-8, whole characters only (a pair of surrogates, a
 *  character of three bytes, is never split). */
function fitBytes(text: string, max: number) {
  let out = ""
  let bytes = 0
  for (const ch of text) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > max) break
    out += ch
    bytes += n
  }
  return out
}
/** A file's name as a site gave it, made a name and nothing more: no folder in it, none of the
 *  characters a file system refuses, not hidden, not empty, and not longer than a disk takes
 *  (cut by bytes, its extension kept). */
const fileName = (given: string) => {
  const name = path.basename(given.replace(/\\/g, "/")).replace(/[\x00-\x1f<>:"|?*]/g, "_").replace(/^[.\s]+/, "").trim()
  if (Buffer.byteLength(name) <= NAME_BYTES) return name || "download"
  const dot = name.lastIndexOf(".")
  const ext = dot > 0 && Buffer.byteLength(name.slice(dot)) <= 32 ? name.slice(dot) : ""
  return fitBytes(name.slice(0, name.length - ext.length), NAME_BYTES - Buffer.byteLength(ext)).trim() + ext || "download"
}

/** Who a download is said to be from (HeldDownload's site, frame, from), the page being at
 *  `pageUrl`. Electron 44 says to name it by its initiator origin, not by the URL or the
 *  webContents: a frame of another site is named as itself. An opaque one ("null": a sandboxed
 *  frame, a data: one) has no name, and does not borrow the page's: it is a frame in the page. No
 *  initiator at all is the app's own load (an address typed): named by the file's site. The
 *  file's site is said too when it is another (a link to another site's file); a blob: or data:
 *  file is the initiator's own. */
function askerOf(item: DownloadItem, pageUrl: string): Pick<HeldDownload, "site" | "frame" | "from"> {
  const initiator = item.getInitiatorOrigin()
  const chain = item.getURLChain()
  const fileHost = webHost(chain[chain.length - 1] ?? item.getURL())
  const pageHost = webHost(pageUrl)
  const asker = initiator === "null" ? { site: pageHost || "the page", frame: true as const } : { site: webHost(initiator) || fileHost || pageHost || "The page" }
  return { ...asker, ...(fileHost && fileHost !== asker.site ? { from: fileHost } : {}) }
}

/** A file moved from where it was held to where it was asked for: renamed, or, when the two are
 *  on different disks, copied to a name of its own beside it and then renamed over it, so a file
 *  of the reviewer's that was there is only replaced once the copy is whole (a copy that fails
 *  leaves it as it was, and nothing of the copy). `ops` is for the tests. */
export async function moveFile(from: string, to: string, ops = { rename: fs.promises.rename, copy: (a: string, b: string) => fs.promises.copyFile(a, b, fs.constants.COPYFILE_EXCL) }) {
  try {
    await ops.rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err
    const part = path.join(path.dirname(to), `.${fitBytes(path.basename(to), 60)}.${crypto.randomUUID().slice(0, 8)}.part`)
    try {
      await ops.copy(from, part)
      await fs.promises.rename(part, to)
    } catch (err) {
      await fs.promises.rm(part, { force: true }).catch(() => {})
      throw err
    }
    await fs.promises.rm(from, { force: true })
  }
}

/** Chromium writes every download first to a hidden file of its own (.org.chromium.Chromium.…)
 *  in the folder the app's "downloads" path names, before the download has a file of its own
 *  (will-download) and before it can be paused, and moves it to that file then. So that path is
 *  made `folder` (the held one), never the reviewer's Downloads: what comes before the pause
 *  takes hold comes there. (A session's setDownloadPath does not do it: the temporary file goes
 *  by the app's path, read at each download.) Whoever opens a Save dialog takes the reviewer's
 *  Downloads folder before this. */
export function holdDownloadsIn(folder: string) {
  fs.mkdirSync(folder, { recursive: true })
  app.setPath("downloads", folder)
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
  // scrollbar would leave it 375). The pointer stays a mouse here: the overlay's gestures are a
  // mouse's (a finger's is setTouch's, below). It belongs to the renderer, and a navigation to
  // another site starts a new one: asked for again once each navigation commits, which is before
  // the new document's first script runs.
  //
  // The window draws the phone around the view: its body and the status strip above. The view is
  // the rest of the screen, down to its bottom edge, as iOS 26's Safari gives a page: `screen` is
  // the whole screen, the viewport (innerHeight, 100vh) is the screen less the status bar
  // (viewportOf). What of the phone is over the page there (the home indicator, the screen's
  // rounded bottom corners) the window cannot draw: the overlay does (tellEdge, below).
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
  /** The app window's zoom (setZoom). */
  let zoom = 1
  /** How much smaller than life the phone is drawn: the view's width over the phone's, the
   *  window's zoom at most (the window draws the phone that much larger). */
  const fit = () => {
    const w = view.getBounds().width
    return w > 0 && w < phone.width * zoom ? w / phone.width : zoom
  }
  let fitted = 1
  /** The view's corners: the pane's (inside its hairline), or a phone's, square: its top corners
   *  are under the status strip, which is as tall as the screen's corners are round, and its
   *  bottom ones are the overlay's to round (phoneEdge). One radius rounds all four: any would
   *  show the window behind the page's top corners, below the strip. */
  const shape = () => {
    if (gone()) return
    view.setBorderRadius(device === "phone" ? 0 : PAGE_RADIUS)
  }
  const emulate = () => {
    shape()
    if (gone() || !committed || wc.isCrashed()) return
    if (device === "phone") {
      fitted = fit()
      wc.enableDeviceEmulation({ screenPosition: "mobile", screenSize: { width: phone.width, height: phone.height }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: viewportOf(phone), scale: fitted })
    } else {
      wc.disableDeviceEmulation()
      pinchable()
    }
    tellEdge()
  }
  /** A desktop's page can be pinched larger, as in a browser (a phone's can already: its mobile
   *  viewport has a page scale of its own). Electron holds every page at 1 unless told; told again
   *  with each document, after it has committed (as emulate is, above). */
  const pinchable = () => {
    if (device === "desktop" && !gone() && committed && !wc.isCrashed()) void wc.setVisualZoomLevelLimits(1, 5).catch(() => {})
  }

  // ── what of the phone is over its page: the overlay draws it ─────────────────────────────────
  // The home indicator and the screen's two bottom corners, over the page, in the colours the
  // window has around the screen (setSurround, from the window): PhoneEdge in overlay/protocol.ts,
  // at the size the page is drawn. Told to each new document's overlay (its "ready"), and again
  // when the phone, its size or those colours change; null to a desktop's page. Leaving
  // env(safe-area-inset-bottom) at 0: Chromium can set it (Emulation.setSafeAreaInsetsOverride),
  // but only over the debugger, which is attached for the finger in Preview alone, and a page
  // given 34 there without viewport-fit=cover would be given what Safari gives it only with it.
  let surround: PhoneSurround | undefined
  /** What the overlay of this document was last told, as JSON ("" for nothing yet). */
  let edgeSaid = ""
  function tellEdge() {
    if (gone() || !committed || wc.isCrashed()) return
    const edge = device === "phone" ? phoneEdge(phone, fitted, surround) : null
    const said = JSON.stringify(edge)
    if (said === edgeSaid) return
    edgeSaid = said
    send({ type: "device", phone: edge })
  }
  each((w) => w.on("did-navigate", mine(w, () => {
    committed = true
    if (device === "phone") emulate()
    else pinchable()
    applyTouch()
  })))

  // ── the pointer as a finger (a phone's page in Preview) ──────────────────────────────────────
  // What Chromium's developer tools do in their device mode, over the page's debugger: touch
  // emulation (maxTouchPoints, `(pointer: coarse)` and `(hover: none)`, no hover on mouse-over)
  // and the mouse sent as touches (a press is a touchstart, a click a tap, `:hover` sticks where
  // the finger last was). The wheel and a trackpad still scroll: the emulator lets them through.
  // A page that looks for 'ontouchstart' in window finds it from its next load (Chromium decides
  // it as a document starts); the rest holds at once, without a reload.
  // The settings are the browser's, kept across documents and renderers; they are said again
  // after each commit all the same (a crashed renderer's, a debugger detached meanwhile). Like
  // the emulation above, never before the view's first commit, nor while its renderer is gone.
  // Off, the debugger is detached, which undoes all of it; one attached by someone else (a test's
  // that drives input, say) is used and left attached, told to stop.
  let touch = false
  /** The view whose debugger this page attached, while it is attached. */
  let attachedTo: WebContents | undefined
  let touchRefusedLogged = false
  /** The view the finger was asked of, until it is told to stop. */
  let touchedIn: WebContents | undefined
  const applyTouch = () => {
    if (gone() || !committed || wc.isCrashed()) return
    const w = wc
    const d = w.debugger
    // Off, and nothing of ours to undo: nothing is said (not to another's debugger either).
    if (!touch && (touchedIn !== w || !d.isAttached())) return void (touchedIn = undefined)
    if (touch && !d.isAttached()) {
      try {
        d.attach("1.3")
      } catch (err) {
        if (!touchRefusedLogged) log("warn", "page: the debugger would not attach, the pointer stays a mouse", { error: String(err) })
        touchRefusedLogged = true
        return
      }
      attachedTo = w
      d.once("detach", () => void (attachedTo === w && (attachedTo = undefined)))
    }
    if (!touch && attachedTo === w) {
      attachedTo = touchedIn = undefined
      d.detach()
      return
    }
    touchedIn = touch ? w : undefined
    const failed = (err: unknown) => void (!gone() && w === wc && log("warn", "page: the pointer as a finger was refused", { error: String(err) }))
    d.sendCommand("Emulation.setTouchEmulationEnabled", touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }).catch(failed)
    d.sendCommand("Emulation.setEmitTouchEventsForMouse", touch ? { enabled: true, configuration: "mobile" } : { enabled: false }).catch(failed)
  }

  // ── the status bar's colour (a phone's page) ─────────────────────────────────────────────────
  // A phone's browser colours its status bar for the page: by its theme-color, else by a bar
  // fixed across its top, else by its background (TINT_PROBE). Asked once a load is done (and
  // once more a moment later, as the HMR probe looks twice), after a move within the page, a
  // tap, a drag or the wheel (debounced), and when the system's theme changes (a theme-color
  // for dark, a page's own dark colours). Only as a phone's: a desktop's page has no status bar.
  let tint: PageState["tint"]
  let tintTimer: ReturnType<typeof setTimeout> | undefined
  async function probeTint() {
    if (gone() || device !== "phone" || !committed || wc.isCrashed() || internal(wc.getURL())) return
    const at = wc.getURL()
    const found = (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: TINT_PROBE }]).catch(() => undefined)) as unknown
    if (gone() || wc.getURL() !== at || typeof found !== "string" || !/^#[0-9a-f]{6}$/.test(found) || found === tint) return
    tint = found
    opts.onChange()
  }
  const tintSoon = () => {
    if (device !== "phone") return
    clearTimeout(tintTimer)
    tintTimer = setTimeout(() => void probeTint(), TINT_AFTER_INPUT)
  }
  const themeChanged = () => tintSoon()
  nativeTheme.on("updated", themeChanged)
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
      const real = since !== undefined && since <= pageTiming.enterWindow
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
    // A new document's overlay knows nothing of the phone yet.
    if ((msg as PageMessage).type === "ready") {
      edgeSaid = ""
      tellEdge()
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
   *  keeps drawing for as long as page.ts would count it (pageTiming.enterWindow). */
  function holdForInput() {
    if (inputHold) clearTimeout(inputHold.timer)
    const release = inputHold?.release ?? holdFrames()
    inputHold = { release, timer: setTimeout(() => ((inputHold = undefined), release()), pageTiming.enterWindow) }
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
      ...(device === "phone" && tint ? { tint } : {}),
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
    void probeTint()
    clearTimeout(probeTimer)
    probeTimer = setTimeout(() => (void probeHmr(), void probeTint()), 1500)
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
  each((w) => w.on("did-navigate-in-page", mine(w, (_e, to, isMain) => void (isMain && (navigated(to), tintSoon())))))
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
  // download is held instead: it is given a file of its own in a folder of the app's
  // (opts.downloads.folder) and paused, then and there, and the controller asks the reviewer in
  // the window (core.ts). Saved, it goes on, and once it has all come it is moved to the file
  // they chose; not saved, it is cancelled, and nothing of it is kept. One that stops by itself
  // ("interrupted": Electron says so only as "updated", and never ends it) is cancelled while
  // held, and tried once more once saved; a saved one that nothing more of comes for stallMs is
  // given up. Neither is left pending for ever.
  //
  // Held, not stopped and asked for again once the reviewer says yes: a download a script made
  // (a blob: address, gone once the page lets go of it) or the answer to a form's POST cannot be
  // asked for again, and a second request could be answered with something else. Electron gives
  // a download its file in will-download or not at all (no file given, it shows its dialog), so
  // the file it is given is the held one, and the move to the reviewer's comes after.
  //
  // What is not held: Chromium writes a download to a file of its own before will-download, and
  // the pause takes hold only once the download has its file, so what a fast server sent by then
  // has come (a local one's can be the whole file, hundreds of MB). It comes into the app's
  // folder (holdDownloadsIn), not the reviewer's Downloads, and is thrown away with the rest.
  /** Downloads asked about and not answered yet, of whichever view. */
  const waiting = new Set<HeldDownload>()
  /** The address of a load of the app's own (load()) that became a download: not a failure. */
  let loadDownloaded: string | undefined
  /** load()s so far: a later one's failure is its own. */
  let loads = 0
  const sameAddress = (a: string, b: string) => {
    try {
      return new URL(a).href === new URL(b).href
    } catch {
      return a === b
    }
  }
  function hold(w: WebContents, event: Electron.Event, item: DownloadItem) {
    const downloads = opts.downloads
    // Only the view the page is in now, and only with somewhere to hold it.
    if (!downloads || w !== wc || gone()) return void event.preventDefault()
    const file = fileName(item.getFilename())
    // A file of its own in the held folder itself, by a name no other has (not a folder of its
    // own: Chromium makes a download's folder as it settles its file, after will-download, so a
    // folder removed by a cancel that soon came back, empty).
    const heldAt = path.join(downloads.folder, `${crypto.randomUUID()}-${file}`)
    item.setSavePath(heldAt)
    item.pause()
    // An address typed (load()) that is a download: the page stays where it was, and the load
    // did not fail (Electron rejects it, ERR_FAILED, before will-download).
    const first = item.getURLChain()[0] ?? item.getURL()
    if (sameAddress(first, url) && !sameAddress(wc.getURL(), url)) {
      loadDownloaded = url
      url = internal(wc.getURL()) ? "" : wc.getURL()
      error = undefined
      opts.onChange()
    }
    const asker = askerOf(item, url)
    const { site } = asker
    const size = item.getTotalBytes()
    const stallMs = downloads.stallMs ?? 60_000
    const forget = () => void fs.promises.rm(heldAt, { force: true }).catch(() => {})
    /** Chromium is done with it (done): it completed, was cancelled, or failed for good. */
    let finished = false
    /** It completed before it was answered: the whole file is held. */
    let arrived = false
    /** It is over for us: placed, or given up and cancelled. Nothing more is done with it. */
    let over = false
    /** Saved after an interruption once already (resume() is tried once). */
    let resumed = false
    /** Saved: where it goes, the promise save() gave, and who hears how much has come. */
    let saved: { to: string; resolve(): void; reject(err: Error): void; progress?: (received: number) => void } | undefined
    /** Nothing more of a saved one came for stallMs: it is given up. */
    let stall: ReturnType<typeof setTimeout> | undefined
    let received = -1
    const watch = () => {
      clearTimeout(stall)
      stall = setTimeout(() => stop(`Nothing more of it came for ${Math.round(stallMs / 1000)} s.`), stallMs)
    }
    /** It will not come: stopped (its file goes with it), nothing kept, and whoever waits told. */
    const stop = (why: string) => {
      if (over) return
      over = true
      clearTimeout(stall)
      if (!finished) item.cancel()
      forget()
      const s = saved
      saved = undefined
      if (s) s.reject(new Error(why))
      else if (waiting.delete(download)) {
        log("warn", "page: a download asked about ended before it was answered", { site, why })
        downloads.gone(download)
      }
    }
    const place = async () => {
      if (!saved || over) return
      over = true
      clearTimeout(stall)
      const { to, resolve, reject } = saved
      saved = undefined
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
      ...asker,
      file,
      ...(size > 0 ? { size } : {}),
      save(to, progress) {
        if (over || saved || !waiting.delete(download)) return Promise.reject(new Error("The download is no longer there."))
        const done = new Promise<void>((resolve, reject) => (saved = { to, resolve, reject, ...(progress ? { progress } : {}) }))
        if (arrived) void place()
        else {
          // (resume() says "updated" before it returns: what has come is counted from here.)
          received = item.getReceivedBytes()
          watch()
          item.resume()
        }
        return done
      },
      cancel() {
        if (over) return
        // Asked about and not answered: whoever cancels it knows (no `gone`). Saved: save() rejects.
        if (saved || waiting.delete(download)) stop("The download was cancelled.")
      },
    }
    item.on("updated", (_e, state) => {
      if (over) return
      if (state === "interrupted") {
        // It stopped, and Chromium says it may go on (a file that could not be made, a link
        // that dropped): it does not, by itself. Held, it is not answered now; saved, it is tried
        // once more, and given up if it stops again.
        // (Chromium has tried again by itself before it says so.) Both are done a tick later:
        // "updated" is said from inside Chromium's own loop over the item's observers, which
        // resume() and cancel() would run again from within (a reentrancy check it logs, and
        // may one day enforce).
        if (saved && !resumed && item.canResume()) {
          resumed = true
          log("warn", "page: a saved download stopped, trying once more", { site })
          watch()
          return void setImmediate(() => !over && item.resume())
        }
        return void setImmediate(() => stop("The download stopped before it had all come."))
      }
      if (!saved) return
      // (Chromium says "updated" about once a second at most, and again with nothing new.)
      const now = item.getReceivedBytes()
      if (now === received) return
      received = now
      watch()
      if (now > 0) saved.progress?.(now)
    })
    item.on("done", (_e, how) => {
      finished = true
      if (over) return forget()
      if (how === "completed") {
        if (saved) void place()
        else arrived = true // kept, held, until the reviewer answers
        return
      }
      stop(how === "cancelled" ? "The download was cancelled." : "The download stopped before it had all come.")
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
    if (mouse.type === "mouseUp" || mouse.type === "mouseWheel") tintSoon()
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
    // The window's zoom, from here as from the window.
    const z = zoomKeyOf(input)
    if (z) {
      event.preventDefault()
      opts.onShortcut(`zoom-${z}`)
      return
    }
    if (key === "f5" && !mod && !input.alt) {
      event.preventDefault()
      reload()
      return
    }
    if (!mod || input.alt) return
    // J and C by the key's place too, so they are the same keys on any layout (a Cyrillic one).
    const is = (letter: string) => key === letter || input.code === `Key${letter.toUpperCase()}`
    if (input.shift) {
      if (!is("c")) return
      opts.onShortcut("copy-url")
      event.preventDefault()
      return
    }
    // The app's own mod+R would reload the whole window; reload the page instead.
    if (key === "r") reload()
    else if (key === "l") opts.onShortcut("focus-url")
    else if (key === "\\" || is("j")) opts.onShortcut("toggle-panel")
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
    loadDownloaded = undefined
    const seq = ++loads
    navigate(() => {
      wc.loadURL(to || `data:text/html,${encodeURIComponent(EMPTY)}`).catch(async (err: unknown) => {
        // did-fail-load has usually said it better already; an aborted load is not a failure.
        // Electron rejects with Chromium's number in `errno` and its description in `code`, and
        // the description can be empty: the error page's own aborted load (see did-fail-load)
        // rejects the good load's promise as `errno: -3, code: ""`. So the number decides.
        const errno = (err as { errno?: number }).errno
        if (error || errno === -3 || gone()) return
        // An address that is a download rejects as ERR_FAILED (-2) a moment before will-download
        // holds it (hold): that is no failure, and the page stays where it was.
        if (errno === -2 && !redirectedOut) await new Promise((r) => setTimeout(r, 150))
        if (error || gone() || (loadDownloaded !== undefined && sameAddress(loadDownloaded, to)) || seq !== loads) return
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
      if (midNote) reloadTimer = setTimeout(() => void tryNow(), pageTiming.busyRetry)
      else reload()
    }
    reloadTimer = setTimeout(() => void tryNow(), pageTiming.reloadDelay)
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
    tint = undefined
    edgeSaid = ""
    attachedTo = touchedIn = undefined
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
      if (d === "phone") void probeTint()
      // A document that started as a phone's and is still loading has a rule of ours for its
      // scrollbar (IS_PHONE above): a desktop's page is told, and takes it back at once.
      if (!gone() && committed && !wc.isCrashed()) wc.send(IS_PHONE, d === "phone")
    },
    setZoom(z) {
      zoom = z
    },
    setTouch(on) {
      if (on === touch) return
      touch = on
      applyTouch()
    },
    setSurround(around) {
      surround = around
      tellEdge()
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
      clearTimeout(tintTimer)
      nativeTheme.off("updated", themeChanged)
      if (inputHold) clearTimeout(inputHold.timer)
      dropWaiting()
      // (Ours detached before the view closes: no command of it is left waiting on a renderer going away.)
      if (attachedTo === wc && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
      attachedTo = undefined
      if (!window.isDestroyed()) window.contentView.removeChildView(view)
      if (!wc.isDestroyed()) wc.close()
    },
  }
}

/** mod+= (or +), mod+-, mod+0: the app window's zoom in, out, back to 100%. By the key's place
 *  too, and the number pad's. Not with alt (mod+alt+… are other keys). */
export function zoomKeyOf(input: Electron.Input): "in" | "out" | "reset" | undefined {
  const mod = process.platform === "darwin" ? input.meta : input.control
  if (input.type !== "keyDown" || !mod || input.alt) return undefined
  if (input.code === "Equal" || input.code === "NumpadAdd" || input.key === "+" || input.key === "=") return "in"
  if (input.code === "Minus" || input.code === "NumpadSubtract" || input.key === "-") return "out"
  if (!input.shift && (input.code === "Digit0" || input.code === "Numpad0")) return "reset"
  return undefined
}

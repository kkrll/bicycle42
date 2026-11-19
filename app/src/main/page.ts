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
import { WebContentsView, type BrowserWindow, type IpcMainEvent, type NativeImage } from "electron"
import type { HostMessage, PageMessage } from "../../../overlay/protocol"
import { PHONE, type Device, type Phone, type Rect } from "../shared/types"
import type { Frame } from "./images"

export type PageState = { url: string; loading: boolean; error?: string; canGoBack: boolean; canGoForward: boolean; hmr: boolean }

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
  dispose(): void
}

/** The page with the view it is made of: for whoever made it (the Electron shell, the tests that
 *  drive a real one), not for the controller. */
export type PageView = Page & { readonly view: WebContentsView }

type Options = {
  /** The path of page-preload.cjs: the overlay, and the lookup that runs among the page's own scripts. */
  preload: string
  /** Default "persist:review". */
  partition?: string
  /** overlay → host. */
  onMessage(msg: PageMessage): void
  /** state() changed. */
  onChange(): void
  onShortcut(key: "focus-url" | "toggle-panel" | "focus-chat" | "toggle-review"): void
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

export async function createPage(window: BrowserWindow, opts: Options): Promise<PageView> {
  const { log } = opts
  // The pane the window draws around the page has a 10 px radius and a 1 px border.
  const PAGE_RADIUS = 9
  const view = new WebContentsView({
    webPreferences: {
      partition: opts.partition ?? "persist:review",
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
  view.setBorderRadius(PAGE_RADIUS)
  const wc = view.webContents
  const history = wc.navigationHistory
  window.contentView.addChildView(view)

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
  /** The view's corners: the pane's, or a phone's screen's own at the size it is drawn (inside
   *  the 1px hairline the window draws around it). */
  const shape = () => {
    if (gone()) return
    view.setBorderRadius(device === "phone" ? Math.max(0, Math.round(phone.radius * fit()) - 1) : PAGE_RADIUS)
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
  wc.on("did-navigate", () => {
    committed = true
    if (device === "phone") emulate()
  })

  // ── overlay → main: window.__review in the preload's world, over IPC ─────────────────────────
  // The preload runs in the top frame only, and the placeholder gets no overlay (page-preload.ts).
  wc.ipc.on(FROM_OVERLAY, (event: IpcMainEvent, payload: unknown) => {
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
  })
  // A preload that fails (a missing file, an error in it) leaves the page without the overlay.
  wc.on("preload-error", (_event, file, err) => {
    overlayError = `Review overlay unavailable: ${String(err)}`
    log("error", "page: the overlay's preload failed, pages load without it", { file, error: String(err) })
    opts.onChange()
  })

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
      canGoBack: before !== undefined && !internal(before),
      canGoForward: history.canGoForward(),
      hmr,
    }
  }

  async function probeHmr() {
    if (gone()) return
    const at = wc.getURL()
    const found = internal(at) ? false : !!(await wc.executeJavaScript(HMR_PROBE, false).catch(() => false))
    if (gone() || wc.getURL() !== at || found === hmr) return
    hmr = found
    opts.onChange()
  }

  wc.on("did-start-loading", () => {
    loading = true
    error = undefined
    opts.onChange()
  })
  wc.on("did-stop-loading", () => {
    loading = false
    opts.onChange()
    // Dev clients often attach a moment after load; look twice.
    void probeHmr()
    clearTimeout(probeTimer)
    probeTimer = setTimeout(() => void probeHmr(), 1500)
  })
  wc.on("did-fail-load", (_e, code, desc, failed, isMain) => {
    if (!isMain || code === -3) return // -3: aborted by a newer navigation
    error = `${desc} (${code}) ${failed}`
    opts.onChange()
  })
  wc.on("render-process-gone", (_e, details) => {
    error = `The page crashed (${details.reason}). Reload to try again.`
    log("error", "page: renderer gone", { reason: details.reason, exitCode: details.exitCode, url })
    opts.onChange()
  })
  const navigated = (to: string) => {
    if (!internal(to) && to !== url) {
      url = to
      hmr = false // a different page; did-stop-loading probes again
    }
    opts.onChange() // back/forward may have changed even when the URL didn't
  }
  wc.on("did-navigate", (_e, to) => {
    forgeryLogged = false // a new document (not a hash change, which a page can do in a loop)
    navigated(to)
  })
  wc.on("did-navigate-in-page", (_e, to, isMain) => isMain && navigated(to))
  // One page under review: links that want a new window open here instead.
  wc.setWindowOpenHandler(({ url: to }) => {
    // The page picks this URL, not the reviewer: web pages only, as a browser would allow.
    if (/^https?:/i.test(to)) load(to)
    else log("info", "page: ignored window.open for a non-web URL", { url: to.slice(0, 200) })
    return { action: "deny" }
  })

  wc.on("before-mouse-event", (_event, mouse) => {
    if (mouse.type !== "mouseUp" || mouse.button !== "left") return
    clickAt = Date.now()
    holdForInput()
  })

  // ── keys while the page has focus ────────────────────────────────────────────────────────────
  // mod+U/P/O/I and mod+shift+P (the modes, the brush) are the overlay's own: they reach the page, and it sends "toggle" or "mode".
  wc.on("before-input-event", (event, input) => {
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
  })

  // ── navigation ───────────────────────────────────────────────────────────────────────────────
  function load(to: string) {
    to = to.trim()
    if (to && !/^[a-z][a-z0-9+.-]*:/i.test(to)) to = `http://${to}`
    // Shown at once, before it commits: when the load fails, the URL bar holds what to fix.
    url = to
    hmr = false
    error = undefined
    clearTimeout(reloadTimer)
    navigate(() => {
      wc.loadURL(to || `data:text/html,${encodeURIComponent(EMPTY)}`).catch((err: unknown) => {
        // did-fail-load has usually said it better already; an aborted load is not a failure.
        if (error || (err as { code?: string }).code === "ERR_ABORTED" || gone()) return
        error = String(err)
        opts.onChange()
      })
    })
    opts.onChange()
  }

  function send(msg: HostMessage) {
    if (gone()) return
    // No overlay on the page (placeholder, mid-navigation) is not an error: nothing listens, and
    // the overlay asks for state on "ready".
    try {
      wc.send(TO_OVERLAY, JSON.stringify(msg))
    } catch {}
  }

  /** Asked in the overlay's world of the top frame. False when there is none, or on an error. */
  async function busy(): Promise<boolean> {
    if (gone()) return false
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

  return {
    view,
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
    dispose() {
      disposed = true
      clearTimeout(reloadTimer)
      clearTimeout(probeTimer)
      if (inputHold) clearTimeout(inputHold.timer)
      if (!window.isDestroyed()) window.contentView.removeChildView(view)
      if (!wc.isDestroyed()) wc.close()
    },
  }
}

// The page under review: one WebContentsView inside the app window, with the overlay injected.
//
// The overlay (dist/overlay.js, built from ../../../overlay/src) goes in over CDP before the
// page's own scripts run, and talks back through a CDP binding (window.__review), so it needs
// nothing from the page and survives reloads. This file knows nothing about notes: it hands the overlay's messages to the
// controller and offers load / capture / send.
import { WebContentsView, type BrowserWindow, type NativeImage } from "electron"
import type { Rect } from "../shared/types"

export type PageState = { url: string; loading: boolean; error?: string; canGoBack: boolean; canGoForward: boolean; hmr: boolean }

export type PageMessage = { type: "ready" | "toggle" | "mode" | "draft" | "note" | "pins-placement" | "pin" | "edits-shown"; [k: string]: unknown }

export type Page = {
  readonly view: WebContentsView
  state(): PageState
  /** "" shows the empty placeholder. Adds http:// when there is no scheme. */
  load(url: string): void
  reload(): void
  back(): void
  forward(): void
  /** Where the view sits in the window (CSS px); null hides it. */
  setBounds(bounds: Rect | null): void
  /** host → overlay (window.__b42.receive). */
  send(msg: unknown): void
  capture(): Promise<NativeImage>
  /** Reloads once the reviewer isn't mid-note (overlay busy() is false). No-op when the page hot-reloads itself. */
  reloadWhenIdle(): void
  /** Runs a script in the page and resolves its value; rejects never (resolves undefined on error). */
  evaluate(js: string): Promise<unknown>
  focus(): void
  dispose(): void
}

type Options = {
  /** overlay.js source. */
  overlay: string
  /** Default "persist:review". */
  partition?: string
  /** overlay → host. */
  onMessage(msg: PageMessage): void
  /** state() changed. */
  onChange(): void
  onShortcut(key: "focus-url" | "toggle-panel" | "focus-chat" | "toggle-review"): void
  log(level: "info" | "warn" | "error", msg: string, data?: unknown): void
}

const PAGE_EVENTS = new Set(["ready", "toggle", "mode", "draft", "note", "pins-placement", "pin", "edits-shown"])
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

const EMPTY = `<!doctype html><meta charset=utf-8><style>
html{height:100%;background:#f1eadf;color:#0a0a0a;font:14px/1.5 system-ui,sans-serif}
body{height:100%;margin:0;display:grid;place-items:center}
@media (prefers-color-scheme:dark){html{background:#0a0a0a;color:#f1eadf}}
</style><p>Type your dev URL above.</p>`

/** The placeholder and the blank first page are ours, not the reviewer's: no overlay, no URL to show. */
const internal = (url: string) => /^(data|about):/.test(url)

export async function createPage(window: BrowserWindow, opts: Options): Promise<Page> {
  const { log } = opts
  // The pane the window draws around the page has a 10 px radius and a 1 px border.
  const PAGE_RADIUS = 9
  const view = new WebContentsView({
    webPreferences: {
      partition: opts.partition ?? "persist:review",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Captures and the overlay must keep working while the app window is in the background.
      backgroundThrottling: false,
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
  let attached = false
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

  // ── overlay: in before page scripts, binding back to main. Both survive reloads. ──────────────
  // Top frame of real pages only; iframes and the placeholder get no overlay.
  const inject = `if (window === window.top && !/^(data|about):$/.test(location.protocol)) {\n${opts.overlay}\n}`

  wc.debugger.on("message", (_event, method, params) => {
    if (method !== "Runtime.bindingCalled" || params?.name !== "__review") return
    let msg: unknown
    try {
      msg = JSON.parse(params.payload)
    } catch {
      return // the page itself can call the binding with anything
    }
    if (typeof msg !== "object" || msg === null || !PAGE_EVENTS.has((msg as { type?: unknown }).type as string)) return
    // The binding lives in the page's own world (see attach), so the page's scripts can call it
    // too. A note becomes instructions to a coding agent in the reviewer's name: let one through
    // only when the reviewer just pressed Enter in this view, and only one per Enter. A script
    // can't fake that: before-input-event sees real input, not events the page dispatches.
    // (A page that waits for the reviewer's own Enter can still slip its note in ahead of the
    // real one; closing that needs the isolated world.)
    // A note can also be sent with a button (the note card's ↵, the edit bar's Send): a real click
    // in this view just before counts as the Enter does, once. That is weaker than Enter alone (a
    // page could slip its own note in right after any click of the reviewer's), a trade made
    // knowingly for a button to click.
    if ((msg as PageMessage).type === "note") {
      const real = Date.now() - Math.max(enterAt, clickAt) <= ENTER_WINDOW
      enterAt = clickAt = 0
      if (!real) {
        if (!forgeryLogged) log("warn", "page: dropped a note that no Enter key press or click came with (sent by the page's own script?)", { url })
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
  // Opening devtools on the view takes the debugger away, and so does a renderer crash. Without
  // it the next document gets no overlay, so say so and take it back before the next load.
  wc.debugger.on("detach", (_event, reason) => {
    attached = false
    if (!gone()) log("warn", "page: debugger detached, the overlay returns with the next load", { reason })
  })

  const gone = () => disposed || wc.isDestroyed()

  async function attach(): Promise<void> {
    if (attached || gone()) return
    try {
      wc.debugger.attach("1.3")
      await wc.debugger.sendCommand("Runtime.enable")
      await wc.debugger.sendCommand("Page.enable")
      // This puts __review, and the overlay with it, in the page's main world, where the page's
      // scripts can reach both. The proper fix: run the overlay in an isolated world
      // (Page.addScriptToEvaluateOnNewDocument's worldName + Runtime.addBinding's
      // executionContextName), leaving only the framework component lookup, which has to read
      // the page's own objects, in the main world. Until then the Enter check above guards notes.
      await wc.debugger.sendCommand("Runtime.addBinding", { name: "__review" })
      await wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: inject })
      attached = true
      overlayError = undefined
    } catch (err) {
      // Half-attached is worse than not: the next try would stop at "already attached".
      try {
        wc.debugger.detach()
      } catch {}
      overlayError = `Review overlay unavailable: ${String(err)}`
      log("error", "page: debugger attach failed, pages load without the overlay", { error: String(err) })
    }
  }

  /** Every navigation the app starts goes through here, so a lost debugger is back before the
   *  document that needs the overlay. */
  function navigate(go: () => void) {
    if (gone()) return
    if (attached) return go()
    void attach().then(() => {
      if (gone()) return
      go()
      opts.onChange()
    })
  }

  // A view that never loaded has no renderer, and CDP commands wait for one: load a blank page first.
  await wc.loadURL("about:blank").catch(() => undefined)
  await attach()

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
    if (mouse.type === "mouseUp" && mouse.button === "left") clickAt = Date.now()
  })

  // ── keys while the page has focus ────────────────────────────────────────────────────────────
  // mod+shift+M (review on/off) is the overlay's own: it sends "toggle".
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return
    // Enter sends a note (alt+Enter to the background); remembered for the check in the message handler.
    if (input.key === "Enter") enterAt = Date.now()
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

  function send(msg: unknown) {
    if (gone()) return
    // No overlay on the page (placeholder, mid-navigation) is not an error: it asks for state on "ready".
    const expr = `window.__b42 && window.__b42.receive(${JSON.stringify(JSON.stringify(msg))})`
    wc.executeJavaScript(expr, false).catch(() => undefined)
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
      const busy = await wc.executeJavaScript(BUSY, false).catch(() => false)
      if (gone() || url !== from) return
      if (busy) reloadTimer = setTimeout(() => void tryNow(), BUSY_RETRY)
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
    },
    send,
    capture: () => wc.capturePage(),
    reloadWhenIdle,
    evaluate: (js) => (gone() ? Promise.resolve(undefined) : wc.executeJavaScript(js, false).catch(() => undefined)),
    focus: () => void (gone() || wc.focus()),
    dispose() {
      disposed = true
      clearTimeout(reloadTimer)
      clearTimeout(probeTimer)
      if (!window.isDestroyed()) window.contentView.removeChildView(view)
      if (!wc.isDestroyed()) wc.close()
    },
  }
}

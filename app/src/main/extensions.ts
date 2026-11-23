// Figma's and Paper's own Chrome extensions, run on the page under review: the window's buttons
// beside Draw press their toolbar button. Each copies what the reviewer picks on the page to the
// clipboard in its editor's format (Paper's: no account; Figma's: after a sign-in with Figma, in
// a window of the extension's), to paste there.
//
// Their code is theirs, so it is not shipped with the app: the first press of a button downloads
// that extension from the Chrome Web Store (Google's address Chrome itself updates from), checks
// its developer's signature (crx.ts) and keeps it in the app's data folder. It is loaded into the
// page's session at that press, and into each session the page moves to after (each computer's
// sites have their own, core.ts partitionOf) at its next press there.
//
// Electron runs an extension's scripts, not the browser around them: what the two need of that
// is stood in for by two preloads (ext-worker-preload.ts in their background workers,
// ext-page-preload.ts in the windows they open) and answered here. A tab is a web contents: the
// page's view, or a window opened for the extension (Figma's sign-in).
import { BrowserWindow, clipboard, ClipboardItem, ipcMain, net, type Session, type WebContents } from "electron"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CaptureKind } from "../shared/types"
import { openCrx, unpackCrx } from "./crx"
import { allowPermission, disallowPermission } from "./page"

/** The store's ids: what the store, Chrome, and their sign-in addresses know them by. */
export const EXTENSION_IDS: Record<CaptureKind, string> = {
  figma: "fkmaohpngenfoccdgceedjkfhkdcohmg",
  paper: "lidfahaahiogmnlccifabccgplofocck",
}

type Options = {
  /** Where the extensions are kept: one folder each, by kind. */
  folder: string
  /** The two preloads' built files. */
  workerPreload: string
  pagePreload: string
  /** The page's web contents now (it changes when the page moves to another session), and the window it is in. */
  page(): WebContents | undefined
  window(): BrowserWindow | undefined
  /** The extension's file, downloaded. Tests give their own. */
  download?(id: string): Promise<Buffer>
  /** Other ids than the store's (tests: extensions signed with a key of their own). */
  ids?: Partial<Record<CaptureKind, string>>
  log(level: "info" | "warn" | "error", msg: string, data?: unknown): void
}

export type Extensions = {
  /** The kind's button pressed: its extension made ready (downloaded the first time) and its
   *  toolbar button pressed on the page. Rejects with a sentence for the person. */
  press(kind: CaptureKind): Promise<void>
  /** The kind's extension taken out of every session it was loaded into, and its windows closed:
   *  it stops running. Its folder stays, so the next press loads it without a download. */
  unload(kind: CaptureKind): void
  dispose(): void
}

/** The store's file of an extension, as Chrome asks for it: the newest version for this Chromium. */
export async function fromStore(id: string): Promise<Buffer> {
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.versions.chrome}&acceptformat=crx3&x=${encodeURIComponent(`id=${id}&installsource=ondemand&uc`)}`
  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`The Chrome Web Store did not give the extension (${res.status}).`)
  return Buffer.from(await res.arrayBuffer())
}

export function createExtensions(opts: Options): Extensions {
  const { log } = opts
  const download = opts.download ?? fromStore
  const ids: Record<CaptureKind, string> = { ...EXTENSION_IDS, ...opts.ids }
  const KIND_OF_ID = new Map(Object.entries(ids).map(([k, id]) => [id, k as CaptureKind]))
  /** Each kind's folder, once it is there: one download at a time each. */
  const ready = new Map<CaptureKind, Promise<string>>()
  /** Each session's extensions, loaded (by kind): the id Electron gave it. */
  const loaded = new Map<Session, Map<CaptureKind, Promise<string>>>()
  /** The windows opened as an extension's tabs, by their web contents' id, and whose they are. */
  const tabs = new Map<number, BrowserWindow>()
  const tabKind = new Map<number, CaptureKind>()
  /** Page views told about already (navigations, closing). */
  const watched = new WeakSet<WebContents>()
  const workers = new WeakSet<Electron.ServiceWorkerMain>()

  function install(kind: CaptureKind): Promise<string> {
    let p = ready.get(kind)
    if (!p) {
      p = (async () => {
        const folder = path.join(opts.folder, kind)
        if (fs.existsSync(path.join(folder, "manifest.json"))) return folder
        const id = ids[kind]
        log("info", `extensions: downloading ${kind}'s from the Chrome Web Store`)
        const crx = openCrx(await download(id), id)
        const version = unpackCrx(crx, folder)
        log("info", `extensions: ${kind}'s is here, version ${version}`)
        return folder
      })()
      ready.set(kind, p)
      // A failed one is tried again at the next press.
      p.catch(() => ready.delete(kind))
    }
    return p
  }

  /** A tab, as chrome.tabs says one: the page's view, or a window of the extension's. */
  function tabInfo(wc: WebContents) {
    const win = BrowserWindow.fromWebContents(wc) ?? opts.window()
    return {
      id: wc.id,
      windowId: win?.id ?? -1,
      url: wc.getURL(),
      title: wc.getTitle(),
      status: wc.isLoading() ? "loading" : "complete",
      active: true,
      highlighted: true,
      index: 0,
      pinned: false,
      incognito: false,
      discarded: false,
      autoDiscardable: false,
      groupId: -1,
    }
  }
  const contentsOf = (id: unknown) => {
    const page = opts.page()
    if (page && !page.isDestroyed() && page.id === id) return page
    const win = typeof id === "number" ? tabs.get(id) : undefined
    return win && !win.isDestroyed() ? win.webContents : undefined
  }

  /** The extension's background worker, running: the one that is, else the one starting (an
   *  extension just loaded starts its own, and asking for another then aborts its registration),
   *  else one started. */
  async function workerOf(session: Session, id: string): Promise<Electron.ServiceWorkerMain> {
    const scope = `chrome-extension://${id}/`
    const sw = session.serviceWorkers
    for (const [versionId, info] of Object.entries(sw.getAllRunning())) {
      if (info.scope !== scope) continue
      const worker = sw.getWorkerFromVersionID(Number(versionId))
      if (worker && !worker.isDestroyed()) return worker
    }
    const started = await new Promise<Electron.ServiceWorkerMain | undefined>((resolve) => {
      const timer = setTimeout(() => (sw.off("running-status-changed", on), resolve(undefined)), 1500)
      function on({ versionId, runningStatus }: { versionId: number; runningStatus: string }) {
        if (runningStatus !== "running") return
        const worker = sw.getWorkerFromVersionID(versionId)
        if (worker?.scope !== scope) return
        clearTimeout(timer)
        sw.off("running-status-changed", on)
        resolve(worker)
      }
      sw.on("running-status-changed", on)
    })
    return started ?? (await sw.startWorkerForScope(scope))
  }

  /** `path` fired in every running worker of the session's extensions (and started for those
   *  that are not: Chrome wakes a worker for its events). */
  async function fire(session: Session, p: string, ...args: unknown[]) {
    for (const id of (await Promise.all([...(loaded.get(session)?.values() ?? [])].map((x) => x.catch(() => undefined)))).filter(Boolean)) {
      try {
        const worker = await workerOf(session, id as string)
        attach(worker)
        worker.send("b42-ext:fire", p, args)
      } catch (e) {
        log("warn", `extensions: ${p} not told to ${id}`, String(e))
      }
    }
  }

  /** A window for an extension's tab (Figma's sign-in screen, and figma.com's sign-in it goes
   *  to): in the page's session, where the extension is and its sign-in is kept. */
  function openTab(session: Session, url: string, kind: CaptureKind | undefined) {
    const parent = opts.window()
    const win = new BrowserWindow({
      width: 960,
      height: 760,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      autoHideMenuBar: true,
      webPreferences: { session, preload: opts.pagePreload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    const wc = win.webContents
    const id = wc.id
    tabs.set(id, win)
    if (kind) tabKind.set(id, kind)
    // A sign-in comes back to https://<id>.chromiumapp.org/…, which is no site: Chrome hands that
    // address to the extension that watches for it (tabs.onUpdated), and so is it here.
    const back = (event: Electron.Event, to: string) => {
      if (!/^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(to)) return
      event.preventDefault()
      void fire(session, "tabs.onUpdated", id, { url: to }, { ...tabInfo(wc), url: to })
    }
    wc.on("will-redirect", back)
    wc.on("will-navigate", back)
    wc.on("did-navigate", (_e, to) => void fire(session, "tabs.onUpdated", id, { status: "loading", url: to }, tabInfo(wc)))
    wc.on("did-finish-load", () => void fire(session, "tabs.onUpdated", id, { status: "complete" }, tabInfo(wc)))
    // Only web pages and the extensions' own; a site's popup (a single sign-on's) opens as a window of its own.
    wc.setWindowOpenHandler(({ url: to }) => (/^https:/i.test(to) ? { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true } } : { action: "deny" }))
    wc.on("will-navigate", (event, to) => {
      if (!/^(https?|chrome-extension):/i.test(to)) event.preventDefault()
    })
    win.on("closed", () => {
      tabs.delete(id)
      tabKind.delete(id)
      void fire(session, "tabs.onRemoved", id, { windowId: -1, isWindowClosing: true })
    })
    void win.loadURL(url)
    return wc
  }

  /** The worker's calls (ext-worker-preload.ts), answered once per worker that runs. */
  function attach(worker: Electron.ServiceWorkerMain | undefined) {
    if (!worker || workers.has(worker)) return
    workers.add(worker)
    const kind = KIND_OF_ID.get(new URL(worker.scope).host)
    worker.ipc.on("b42-ext:log", (_e, msg: string) => log("info", `extensions: ${kind ?? worker.scope}: ${msg}`))
    worker.ipc.handle("b42-ext:call", async (_e, name: string, ...args: unknown[]) => {
      const session = opts.page()?.session
      switch (name) {
        case "clipboard.html":
          await clipboard.write([new ClipboardItem({ "text/html": String(args[0]) })])
          return { status: "success" }
        case "windows.getCurrent": {
          const win = opts.window()
          return { id: win?.id ?? -1, focused: !!win?.isFocused(), type: "normal", state: "normal", incognito: false, alwaysOnTop: false }
        }
        case "tabs.create": {
          const url = (args[0] as { url?: unknown } | undefined)?.url
          if (typeof url !== "string" || !session) throw new Error("No tab can be opened.")
          // Its own pages (a path is one of them), or a web page; nothing else.
          const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : new URL(url, worker.scope).href
          if (!/^https:/i.test(full) && !full.startsWith(worker.scope)) throw new Error("Not an address a tab opens.")
          return tabInfo(openTab(session, full, kind))
        }
        case "tabs.remove": {
          const ids = Array.isArray(args[0]) ? args[0] : [args[0]]
          for (const id of ids) if (typeof id === "number") tabs.get(id)?.destroy()
          return
        }
        case "tabs.captureVisibleTab": {
          const page = opts.page()
          if (!page || page.isDestroyed()) throw new Error("No page.")
          return (await page.capturePage()).toDataURL()
        }
        case "pageCapture.saveAsMHTML": {
          const wc = contentsOf(args[0])
          if (!wc) throw new Error("No such tab.")
          const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b42-mhtml-")), "page.mhtml")
          try {
            await wc.savePage(file, "MHTML")
            return fs.readFileSync(file).toString("base64")
          } finally {
            fs.rmSync(path.dirname(file), { recursive: true, force: true })
          }
        }
      }
      throw new Error(`chrome.${name} is not stood in for.`)
    })
  }

  /** The session's extension of this kind, loaded (and its preload with it, once per session). */
  function load(session: Session, kind: CaptureKind): Promise<string> {
    let mine = loaded.get(session)
    if (!mine) {
      mine = new Map()
      loaded.set(session, mine)
      session.registerPreloadScript({ type: "service-worker", id: "b42-extensions", filePath: opts.workerPreload })
      session.serviceWorkers.on("running-status-changed", ({ versionId }) => attach(session.serviceWorkers.getWorkerFromVersionID(versionId)))
    }
    let p = mine.get(kind)
    if (!p) {
      p = (async () => {
        const folder = await install(kind)
        const ext = session.extensions.getExtension(ids[kind]) ?? (await session.extensions.loadExtension(folder))
        if (kind === "figma") allowPermission(session, "clipboard-sanitized-write")
        return ext.id
      })()
      mine.set(kind, p)
      p.catch(() => mine.delete(kind))
    }
    return p
  }

  /** The page's view, told to the session's extensions as Chrome tells a tab's: Figma's puts its
   *  toolbar back on the page after a load. */
  function watch(page: WebContents) {
    if (watched.has(page)) return
    watched.add(page)
    const session = page.session
    page.on("did-navigate", (_e, to) => void fire(session, "tabs.onUpdated", page.id, { status: "loading", url: to }, tabInfo(page)))
    page.on("did-finish-load", () => void fire(session, "tabs.onUpdated", page.id, { status: "complete" }, tabInfo(page)))
    page.once("destroyed", () => void fire(session, "tabs.onRemoved", page.id, { windowId: -1, isWindowClosing: false }))
  }

  // An extension's own page asking (ext-page-preload.ts): only from a window opened for one, and
  // only from an extension's page there.
  ipcMain.handle("b42-ext:page-call", async (event, name: string, ...args: unknown[]) => {
    const win = tabs.get(event.sender.id)
    const from = event.senderFrame?.url ?? ""
    if (!win || !from.startsWith("chrome-extension://") || !KIND_OF_ID.has(new URL(from).host)) throw new Error("Not an extension's page.")
    const session = event.sender.session
    switch (name) {
      case "tabs.getCurrent":
        return tabInfo(event.sender)
      case "tabs.remove": {
        const ids = Array.isArray(args[0]) ? args[0] : [args[0]]
        for (const id of ids) if (typeof id === "number") tabs.get(id)?.destroy()
        return
      }
      case "tabs.create": {
        const url = (args[0] as { url?: unknown } | undefined)?.url
        if (typeof url !== "string" || !/^(https:|chrome-extension:)/i.test(url)) throw new Error("Not an address a tab opens.")
        return tabInfo(openTab(session, url, tabKind.get(event.sender.id)))
      }
    }
    throw new Error(`chrome.${name} is not stood in for.`)
  })

  return {
    async press(kind) {
      const page = opts.page()
      if (!page || page.isDestroyed() || !/^https?:/i.test(page.getURL())) throw new Error("Open a page first.")
      const session = page.session
      let id: string
      try {
        id = await load(session, kind)
      } catch (e) {
        log("warn", `extensions: ${kind}'s not ready`, String(e))
        const why = e instanceof Error ? e.message : String(e)
        throw new Error(`${kind === "figma" ? "Figma" : "Paper"}'s extension could not be set up: ${why}`)
      }
      watch(page)
      // The press was in the window: the page takes the keyboard, as the click after it would
      // give it (Paper's asks for a click to start when its page has no focus).
      page.focus()
      const worker = await workerOf(session, id)
      attach(worker)
      worker.send("b42-ext:fire", "action.onClicked", [tabInfo(page)])
    },
    unload(kind) {
      for (const [session, mine] of loaded) {
        const p = mine.get(kind)
        if (!p) continue
        mine.delete(kind)
        // Once it is in (a press may still be loading it): out again, and what it was granted with it.
        void p.then(
          (id) => {
            if (session.extensions.getExtension(id)) session.extensions.removeExtension(id)
            if (kind === "figma") disallowPermission(session, "clipboard-sanitized-write")
          },
          () => undefined,
        )
      }
      for (const [id, k] of tabKind) if (k === kind) tabs.get(id)?.destroy()
    },
    dispose() {
      ipcMain.removeHandler("b42-ext:page-call")
      for (const win of tabs.values()) if (!win.isDestroyed()) win.destroy()
      tabs.clear()
    },
  }
}

// Runs before the background worker of each extension the app loads into the page's session
// (main/extensions.ts: Figma's and Paper's). Electron runs a Chrome extension's scripts but has
// no browser around them: no toolbar, no tabs it opens, no menus, no prompts. What of that the two
// use is stood in for here, in the worker's own world, before its script runs, and anything that
// needs the app is asked of main over IPC ("b42-ext:call").
//
// What Electron has already is left as it is. Its namespaces for the toolbar button
// (chrome.action) and for keys (chrome.commands) exist but never fire, so their events are
// listened to here as well, and main fires them ("b42-ext:fire") when the window's button is pressed.
import { contextBridge, ipcRenderer } from "electron"

const bridge = {
  log: (msg: string) => ipcRenderer.send("b42-ext:log", String(msg)),
  call: (name: string, ...args: unknown[]) => ipcRenderer.invoke("b42-ext:call", name, ...args),
}

contextBridge.executeInMainWorld({
  args: [bridge],
  func: (b: typeof bridge) => {
    type Listener = (...args: unknown[]) => unknown
    type Ev = { addListener(f: Listener): void; removeListener(f: Listener): void; hasListener(f: Listener): boolean; hasListeners(): boolean; fire(...args: unknown[]): void }
    const g = globalThis as unknown as { chrome: Record<string, Record<string, unknown>>; __b42ext?: { fire(path: string, args: unknown[]): void }; Blob: typeof Blob }
    const c = g.chrome
    const ev = (): Ev => {
      const ls: Listener[] = []
      return {
        addListener: (f) => void ls.push(f),
        removeListener: (f) => {
          const i = ls.indexOf(f)
          if (i >= 0) ls.splice(i, 1)
        },
        hasListener: (f) => ls.includes(f),
        hasListeners: () => ls.length > 0,
        fire: (...args) => {
          for (const f of [...ls])
            try {
              const r = f(...args) as { catch?: (h: (e: unknown) => void) => void } | undefined
              r?.catch?.((e) => b.log(`a listener failed: ${e}`))
            } catch (e) {
              b.log(`a listener failed: ${e}`)
            }
        },
      }
    }
    const later = async () => {}
    /** What Electron lacks of `ns`, added; what it has, kept. */
    const fill = (ns: string, members: Record<string, unknown>) => {
      const has = (c[ns] ??= {})
      for (const [k, v] of Object.entries(members))
        if (!(k in has))
          try {
            has[k] = v
          } catch {
            b.log(`chrome.${ns}.${k} could not be stood in for`)
          }
    }

    fill("action", { enable: later, disable: later, setPopup: later, openPopup: later, setIcon: later, setTitle: later, setBadgeText: later, setBadgeBackgroundColor: later })
    fill("contextMenus", { create: (_p: unknown, done?: () => void) => done?.(), update: later, remove: later, removeAll: (done?: () => void) => done?.() })
    fill("commands", { getAll: async () => [] })
    // The host access the extension asks for is in its manifest already (crx.ts, fitManifest).
    fill("permissions", { contains: async () => true, request: async () => true, getAll: async () => ({ permissions: [], origins: ["<all_urls>"] }), onAdded: ev(), onRemoved: ev() })
    // A sign-in comes back to this address; main watches the window it opened for it (tabs.create).
    fill("identity", { getRedirectURL: (p = "") => `https://${c.runtime!.id as string}.chromiumapp.org/${p}` })
    fill("windows", { update: later, getCurrent: async () => b.call("windows.getCurrent"), get: async () => b.call("windows.getCurrent") })
    fill("tabs", {
      create: (p: unknown) => b.call("tabs.create", p),
      remove: (id: unknown) => b.call("tabs.remove", id),
      captureVisibleTab: (...a: unknown[]) => b.call("tabs.captureVisibleTab", ...a.filter((x) => typeof x !== "function")),
      onActivated: ev(),
    })
    fill("pageCapture", {
      saveAsMHTML: async (p: { tabId: number }) => {
        const base64 = (await b.call("pageCapture.saveAsMHTML", p.tabId)) as string | undefined
        if (!base64) return undefined
        const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
        return new g.Blob([bytes], { type: "multipart/related" })
      },
    })
    // Paper writes the clipboard from an offscreen page, which Electron makes but where the copy
    // is refused (no focus): the HTML it sends there is written by main instead.
    const runtime = c.runtime as Record<string, unknown> & { sendMessage(...a: unknown[]): Promise<unknown> }
    if (!("getContexts" in runtime)) runtime.getContexts = async () => [{ contextType: "OFFSCREEN_DOCUMENT" }]
    const send = runtime.sendMessage.bind(runtime)
    runtime.sendMessage = (...a: unknown[]) => {
      const m = a.find((x) => x && typeof x === "object") as { target?: unknown; html?: unknown } | undefined
      if (m?.target === "offscreen-clipboard" && typeof m.html === "string") return b.call("clipboard.html", m.html)
      return send(...a)
    }

    // The events main fires: each listened to here, and still handed on to Electron's own.
    const fired: Record<string, Ev> = {}
    for (const p of ["action.onClicked", "commands.onCommand", "tabs.onUpdated", "tabs.onRemoved", "contextMenus.onClicked"]) {
      const [ns, name] = p.split(".") as [string, string]
      const own = (c[ns] ??= {})[name] as { addListener?: (f: Listener) => void } | undefined
      const mine = ev()
      fired[p] = mine
      if (own?.addListener) {
        const add = own.addListener.bind(own)
        own.addListener = (f: Listener) => {
          mine.addListener(f)
          try {
            add(f)
          } catch {}
        }
      } else c[ns]![name] = mine
    }
    g.__b42ext = { fire: (p, args) => fired[p]?.fire(...args) }
  },
})

ipcRenderer.on("b42-ext:fire", (_event, p: string, args: unknown[]) => {
  contextBridge.executeInMainWorld({ func: (p: string, args: unknown[]) => (globalThis as unknown as { __b42ext?: { fire(p: string, a: unknown[]): void } }).__b42ext?.fire(p, args), args: [p, args] })
})

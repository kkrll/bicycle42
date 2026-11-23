// Runs in the windows the app opens when an extension asks for a tab (main/extensions.ts): its own
// pages (Figma's sign-in screen, options.html) and the sites they go to (figma.com's sign-in). In
// an extension's own page it stands in for what Electron lacks of chrome.*, as the worker's
// preload does (ext-worker-preload.ts); anywhere else it does nothing.
import { contextBridge, ipcRenderer, webFrame } from "electron"

if (location.protocol === "chrome-extension:") {
  contextBridge.exposeInMainWorld("__b42ExtBridge", {
    call: (name: string, ...args: unknown[]) => ipcRenderer.invoke("b42-ext:page-call", name, ...args),
  })
  void webFrame.executeJavaScript(`(() => {
    const b = window.__b42ExtBridge
    delete window.__b42ExtBridge
    const c = window.chrome
    const ev = () => { const ls = []; return { addListener: (f) => ls.push(f), removeListener: (f) => { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1) }, hasListener: (f) => ls.includes(f) } }
    const fill = (ns, members) => { const has = (c[ns] ??= {}); for (const [k, v] of Object.entries(members)) if (!(k in has)) has[k] = v }
    fill("permissions", { contains: async () => true, request: async () => true, onAdded: ev(), onRemoved: ev() })
    fill("tabs", { create: (p) => b.call("tabs.create", p), remove: (id) => b.call("tabs.remove", id), getCurrent: () => b.call("tabs.getCurrent") })
    fill("extension", { isAllowedFileSchemeAccess: async () => false })
  })()`)
}

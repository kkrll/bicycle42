// The only door between the app window and main. The window gets `window.b42` (see Bridge in
// shared/types.ts) and nothing else: no Node, no ipcRenderer, no server password.
import { contextBridge, ipcRenderer } from "electron"
import type { AppState, Bridge, ChatEvent, NoteFocus, Shortcut } from "./shared/types"

function subscribe<T>(channel: string, fn: (value: T) => void) {
  const handler = (_event: unknown, value: T) => fn(value)
  ipcRenderer.on(channel, handler)
  return () => void ipcRenderer.removeListener(channel, handler)
}

const bridge: Bridge = {
  // Electron prefixes a rejected invoke with "Error invoking remote method '…': Error: ". The
  // window shows these messages to the user, so only main's own sentence may come through.
  invoke: (name, ...args) =>
    ipcRenderer.invoke("b42:command", name, args).catch((err: unknown) => {
      const text = err instanceof Error ? err.message : String(err)
      throw new Error(text.replace(/^Error invoking remote method '[^']*': (Error: )?/, ""))
    }),
  onState(fn) {
    const off = subscribe<AppState>("b42:state", fn)
    void ipcRenderer.invoke("b42:state").then(fn)
    return off
  },
  onChat(fn) {
    const off = subscribe<ChatEvent>("b42:chat", fn)
    // Main answers with a "reset" holding the open conversation, then live events follow.
    void ipcRenderer.invoke("b42:chat")
    return off
  },
  onShortcut: (fn) => subscribe<Shortcut>("b42:shortcut", fn),
  onNoteFocus: (fn) => subscribe<NoteFocus>("b42:note", fn),
  platform: process.platform as Bridge["platform"],
}

contextBridge.exposeInMainWorld("b42", bridge)

// Electron, as far as the controller (src/main/index.ts) needs it, for tests that run in plain
// Node. The window records what it is sent; `ipcMain.handle` handlers are callable by channel.
type Handler = (event: unknown, ...args: unknown[]) => unknown

export const stub = {
  handlers: {} as Record<string, Handler>,
  /** [channel, value] for everything main sent to the window. */
  sent: [] as [string, unknown][],
  dialogs: [] as unknown[],
}
;(globalThis as Record<string, unknown>).__electronStub = stub

export class BrowserWindow {
  webContents = {
    send: (channel: string, value: unknown) => void stub.sent.push([channel, value]),
    on() {},
    setWindowOpenHandler() {},
    openDevTools() {},
    focus() {},
  }
  once() {}
  on() {}
  isDestroyed() {
    return false
  }
  async loadFile() {}
  isMinimized() {
    return false
  }
  focus() {}
  show() {}
}

export const app = {
  setPath() {},
  getPath: () => process.env.BICYCLE42_DATA!,
  requestSingleInstanceLock: () => true,
  on() {},
  whenReady: () => Promise.resolve(),
  quit() {},
}
export const ipcMain = { handle: (channel: string, fn: Handler) => void (stub.handlers[channel] = fn) }
export const Menu = { setApplicationMenu() {}, buildFromTemplate: () => ({}) }
export const nativeTheme = { shouldUseDarkColors: false }
export const safeStorage = { isEncryptionAvailable: () => false }
export const shell = { openExternal() {} }
export const dialog = { showMessageBox: async (_window: unknown, options: unknown) => void stub.dialogs.push(options) }

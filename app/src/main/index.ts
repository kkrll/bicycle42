// bicycle 42, main process: the Electron shell around the controller.
//
// The controller (core.ts) owns the app's state and knows nothing of Electron. This file is what
// it runs in here: the window and its menu, the page's view (page.ts), the keychain, the three
// IPC channels of the window's bridge (preload.ts), the address the conversation's pictures are
// served at, and the app's start and quit. It keeps no state of the app's own.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, safeStorage, shell } from "electron"
import fs from "node:fs"
import path from "node:path"
import type { Shortcut } from "../shared/types"
import { createCore } from "./core"
import { createPage, type PageView } from "./page"
import { SCHEME } from "./pictures"

type Level = "info" | "warn" | "error"
const log = (level: Level, msg: string, data?: unknown) =>
  console[level === "info" ? "log" : level](`[bicycle42] ${msg}`, data === undefined ? "" : data)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Tests point the app at a scratch profile. Otherwise the folder is named here, so the packaged
// app ("bicycle 42") and a run from source keep their settings and notes in the same place.
app.setPath("userData", process.env.BICYCLE42_DATA || path.join(app.getPath("appData"), "bicycle42"))

// The conversation's pictures have an address of their own (pictures.ts), in the app window's
// session only: the page's session does not know the scheme.
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])

let window: BrowserWindow | undefined
/** The window's web contents, kept while it closes too (its last calls still come). */
let windowContents: Electron.WebContents | undefined
let page: PageView | undefined

const core = createCore({
  dataDir: app.getPath("userData"),
  secrets: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (secret) => safeStorage.encryptString(secret),
    decrypt: (sealed) => safeStorage.decryptString(sealed),
  },
  emit(stream, value) {
    if (window && !window.isDestroyed()) window.webContents.send(`b42:${stream}`, value)
  },
  dialog(box) {
    if (window) void dialog.showMessageBox(window, box)
  },
  log,
})

// ── window ──────────────────────────────────────────────────────────────────────────────────────

function menu() {
  const mac = process.platform === "darwin"
  // No "Reload" item: ⌘R belongs to the page under review, not to the app window.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac ? [{ role: "appMenu" as const }] : []),
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "togglefullscreen" },
          { type: "separator" },
          { label: "Developer Tools: App", accelerator: "Alt+CmdOrCtrl+I", click: () => window?.webContents.openDevTools({ mode: "detach" }) },
          { label: "Developer Tools: Page", accelerator: "Alt+CmdOrCtrl+J", click: () => page?.openDevTools() },
        ],
      },
      { role: "windowMenu" },
    ]),
  )
}

/** The app icon, copied beside the bundle by scripts/build.mjs. Absent in a build without assets. */
const iconFile = path.join(__dirname, "icon.png")
const appIcon = fs.existsSync(iconFile) ? iconFile : undefined

async function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  const win = (window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "bicycle 42",
    ...(appIcon ? { icon: appIcon } : {}),
    // The design system's paper and near-black, so the window doesn't flash before the UI paints.
    backgroundColor: dark ? "#0a0a0a" : "#f1eadf",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  }))
  // The app window shows only the app. Links go to the system browser.
  win.webContents.on("will-navigate", (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  windowContents = win.webContents
  win.once("ready-to-show", () => win.show())
  win.on("closed", () => {
    page?.dispose()
    page = undefined
    core.detach()
    window = undefined
  })

  page = await createPage(win, {
    preload: path.join(__dirname, "page-preload.cjs"),
    ...core.pageEvents,
    onShortcut(key) {
      if (key === "toggle-review") return void core.commands.toggleReview()
      const shortcut: Shortcut = key
      win.webContents.send("b42:shortcut", shortcut)
      // The keys were pressed in the page; the field they lead to is in the window.
      win.webContents.focus()
    },
    log,
  })
  core.attach(page)
  // The page starts loading with the window, not after it: by the time the window can show it,
  // it is there. Until the window says where the page is (setPageBounds) it stays hidden, since
  // the window may open on a dialog or with a panel of another width; it is only given the size
  // it last had, so it is laid out once. What its loading sends to the window before that can
  // listen, the window asks for when it does ("b42:state", "b42:chat").
  const last = core.lastPageBounds()
  if (last) page.setBounds(last)
  page.setBounds(null)
  page.load(core.lastUrl())
  await win.loadFile(path.join(__dirname, "renderer/index.html"))
}

// The window's bridge (preload.ts): its state, the open conversation, its commands. Only the app's
// own window may ask: a command can start a program (connectAgent), and the page under review
// is another web contents with its own channels.
const fromWindow = (event: Electron.IpcMainInvokeEvent) => {
  if (!windowContents || event.sender !== windowContents || event.senderFrame !== event.sender.mainFrame) throw new Error("Not from the app's window.")
}
ipcMain.handle("b42:state", (event) => (fromWindow(event), core.snapshot()))
ipcMain.handle("b42:chat", (event) => (fromWindow(event), core.chat()))
// (Electron wraps a thrown Error in "Error invoking remote method …"; preload.ts takes that off.)
ipcMain.handle("b42:command", (event, name: string, args: unknown) => (fromWindow(event), core.invoke(name, args)))

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on("window-all-closed", () => app.quit())
  // What a note sends, and its pictures, are written in the background: the quit waits for them
  // (3 s at most), so a note made just before it is still sent after the restart.
  let written = false
  app.on("before-quit", (event?: Electron.Event) => {
    const writes = core.dispose()
    // (The tests emit before-quit by itself, with no event, for the flush alone.)
    if (written || !event) return
    event.preventDefault()
    void Promise.race([writes, sleep(3000)]).finally(() => {
      written = true
      app.quit()
    })
  })
  void app.whenReady().then(async () => {
    protocol.handle(SCHEME, (request) => core.picture(request.url))
    menu()
    // From source on macOS the dock would show Electron's own icon.
    if (appIcon && process.platform === "darwin") app.dock?.setIcon(appIcon)
    await createWindow()
    core.start()
  })
}

/** For the end-to-end test only: a way to look inside without a second IPC surface. */
if (process.env.BICYCLE42_TEST) {
  ;(globalThis as Record<string, unknown>).__b42Test = {
    window: () => window,
    page: () => page,
    snapshot: core.snapshot,
  }
}

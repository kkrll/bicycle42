// bicycle 42, main process: the Electron shell around the controller.
//
// The controller (core.ts) owns the app's state and knows nothing of Electron. This file is what
// it runs in here: the window and its menu, the page's view (page.ts), the three
// IPC channels of the window's bridge (preload.ts), the address the conversation's pictures are
// served at, and the app's start and quit. It keeps no state of the app's own.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, protocol, shell } from "electron"
import fs from "node:fs"
import path from "node:path"
import type { Shortcut } from "../shared/types"
import { timing as acpTiming, type Transport } from "./acp"
import { createCore } from "./core"
import { createPage, holdDownloadsIn, type PageView } from "./page"
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

/** The end-to-end test's agent, in this process (test/app.e2e.ts sets it before loading the app). */
const testAgent = process.env.BICYCLE42_TEST ? ((globalThis as Record<string, unknown>).__b42Agent as ((command: string[]) => Transport) | undefined) : undefined
/** …and its Save dialog, asked at each one (the test changes its answer): the file it answers
 *  for a name, or undefined (cancelled). */
const testSaveAs = () => (process.env.BICYCLE42_TEST ? ((globalThis as Record<string, unknown>).__b42SaveAs as ((name: string) => Promise<string | undefined>) | undefined) : undefined)
/** Where a download the page started is held until the reviewer answers (page.ts): the app's
 *  own folder, emptied at every start of what an earlier run left there. */
const heldDownloads = path.join(app.getPath("userData"), "Held downloads")
/** The reviewer's Downloads folder, where the Save dialog opens, taken before the app's
 *  "downloads" path is made the held folder (holdDownloadsIn). The end-to-end test's is one in
 *  its profile, so nothing of a test run is ever in the real one. */
const theirDownloads = process.env.BICYCLE42_TEST ? path.join(app.getPath("userData"), "Downloads") : app.getPath("downloads")

const core = createCore({
  dataDir: app.getPath("userData"),
  emit(stream, value) {
    if (window && !window.isDestroyed()) window.webContents.send(`b42:${stream}`, value)
  },
  dialog(box) {
    if (window) void dialog.showMessageBox(window, box)
  },
  async saveDialog(name) {
    const stand = testSaveAs()
    if (stand) return stand(name)
    if (!window) return undefined
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      defaultPath: path.join(theirDownloads, name),
      properties: ["createDirectory", "showOverwriteConfirmation"],
    })
    return canceled || !filePath ? undefined : filePath
  },
  ...(testAgent ? { agentTransport: testAgent } : {}),
  log,
})

// ── window ──────────────────────────────────────────────────────────────────────────────────────

function menu() {
  const mac = process.platform === "darwin"
  /** A command of the app's, with the key it already has shown beside it. The key itself is
   *  handled where it always was (the window, the page's view, the overlay), never here: the
   *  accelerator is not registered (Linux, Windows), and a press of it that reaches the menu
   *  anyway (macOS) is left alone, so nothing happens twice. The menu acts on a click. */
  const item = (label: string, accelerator: string | undefined, run: () => void): Electron.MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
    click: (_item, _window, event) => {
      if (!event?.triggeredByAccelerator) run()
    },
  })
  /** What the window does itself (its fields, its panel, its sheet): as its keys say it. */
  const toWindow = (shortcut: Shortcut) => () => {
    if (!window || window.isDestroyed()) return
    window.webContents.send("b42:shortcut", shortcut)
    window.webContents.focus()
  }
  const run = (name: string, ...args: unknown[]) => () => void core.invoke(name, args).catch(() => {})
  // No "Reload" item for the window: ⌘R belongs to the page under review, not to the app window.
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
      // The app's own commands, each with the key it has (README, Keys).
      {
        label: "Review",
        submenu: [
          item("Preview", "CmdOrCtrl+U", run("setMode", "preview")),
          item("Annotate", "CmdOrCtrl+P", run("setMode", "notes")),
          item("Edit", "CmdOrCtrl+O", run("setMode", "edit")),
          item("Motion", "CmdOrCtrl+I", run("setMode", "motion")),
          item("Draw", "CmdOrCtrl+Shift+P", run("toggleBrush")),
          { type: "separator" },
          item("Reload the Page", "CmdOrCtrl+R", run("reload")),
          item("Copy the Page's Address", "CmdOrCtrl+Shift+C", copyPageUrl),
          item("Go to the Address", "CmdOrCtrl+L", toWindow("focus-url")),
          { type: "separator" },
          item("Show or Hide Notes and Conversation", "CmdOrCtrl+J", toWindow("toggle-panel")),
          item("Go to the Message Box", "CmdOrCtrl+K", toWindow("focus-chat")),
          item("New Conversation", undefined, run("newSession")),
          item("Stop the Agent", undefined, toWindow("stop")),
        ],
      },
      { role: "windowMenu" },
      { role: "help", submenu: [item("Keyboard Shortcuts", "Shift+/", toWindow("show-keys"))] },
    ]),
  )
}

/** The page's whole address on the clipboard, written here (the window may not have the focus a
 *  copy of its own needs), and the window told, to say so. */
function copyPageUrl() {
  const url = page?.state().url
  if (!url || !window || window.isDestroyed()) return
  clipboard.writeText(url)
  window.webContents.send("b42:shortcut", "url-copied" satisfies Shortcut)
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
    // The session of the saved agent's computer's sites: the page loads in it before the agent is back.
    partition: core.partition(),
    onMessage: core.pageEvents.onMessage,
    onChange: core.pageEvents.onChange,
    downloads: { folder: heldDownloads, ask: core.pageEvents.onDownload, gone: core.pageEvents.onDownloadGone },
    onShortcut(key) {
      if (key === "toggle-review") return void core.commands.toggleReview()
      // Copied here, and the keyboard left in the page: copying is no reason to leave it.
      if (key === "copy-url") return copyPageUrl()
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
    // Downloads held when the app last ended, never answered: nothing of them is kept.
    await fs.promises.rm(heldDownloads, { recursive: true, force: true }).catch(() => {})
    holdDownloadsIn(heldDownloads)
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
    acpTiming,
  }
}

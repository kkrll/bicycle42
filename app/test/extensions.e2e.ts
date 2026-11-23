// Figma's and Paper's extensions on the page (src/main/extensions.ts), in Electron: the button's
// press reaches the extension's background worker, what Electron lacks is stood in for, and what
// the extension copies lands on the clipboard. With stand-in extensions made here, signed with a
// key of the test's own (crx-fixture.ts): one that copies as Paper's does (its worker sends the
// HTML to an "offscreen" page), one that signs in first as Figma's does (a tab of its own, a
// redirect to its chromiumapp.org address) and then copies from the page itself.
//
//   node scripts/build.mjs --tests && electron --ozone-platform=headless --disable-gpu dist/test/extensions.e2e.cjs
//
// With B42_REAL_EXTENSIONS=<folder> holding paper.crx (as the Chrome Web Store gives it), Paper's
// own is pressed instead and its picker driven: for a person to run, never in `npm test`.
import { app, BrowserWindow, clipboard } from "electron"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { createExtensions, EXTENSION_IDS, fromStore } from "../src/main/extensions"
import { createPage } from "../src/main/page"
import { heavyLock } from "../scripts/heavy-lock.mjs"
import { makeCrx, makeZip } from "./crx-fixture"

const results: { name: string; ok: boolean }[] = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  return fn()
}
const clipboardHtml = async () => {
  for (const item of await clipboard.read()) if (item.types.includes("text/html")) return (await item.getType("text/html")).text()
  return ""
}

const PAGE = `<!doctype html><title>Spike page</title><style>body{margin:0;padding:48px;font:16px system-ui}#card{width:360px;padding:24px;border-radius:16px;background:#fff}</style><div id="card"><h2>B42 Tandem</h2><p>Two riders, one frame.</p></div>`

/** Paper's way: the toolbar button starts a picker on the page; the picked element's HTML goes to
 *  the clipboard by way of a message to an offscreen page, as `<x-paper-html>`. */
const FAKE_PAPER = {
  "manifest.json": JSON.stringify({ manifest_version: 3, name: "Stand-in Paper", version: "1.0.0", permissions: ["scripting", "activeTab", "clipboardWrite", "offscreen", "contextMenus"], background: { service_worker: "bg.js" }, action: {} }),
  "bg.js": `
chrome.contextMenus.onClicked.addListener(() => {})
chrome.permissions.onAdded.addListener(() => {})
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.action.disable(tab.id)
  const [picked] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => new Promise((done) => addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); done(e.target.closest("#card").outerHTML) }, { capture: true, once: true })) })
  if ((await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length === 0) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["CLIPBOARD"], justification: "copy" })
  const answer = await chrome.runtime.sendMessage({ target: "offscreen-clipboard", type: "copy-html", html: "<x-paper-html>" + picked.result + "</x-paper-html>" })
  console.log("stand-in paper copied: " + JSON.stringify(answer))
  await chrome.action.enable(tab.id)
})`,
  "offscreen.html": "<!doctype html>",
}

/** Figma's way: no sign-in kept, the button opens the extension's page in a tab, which goes to
 *  the sign-in site; the site sends it on to https://<id>.chromiumapp.org/?code=…, which the worker
 *  watches its tabs for, keeps, and closes the tab. Signed in, the button copies from the page
 *  itself (navigator.clipboard, which the page's session must allow). */
const fakeFigma = (signIn: string) => ({
  "manifest.json": JSON.stringify({ manifest_version: 3, name: "Stand-in Figma", version: "1.0.0", permissions: ["storage", "identity", "tabs"], optional_permissions: ["scripting", "clipboardWrite"], background: { service_worker: "bg.js" }, action: {} }),
  "bg.js": `
chrome.action.onClicked.addListener(async (tab) => {
  const { code } = await chrome.storage.local.get("code")
  if (!code) { await chrome.tabs.create({ url: chrome.runtime.getURL("signin.html") }); return }
  if (!(await chrome.permissions.contains({ origins: ["<all_urls>"], permissions: ["scripting", "clipboardWrite"] }))) return console.log("no permission")
  const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async (code) => {
    window.focus()
    try { await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob(["<b data-figma='" + code + "'>" + document.title + "</b>"], { type: "text/html" }) })]); return "written" } catch (e) { return String(e) }
  }, args: [code] })
  console.log("stand-in figma: " + r.result)
})
chrome.tabs.onUpdated.addListener(async (id, change) => {
  const back = chrome.identity.getRedirectURL()
  if (!change.url || !change.url.startsWith(back)) return
  await chrome.storage.local.set({ code: new URL(change.url).searchParams.get("code") })
  await chrome.tabs.remove(id)
})`,
  "signin.html": `<!doctype html><title>sign in</title><script src="signin.js"></script>`,
  "signin.js": `chrome.permissions.onAdded.addListener(() => {})
chrome.tabs.getCurrent().then((t) => { document.title = "tab " + t.id; location.href = ${JSON.stringify(signIn)} })`,
})

async function main() {
  await heavyLock("extensions e2e")
  const real = process.env.B42_REAL_EXTENSIONS
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-ext-e2e-"))
  app.setPath("userData", path.join(root, "profile"))
  let code = ""
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    if (url.pathname === "/oauth") {
      code = `c${Date.now()}`
      // The sign-in site's answer, sent on to the extension's address as Figma's is.
      return void res.writeHead(302, { location: `https://${url.searchParams.get("id")}.chromiumapp.org/?code=${code}` }).end()
    }
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const paper = makeCrx(makeZip(FAKE_PAPER))
  const figmaKey = makeCrx(makeZip({ "manifest.json": "{}" })).key
  const figmaId = makeCrx(makeZip({}), figmaKey).id
  const figma = makeCrx(makeZip(fakeFigma(`${base}/oauth?id=${figmaId}`), true), figmaKey)
  const downloads: string[] = []

  const win = new BrowserWindow({ width: 1100, height: 800, show: true })
  win.setSize(1100, 800) // headless: a window is 1×1 until sized once shown
  const logs: string[] = []
  const log = (level: string, msg: string, data?: unknown) => {
    logs.push(`${level} ${msg} ${data ?? ""}`)
    if (process.env.B42_VERBOSE) console.log(`  [${level}] ${msg}`, data ?? "")
  }
  const page = await createPage(win, {
    preload: path.join(__dirname, "../page-preload.cjs"),
    partition: `persist:ext-e2e-${process.pid}`,
    onMessage() {},
    onChange() {},
    onShortcut() {},
    log,
  })
  page.setBounds({ x: 0, y: 0, width: 1000, height: 700 })
  const extensions = createExtensions({
    folder: path.join(root, "Extensions"),
    workerPreload: path.join(__dirname, "../ext-worker-preload.cjs"),
    pagePreload: path.join(__dirname, "../ext-page-preload.cjs"),
    page: () => page.view.webContents,
    window: () => win,
    ...(real ? {} : { ids: { paper: paper.id, figma: figma.id } }),
    // B42_FROM_STORE=1 with B42_REAL_EXTENSIONS: the Chrome Web Store's own download, as the app does.
    async download(id) {
      downloads.push(id)
      // B42_FROM_STORE=1 (with B42_REAL_EXTENSIONS): the Chrome Web Store's own download, as the app's.
      if (real && process.env.B42_FROM_STORE) return fromStore(id)
      if (real) return fs.readFileSync(path.join(real, `${id === EXTENSION_IDS.paper ? "paper" : "figma"}.crx`))
      return id === paper.id ? paper.crx : figma.crx
    },
    log,
  })
  const wc = () => page.view.webContents
  wc().on("console-message", (d) => log("page", d.message))
  wc().session.serviceWorkers.on("console-message", (_e, d) => log("worker", d.message))

  const loaded = new Promise<void>((r) => wc().once("did-finish-load", () => r()))
  page.load(`${base}/`)
  await loaded
  await sleep(300)

  // Before a page, nothing.
  // ── Paper's way ──────────────────────────────────────────────────────────────────────────────
  await extensions.press("paper")
  check("the first press downloads the extension, once", downloads.length === 1)
  const at = (await wc().executeJavaScript(`(() => { const r = document.querySelector("#card").getBoundingClientRect(); return { x: Math.round(r.x + 40), y: Math.round(r.y + 30) } })()`)) as { x: number; y: number }
  const dbg = wc().debugger
  dbg.attach("1.3")
  const click = async () => {
    await sleep(real ? 1200 : 400)
    // Headless Chromium moves no pointer: the move a mouse would make, then a real click.
    await wc().executeJavaScript(`window.dispatchEvent(new PointerEvent("pointermove", { clientX: ${at.x}, clientY: ${at.y}, bubbles: true, isPrimary: true, pointerType: "mouse" }))`)
    await sleep(300)
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 })
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 })
  }
  await click()
  const pasted = await until(async () => {
    const html = await clipboardHtml()
    return html.includes("x-paper-html") ? html : ""
  })
  check("Paper's: the picked element is on the clipboard as <x-paper-html>", pasted.startsWith("<x-paper-html>") && pasted.includes("B42 Tandem"), pasted.slice(0, 80))
  await clipboard.clear()
  await extensions.press("paper")
  check("a second press does not download it again", downloads.length === 1)
  await click()
  check("…and copies again", (await until(clipboardHtml)).includes("B42 Tandem"))
  // Switched off in Settings: out of the session, so it stops; back on, in again without a download.
  const paperId = real ? EXTENSION_IDS.paper : paper.id
  extensions.unload("paper")
  check("switched off, the extension is taken out of the page's session", await until(() => !wc().session.extensions.getExtension(paperId), 3000))
  await clipboard.clear()
  await extensions.press("paper")
  check("…pressed again, it is back in, with no second download", !!wc().session.extensions.getExtension(paperId) && downloads.length === 1)
  await click()
  check("…and copies", (await until(clipboardHtml)).includes("B42 Tandem"))

  if (real) {
    // Figma's own: no sign-in yet, so its screen opens in a window, and its button goes to figma.com.
    await extensions.press("figma")
    const signIn = await until(() => BrowserWindow.getAllWindows().find((w) => w !== win && w.webContents.getURL().includes("options.html")), 10000)
    check("Figma's: its own sign-in screen opens in a window", !!signIn)
    if (signIn) {
      await until(() => !signIn.webContents.isLoading(), 5000)
      await sleep(1000)
      const pressed = await signIn.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll("button")].find((b) => /log in/i.test(b.textContent)); b?.click(); return !!b })()`, true)
      const site = await until(() => BrowserWindow.getAllWindows().find((w) => /figma\.com\/(login|oauth)/.test(w.webContents.getURL())), 15000)
      check("…its Log in goes to figma.com's sign-in (needs the network)", pressed && !!site, site?.webContents.getURL().slice(0, 80))
    }
  }
  if (!real) {
    // ── Figma's way ────────────────────────────────────────────────────────────────────────────
    await clipboard.clear()
    const before = BrowserWindow.getAllWindows().length
    await extensions.press("figma")
    const signedIn = await until(() => code !== "", 10000)
    check("Figma's: its sign-in tab opens and goes to the sign-in site", !!signedIn)
    const closed = await until(() => BrowserWindow.getAllWindows().length === before, 8000)
    check("…the redirect to its chromiumapp.org address reaches the worker, which closes the tab", closed, `${BrowserWindow.getAllWindows().length} windows`)
    await extensions.press("figma")
    const html = await until(clipboardHtml, 6000)
    check("signed in, it copies from the page itself (the clipboard write allowed)", html.includes(`data-figma="${code}"`) || html.includes(`data-figma='${code}'`), html.slice(0, 80) || logs.filter((l) => l.includes("figma")).slice(-3).join(" | "))
  }

  extensions.dispose()
  page.dispose()
  server.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed} passed, ${failed} failed`)
  if (failed) console.log(logs.slice(-40).join("\n"))
  fs.rmSync(root, { recursive: true, force: true })
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((err) => {
  console.error(err)
  app.exit(1)
})

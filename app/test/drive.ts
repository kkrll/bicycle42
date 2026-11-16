import { app, type BrowserWindow } from "electron"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AppState } from "../src/shared/types"
import { WORLD, type PageView } from "../src/main/page"
import { start, type FakeRequest } from "./fake-server"

const USAGE = `app/scripts/drive.mjs [--site <url>] [--out <dir>] "<step>" "<step>" ...

Launches the built app against a fake OpenCode server and runs the steps in order, one per
argument. The page is overlay/harness/page.html unless --site names another.

  url <path|url>        load a harness path (harness/canvas.html) or any URL
  mode <m>              preview | notes | edit | motion
  size <w> <h>          resize the window
  click <x>,<y>         a real click in the page, page CSS px
  drag <x>,<y> <x>,<y>  press, move, release
  move <x>,<y>          the pointer only
  type <text>           real key presses, one per character
  key <Key>             Enter, Escape, mod+U, shift+Tab ...
  wait <ms>
  until <js>            wait for a truthy value in the app window (10 s)
  ui <js>               evaluate in the app window, print the result
  page <js>             evaluate among the page's own scripts
  overlay <js>          evaluate in the overlay's world (window.__b42)
  cmd <name> [json...]  window.b42.invoke(name, ...args)
  state [a.b.c]         AppState, or a part of it
  prompts               what the app sent the agent so far
  shot <name>           <out>/<name>-window.png and <name>-page.png, with the view's bounds
  log                   console errors and warnings from the window and the page`

type Hook = { window(): BrowserWindow | undefined; page(): PageView | undefined; snapshot(): AppState }

const argv = process.argv.slice(process.argv.findIndex((a) => a.endsWith("drive.cjs")) + 1)
const option = (name: string) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv.splice(i, 2)[1]
}
const site = option("--site")
const out = path.resolve(option("--out") ?? fs.mkdtempSync(path.join(os.tmpdir(), "b42-drive-")))
fs.mkdirSync(out, { recursive: true })
const steps = argv.filter((a) => a.trim())
const overlayDir = path.join(__dirname, "../../../overlay")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T | Promise<T>, ms = 10_000): Promise<NonNullable<T>> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error(`still false after ${ms} ms`)
}
const point = (s: string | undefined) => {
  const [x, y] = (s ?? "").split(",").map(Number)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`expected x,y, got ${s}`)
  return { x: x!, y: y! }
}
const print = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2))

function serveHarness(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const file = path.normalize(path.join(overlayDir, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)))
    if (!file.startsWith(overlayDir)) {
      res.writeHead(403).end()
      return
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end("not found")
        return
      }
      const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "text/javascript"
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body)
    })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

async function main() {
  if (!steps.length || steps[0] === "help") {
    console.log(USAGE)
    return
  }
  const harness = await serveHarness()
  const origin = `http://127.0.0.1:${(harness.address() as { port: number }).port}`
  const first = site ?? `${origin}/harness/page.html`

  const server = await start()
  const SES = "ses_drive"
  const session = { id: SES, projectID: "p", title: "Review", time: { created: 1, updated: 2 } }
  const prompts: FakeRequest[] = []
  server.route("GET", "/api/model", {
    json: {
      location: { directory: "/" },
      data: [
        {
          id: "sonnet",
          providerID: "anthropic",
          name: "Sonnet",
          capabilities: { tools: true, input: ["text", "image"] },
          variants: [],
          enabled: true,
          status: "active",
        },
      ],
    },
  })
  server.route("GET", "/api/agent", {
    json: { data: [{ id: "build", name: "build", mode: "primary", hidden: false, permissions: [] }] },
  })
  server.route("GET", "/api/session", { json: { data: [], cursor: { previous: null, next: null } } })
  server.route("POST", "/api/session", { json: { data: { ...session, location: { directory: "/site" } } } })
  server.route("GET", `/api/session/${SES}`, { json: { data: { ...session, location: { directory: "/site" } } } })
  server.route("GET", /\/(inbox|permission|form)$/, { json: { data: [] } })
  server.route("GET", /\/message$/, { json: { data: [], cursor: { previous: null, next: null } } })
  server.route("GET", "/api/command", { json: { data: [] } })
  server.route("POST", `/api/session/${SES}/prompt`, (req) => {
    prompts.push(req)
    return { json: { data: { id: `msg_${prompts.length}`, sessionID: SES, type: "user", delivery: "queue" } } }
  })

  const siteOrigin = new URL(first).origin
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "b42-drive-profile-"))
  fs.writeFileSync(
    path.join(profile, "settings.json"),
    JSON.stringify({
      version: 1,
      server: { url: server.url, password: `plain:${server.password}` },
      defaultModel: { providerID: "anthropic", id: "sonnet" },
      folder: "/site",
      lastUrl: first,
      sites: { [siteOrigin]: { directory: "/site" } },
    }),
  )
  process.env.BICYCLE42_DATA = profile
  process.env.BICYCLE42_TEST = "1"
  const built = path.join(__dirname, "..", "main.cjs")
  require(built)

  const hook = await until(() => (globalThis as { __b42Test?: Hook }).__b42Test)
  const win = await until(() => hook.window())
  const page = await until(() => hook.page())
  await until(() => hook.snapshot().page.url === first && !hook.snapshot().page.loading, 20_000)
  win.setSize(1440, 900)
  await until(() => page.view.getVisible() && page.view.getBounds().width > 100)

  const logs: string[] = []
  win.webContents.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") logs.push(`window ${e.level}: ${e.message}`)
  })
  page.view.webContents.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") logs.push(`page ${e.level}: ${e.message}`)
  })

  const wc = () => page.view.webContents
  const mods = (k: string) => {
    const parts = k.split("+")
    const keyCode = parts.pop()!
    const modifiers = parts.map((m) => (m === "mod" ? (process.platform === "darwin" ? "meta" : "control") : m))
    return { keyCode, modifiers: modifiers as Electron.InputEvent["modifiers"] }
  }
  const mouse = (type: "mouseDown" | "mouseUp" | "mouseMove", at: { x: number; y: number }) =>
    wc().sendInputEvent({ type, x: at.x, y: at.y, button: "left", clickCount: 1 })

  for (const step of steps) {
    const [verb = "", ...rest] = step.trim().split(/\s+/)
    const arg = step.trim().slice(verb.length).trim()
    console.log(`\n> ${step}`)
    switch (verb) {
      case "url":
        page.load(/^https?:/.test(arg) ? arg : `${origin}/${arg.replace(/^\//, "")}`)
        await until(() => !hook.snapshot().page.loading, 20_000)
        print(hook.snapshot().page.url)
        break
      case "mode":
        await win.webContents.executeJavaScript(`window.b42.invoke("setMode", ${JSON.stringify(arg)})`)
        await sleep(300)
        print(hook.snapshot().review)
        break
      case "size":
        win.setSize(Number(rest[0]), Number(rest[1]))
        await sleep(300)
        print(page.view.getBounds())
        break
      case "click":
        mouse("mouseMove", point(rest[0]))
        mouse("mouseDown", point(rest[0]))
        mouse("mouseUp", point(rest[0]))
        await sleep(150)
        break
      case "move":
        mouse("mouseMove", point(rest[0]))
        await sleep(100)
        break
      case "drag": {
        const [a, b] = [point(rest[0]), point(rest[1])]
        mouse("mouseMove", a)
        mouse("mouseDown", a)
        for (let i = 1; i <= 12; i++)
          mouse("mouseMove", { x: a.x + ((b.x - a.x) * i) / 12, y: a.y + ((b.y - a.y) * i) / 12 })
        mouse("mouseUp", b)
        await sleep(150)
        break
      }
      case "type":
        for (const ch of arg) {
          wc().sendInputEvent({ type: "keyDown", keyCode: ch })
          wc().sendInputEvent({ type: "char", keyCode: ch })
          wc().sendInputEvent({ type: "keyUp", keyCode: ch })
        }
        await sleep(100)
        break
      case "key":
        wc().sendInputEvent({ type: "keyDown", ...mods(arg) })
        wc().sendInputEvent({ type: "keyUp", ...mods(arg) })
        await sleep(150)
        break
      case "wait":
        await sleep(Number(arg))
        break
      case "until":
        await until(() => win.webContents.executeJavaScript(arg))
        break
      case "ui":
        print(await win.webContents.executeJavaScript(arg))
        break
      case "page":
        print(await wc().executeJavaScript(arg))
        break
      case "overlay":
        print(await wc().executeJavaScriptInIsolatedWorld(WORLD, [{ code: arg }]))
        break
      case "cmd": {
        const [name, ...json] = rest
        const args = json.length ? JSON.parse(`[${json.join(" ")}]`) : []
        print(
          await win.webContents.executeJavaScript(
            `window.b42.invoke(${JSON.stringify(name)}, ...${JSON.stringify(args)})`,
          ),
        )
        break
      }
      case "state": {
        let v: unknown = hook.snapshot()
        for (const key of arg ? arg.split(".") : []) v = (v as Record<string, unknown> | undefined)?.[key]
        print(v ?? null)
        break
      }
      case "prompts":
        print(
          JSON.parse(
            JSON.stringify(prompts.map((p) => p.body)).replace(
              /"data:([^;"]+);base64,[^"]*"/g,
              (m, type: string) => `"<${type}, ${m.length} chars>"`,
            ),
          ),
        )
        break
      case "shot": {
        const name = arg || "shot"
        const files = [`${name}-window.png`, `${name}-page.png`].map((f) => path.join(out, f))
        fs.writeFileSync(files[0]!, (await win.webContents.capturePage()).toPNG())
        fs.writeFileSync(files[1]!, (await wc().capturePage()).toPNG())
        print({ window: files[0], page: files[1], pageBounds: page.view.getBounds() })
        break
      }
      case "log":
        print(logs.length ? logs : "no errors or warnings")
        break
      default:
        throw new Error(`unknown step "${verb}"\n\n${USAGE}`)
    }
  }

  await server.stop()
  harness.close()
  fs.rmSync(profile, { recursive: true, force: true })
  app.exit(0)
}

setTimeout(() => {
  console.log("drive: timed out after 120 s")
  app.exit(1)
}, 120_000).unref()

main().catch((err: unknown) => {
  console.log(`drive: ${err instanceof Error ? err.message : String(err)}`)
  app.exit(1)
})

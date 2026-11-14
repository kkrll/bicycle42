// The app in real Electron, headless, against the OpenCode server running on this computer and
// a real agent. It makes a throwaway git repository holding a two-file site, serves it, and
// acts like a reviewer: notes that are one-line CSS changes, then the things done with a
// finished note. It checks what only a real server shows: the picture after the agent is done,
// a note's code diff, taking a note back, checkpoints, the commit and the conversation's name.
//
//   bun run test:real
//   B42_REAL_MODEL=provider/model bun run test:real
//
// It spends model tokens on the server's account, so it is not part of `bun run test`. It
// works in a conversation of its own in a folder of its own, approves only that conversation's
// permission requests, and deletes the conversation and the folder when it ends.
// Exits 0 when every check passes.
import { app, nativeImage, type BrowserWindow } from "electron"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AppState, FileChange } from "../src/shared/types"
import type { Page } from "../src/main/page"
import { readLocal } from "../src/main/local"

/** Free on this server, reads pictures, and makes a one-line CSS change reliably. */
const MODEL = process.env.B42_REAL_MODEL || "opencode/deepseek-v4.1-flash-free"
/** One turn of the agent: a free model can be slow to start. */
const TURN = 300_000

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push(ok)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  return fn()
}

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Throwaway</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1 id="title">A small page</h1>
    <p id="lead">One paragraph of text under the heading.</p>
    <button id="cta">Go</button>
  </body>
</html>
`
const CSS = `body {
  margin: 40px;
  font-family: sans-serif;
  background: #ffffff;
}

#title {
  color: #222222;
}

#lead {
  color: #444444;
}

#cta {
  width: 320px;
  height: 120px;
  border: 0;
  color: #ffffff;
  background: #777777;
}
`

type Hook = { window(): BrowserWindow | undefined; page(): Page | undefined; snapshot(): AppState }

async function main() {
  const local = readLocal()
  if (!local) throw new Error("No OpenCode server is registered on this computer (opencode service start).")
  const [providerID, ...rest] = MODEL.split("/")
  const model = { providerID: providerID!, id: rest.join("/") }

  // ── the throwaway repository, its site, and a profile that knows both ──────────────────────
  // realpath: the server names a folder by its real path, and /tmp can be a link.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-real-")))
  const repo = path.join(root, "site")
  const profile = path.join(root, "profile")
  fs.mkdirSync(repo)
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(repo, "index.html"), HTML)
  fs.writeFileSync(path.join(repo, "style.css"), CSS)
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  git("config", "user.name", "bicycle 42 test")
  git("config", "user.email", "test@bicycle42.invalid")
  git("config", "commit.gpgsign", "false")
  git("add", "-A")
  git("commit", "-q", "-m", "A small page")
  const css = () => fs.readFileSync(path.join(repo, "style.css"), "utf8")
  /** The declarations of one rule of the site's stylesheet, as they are on disk. */
  const rule = (selector: string) => new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css())?.[1] ?? ""

  const siteServer = http.createServer((req, res) => {
    const name = new URL(req.url ?? "/", "http://x").pathname === "/style.css" ? "style.css" : "index.html"
    res.writeHead(200, { "content-type": name.endsWith(".css") ? "text/css" : "text/html", "cache-control": "no-store" }).end(fs.readFileSync(path.join(repo, name)))
  })
  await new Promise<void>((resolve) => siteServer.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(siteServer.address() as { port: number }).port}`
  const pageUrl = `${origin}/`

  // ── the server, asked directly: only to look, and to clean up after ────────────────────────
  const auth = `Basic ${Buffer.from(`opencode:${local.password}`).toString("base64")}`
  const server = async (method: string, route: string) => {
    const res = await fetch(`${local.url}${route}`, { method, headers: { authorization: auth } })
    const body = await res.text()
    if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${body.slice(0, 200)}`)
    return body ? (JSON.parse(body) as { data?: unknown }) : {}
  }
  const directoryOf = async (id: string) => ((await server("GET", `/api/session/${id}`)).data as { location?: { directory?: string } } | undefined)?.location?.directory
  /** Every conversation this run made: the ones the app showed, and whatever else is in the folder. */
  const mine = new Set<string>()
  const cleanUp = async () => {
    const listed = await server("GET", `/api/session?directory=${encodeURIComponent(repo)}`).then((r) => (r.data as { id: string }[]).map((x) => x.id), () => [] as string[])
    const deleted: string[] = []
    for (const id of new Set([...mine, ...listed])) {
      // Only a conversation in the throwaway folder is ever deleted.
      if ((await directoryOf(id).catch(() => undefined)) !== repo) continue
      await server("DELETE", `/api/session/${id}`).then(() => deleted.push(id), (err) => console.log(`could not delete ${id}: ${err}`))
    }
    const left = await server("GET", `/api/session?directory=${encodeURIComponent(repo)}`).then((r) => (r.data as unknown[]).length, () => -1)
    console.log(`deleted conversations: ${deleted.join(", ") || "none"}; left in the folder: ${left}`)
    siteServer.close()
    fs.rmSync(root, { recursive: true, force: true })
    console.log(`removed ${root}: ${!fs.existsSync(root)}`)
  }

  let failed = 1
  try {
    fs.writeFileSync(
      path.join(profile, "settings.json"),
      JSON.stringify({ version: 1, server: { url: local.url, password: `plain:${local.password}` }, lastUrl: pageUrl, defaultModel: model, sites: { [origin]: { directory: repo } } }),
    )
    process.env.BICYCLE42_DATA = profile
    process.env.BICYCLE42_TEST = "1"
    // Not a literal, so the bundler leaves it alone: this must be the app as built.
    const built = path.join(__dirname, "..", "main.cjs")
    require(built)

    const hook = (await until(() => (globalThis as { __b42Test?: Hook }).__b42Test))!
    const state = () => hook.snapshot()
    const win = (await until(() => hook.window()))!
    const page = (await until(() => hook.page()))!
    const ui = (code: string) => win.webContents.executeJavaScript(code)
    const invoke = <T>(name: string, ...args: unknown[]) => ui(`window.b42.invoke(${[name, ...args].map((a) => JSON.stringify(a)).join(", ")})`) as Promise<T>
    const refused = (name: string, ...args: unknown[]) => invoke(name, ...args).then(() => "", (err: Error) => err.message)

    await until(() => state().session, 20_000)
    const SES = state().session?.id ?? ""
    if (SES) mine.add(SES)
    check("the app opens a conversation of its own in the throwaway repository", !!SES && state().site?.directory === repo && (await directoryOf(SES)) === repo, `${SES} in ${state().site?.directory}`)
    check("…on the model asked for", state().session?.model?.providerID === model.providerID && state().session?.model?.id === model.id, JSON.stringify(state().session?.model))
    if (!SES || state().site?.directory !== repo) throw new Error("Not in the throwaway repository: nothing is sent.")

    // Permission requests of this run's own conversations are approved, once each; nobody else's.
    const answered = new Set<string>()
    const approver = setInterval(() => {
      const s = state()
      if (s.session) mine.add(s.session.id)
      for (const p of s.permissions) {
        if (!mine.has(p.session) || answered.has(p.id)) continue
        answered.add(p.id)
        console.log(`     approving ${p.id}`)
        void refused("replyPermission", p.id, "once")
      }
    }, 300)
    approver.unref()

    await until(() => state().page.url === pageUrl && !state().page.loading, 15_000)
    await until(() => page.view.getVisible() && page.view.getBounds().width > 100)
    // Headless Electron only lays the view's renderer out when the window itself is resized.
    win.setSize(1441, 900)
    await sleep(300)

    const wc = page.view.webContents
    const js = (code: string) => wc.executeJavaScript(code)
    const dbg = wc.debugger
    const shadow = "document.querySelector('b42-review')?.shadowRoot"
    /** The layer is in the page, answering, and not hidden. */
    const overlayOn = async () => (await page.overlay("!!window.__b42")) === true && (await js(`(() => { const el = document.querySelector("b42-review"); return !!el && getComputedStyle(el).visibility !== "hidden" })()`)) === true
    await until(overlayOn, 15_000)
    await dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true })
    const mouse = (type: string, x: number, y: number, extra = {}) =>
      dbg.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra })
    // A hidden headless view and window draw almost no frames unless asked to, and the overlay
    // and the window both wait on frames (see app.e2e.ts).
    const closed = () => win.isDestroyed() || wc.isDestroyed()
    const frames = setInterval(() => (closed() ? clearInterval(frames) : wc.invalidate()), 16)
    void (async () => {
      while (!closed()) {
        await win.webContents.capturePage().catch(() => undefined)
        await sleep(30)
      }
    })()
    frames.unref()

    const notes = () => state().review.notes
    /** Points at an element, types the note and presses Enter, like a reviewer. */
    const note = async (selector: string, words: string) => {
      await until(async () => !state().page.loading && (await overlayOn()), 15_000)
      const at = (await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)) as { x: number; y: number }
      const open = () => js(`!!${shadow}?.querySelector('.card') && !${shadow}.querySelector('.card').hidden`)
      for (let i = 0; i < 5 && !(await open()); i++) {
        await mouse("mouseMoved", at.x, at.y, { button: "none" })
        await mouse("mousePressed", at.x, at.y)
        await mouse("mouseReleased", at.x, at.y)
        await until(open, 600)
      }
      await sleep(150)
      await dbg.sendCommand("Input.insertText", { text: words })
      await sleep(100)
      const before = notes().length
      wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" })
      wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" })
      await until(() => notes().length > before)
      return notes()[before]?.id ?? ""
    }
    const row = (id: string) => notes().find((n) => n.id === id)
    /** Waits for the agent to finish a note. */
    const finished = async (id: string) => {
      const t0 = Date.now()
      await until(() => row(id)?.status === "done" || row(id)?.status === "failed", TURN)
      console.log(`     note ${row(id)?.n} ${row(id)?.status} after ${Math.round((Date.now() - t0) / 1000)} s`)
      return row(id)?.status === "done"
    }
    /** Waits for a turn asked for with a message, not a note, to start and end. */
    const turn = async () => {
      await until(() => state().session?.busy, 30_000)
      await until(() => !state().session?.busy, TURN)
      await sleep(500)
    }
    /** How much greener than red and blue a picture is, on average. */
    const green = (uri: string | undefined) => {
      if (!uri) return NaN
      const bitmap = nativeImage.createFromDataURL(uri).toBitmap()
      let sum = 0
      for (let i = 0; i < bitmap.length; i += 4) sum += bitmap[i + 1]! - (bitmap[i]! + bitmap[i + 2]!) / 2
      return sum / (bitmap.length / 4)
    }
    /** What the page itself paints, as opposed to what the stylesheet on disk says. */
    const painted = (selector: string, property: string) => js(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(property)}]`) as Promise<string>
    const shows = (selector: string, property: string, value: string) => until(async () => (await painted(selector, property)) === value, 8000)
    const GREY = "rgb(119, 119, 119)"
    const DARK = "rgb(34, 34, 34)"
    const LEAD = "rgb(68, 68, 68)"
    /** The conversation as the window shows it: what the reviewer said, and the checkpoints, in order. */
    const said = () => ui(`JSON.stringify([...document.querySelectorAll(".user .user-text, .marker.checkpoint .checkpoint-name")].map((el) => el.textContent.trim()))`).then((t) => JSON.parse(t as string) as string[])
    const info = async () => (await server("GET", `/api/session/${SES}`)).data as { title?: string; revert?: { messageID?: string } }

    // ── 1. a note, and the picture of its area once the agent is done ────────────────────────
    const first = await note("#cta", "make the button green")
    check("the note is taken, with the picture of its area as it was", !!first && (await until(() => row(first)?.pictures === "before")) === true, JSON.stringify(row(first)))
    check("the agent finishes the first note", await finished(first), `${row(first)?.status} ${row(first)?.error ?? ""}`)
    check("…and changed the button in the stylesheet", /background/.test(rule("#cta")) && !rule("#cta").includes("#777777"), rule("#cta").replace(/\s+/g, " "))
    check("the area is pictured again once the agent is done", (await until(() => row(first)?.pictures === "both", 40_000)) === true, `pictures: ${row(first)?.pictures}`)
    const shots = await invoke<{ before?: string; after?: string }>("notePictures", first)
    check("…and the second picture shows the change", green(shots.after) > green(shots.before) + 5, `green before ${green(shots.before).toFixed(1)}, after ${green(shots.after).toFixed(1)}`)
    check("the page is back where the reviewer had it, with the layer showing", (await until(() => js(`!document.getElementById("b42-after") && scrollY === 0`))) === true && (await until(overlayOn)) === true, String(await js(`JSON.stringify([!!document.getElementById("b42-after"), scrollY, document.readyState, !!document.querySelector("b42-review")])`)))
    check("the page shows the change", (await shows("#cta", "backgroundColor", GREY)) === false, await painted("#cta", "backgroundColor"))

    // ── 6. the conversation is named after its first note ────────────────────────────────────
    check("the conversation is named after the first note, on the server too", (await until(async () => (await info()).title === "Make the button green", 10_000)) === true && state().session?.title === "Make the button green", `${(await info()).title} / ${state().session?.title}`)

    // ── 2. what the agent changed in the code for the note ───────────────────────────────────
    const diff = await invoke<FileChange[]>("noteDiff", first).catch((err: Error) => err.message)
    check(
      "the note's diff is the stylesheet's change",
      Array.isArray(diff) && diff.length === 1 && diff[0]!.file === "style.css" && diff[0]!.additions > 0 && /^-\s*background: #777777;$/m.test(diff[0]!.patch),
      typeof diff === "string" ? diff : JSON.stringify(diff.map((f) => [f.file, f.additions, f.deletions, f.patch.length])),
    )

    // ── 5. the repo's state ──────────────────────────────────────────────────────────────────
    await invoke("refreshRepo")
    check(
      "the header's repo state: the branch, and the stylesheet changed and not committed",
      state().repo?.branch === "main" && state().repo?.changes.length === 1 && state().repo?.changes[0]?.file === "style.css" && state().repo?.changes[0]?.status === "modified" && (state().repo?.changes[0]?.additions ?? 0) > 0,
      JSON.stringify(state().repo),
    )

    // ── 4. a checkpoint, and a second note after it ──────────────────────────────────────────
    const settings = () => JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8")) as { sites: Record<string, { checkpoints?: { id: string; name: string; session: string }[] }> }
    await invoke("runCommand", "checkpoint", "green button")
    const cp = await until(() => settings().sites[origin]?.checkpoints?.[0])
    check("/checkpoint marks the point", cp?.name === "green button" && cp.session === SES, JSON.stringify(cp))
    const afterFirst = css()
    check("its line is in the conversation, after the first note", (await until(async () => (await said()).join("|") === "make the button green|green button")) === true, JSON.stringify(await said()))
    const second = await note("#title", "make the heading red")
    check("the agent finishes the second note", await finished(second), `${row(second)?.status} ${row(second)?.error ?? ""}`)
    check("…and changed the heading", !rule("#title").includes("#222222"), rule("#title").replace(/\s+/g, " "))
    check("the second note has its picture after too", (await until(() => row(second)?.pictures === "both", 40_000)) === true, `pictures: ${row(second)?.pictures}`)
    const diff2 = await invoke<FileChange[]>("noteDiff", second).catch((err: Error) => err.message)
    check("the second note's diff is its own turn's, not the first's", Array.isArray(diff2) && diff2.length === 1 && /#222222/.test(diff2[0]!.patch) && !/#777777/.test(diff2[0]!.patch), typeof diff2 === "string" ? diff2 : diff2.map((f) => f.patch).join("\n"))

    // ── 3a. taking back a note that is not the newest: the agent is asked ────────────────────
    const how = await invoke<string>("takeBackNote", first).catch((err: Error) => `refused: ${err.message}`)
    check("taking back the older note asks the agent", how === "asked" && row(first)?.takenBack === "asked", how)
    await turn()
    check("…who puts the button back and leaves the heading", rule("#cta").includes("#777777") && !rule("#title").includes("#222222"), `${rule("#cta")} / ${rule("#title")}`.replace(/\s+/g, " "))
    check("…and the page shows the button as it was", (await shows("#cta", "backgroundColor", GREY)) === true, await painted("#cta", "backgroundColor"))
    const afterTakeBack = css()
    const all = await said()
    check("the checkpoint's line stays between the first note and the second", all.length === 4 && all.slice(0, 3).join("|") === "make the button green|green button|make the heading red", JSON.stringify(all.map((t) => t.slice(0, 40))))

    // ── 4. back to the checkpoint, and forward again ─────────────────────────────────────────
    const went = await invoke<number>("returnToCheckpoint", cp?.id).catch((err: Error) => `refused: ${err.message}`)
    check("Return here takes back the two messages after the checkpoint", went === 2, String(went))
    check("…and the files with them: the stylesheet is as it was at the checkpoint", (await until(() => css() === afterFirst, 5000)) === true, css() === afterTakeBack ? "unchanged" : "something else")
    check("…and the page shows it: the button green again, the heading as it was", (await shows("#title", "color", DARK)) === true && (await painted("#cta", "backgroundColor")) !== GREY, `${await painted("#title", "color")} ${await painted("#cta", "backgroundColor")}`)
    check("the conversation ends at the checkpoint", (await until(async () => (await said()).join("|") === "make the button green|green button")) === true, JSON.stringify(await said()))
    check("…the note sent after it says it was undone, the one before it does not", row(second)?.takenBack === "undone" && row(first)?.takenBack === "asked", `${row(first)?.takenBack} ${row(second)?.takenBack}`)
    check("the server holds the undo at the second note's message", !!(await info()).revert?.messageID)
    const redo = await invoke<{ say?: string }>("runCommand", "redo", "").catch((err: Error) => ({ say: `refused: ${err.message}` }))
    check("/redo brings it all back", redo?.say === "Brought back what was undone." && (await until(() => css() === afterTakeBack, 5000)) === true && !(await info()).revert, redo?.say)
    check("…on the page too", (await shows("#cta", "backgroundColor", GREY)) === true && (await painted("#title", "color")) !== DARK, `${await painted("#cta", "backgroundColor")} ${await painted("#title", "color")}`)
    check("…and in the conversation", (await until(async () => (await said()).length === 4)) === true, JSON.stringify((await said()).map((t) => t.slice(0, 40))))
    check("…and the note is no longer undone", row(second)?.takenBack === undefined, String(row(second)?.takenBack))

    // ── 3b. taking back the newest message: the server's own undo ────────────────────────────
    const third = await note("#lead", "make the paragraph text blue")
    check("the agent finishes the third note", await finished(third), `${row(third)?.status} ${row(third)?.error ?? ""}`)
    check("…and changed the paragraph", !rule("#lead").includes("#444444"), rule("#lead").replace(/\s+/g, " "))
    const exact = await invoke<string>("takeBackNote", third).catch((err: Error) => `refused: ${err.message}`)
    check("taking back the newest note undoes it exactly", exact === "undone" && row(third)?.takenBack === "undone", exact)
    check("…files included", (await until(() => css() === afterTakeBack, 5000)) === true, rule("#lead").replace(/\s+/g, " "))
    check("…and the page shows the paragraph as it was", (await shows("#lead", "color", LEAD)) === true, await painted("#lead", "color"))

    check("a note taken back at once gets no second picture of an area that is as it was", (await sleep(3000), row(third)?.pictures) === "before", `pictures: ${row(third)?.pictures}`)

    // ── 5. the commit ────────────────────────────────────────────────────────────────────────
    await invoke("refreshRepo")
    check("the repo state still shows the stylesheet as changed", state().repo?.changes.some((c) => c.file === "style.css") === true, JSON.stringify(state().repo))
    const message = "Heading in red"
    const committing = await refused("commitChanges", message)
    await turn()
    const log = git("log", "--format=%s")
    check("Commit has the agent commit everything with the message as written", committing === "" && log.split("\n")[0] === message && log.split("\n").length === 2 && git("status", "--porcelain") === "", `${committing} ${JSON.stringify(log)} ${git("status", "--porcelain")}`)
    check("…without pushing: the repository has no remote", git("remote") === "")
    check("the repo state shows nothing left to commit", (await until(() => state().repo?.changes.length === 0, 10_000)) === true, JSON.stringify(state().repo))
    check("the stylesheet committed is the one on screen", git("show", "HEAD:style.css") === afterTakeBack.trim() || git("show", "HEAD:style.css").trim() === afterTakeBack.trim())

    check("the conversation still has the name the first note gave it", (await info()).title === "Make the button green" && state().session?.title === "Make the button green", `${(await info()).title} / ${state().session?.title}`)

    clearInterval(approver)
    app.emit("before-quit")
    failed = results.filter((ok) => !ok).length
    console.log(`\n${results.length - failed}/${results.length} checks passed`)
  } finally {
    await cleanUp().catch((err) => console.log("FAIL clean-up:", err))
  }
  app.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.log("FAIL crashed:", err)
  app.exit(1)
})

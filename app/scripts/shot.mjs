// Screenshots of the app window in every state, light and dark, from the built renderer running
// against its mock (src/renderer/mock.ts). Builds nothing: run the renderer build first.
//
//   node_modules/.bin/electron --ozone-platform=headless --disable-gpu scripts/shot.mjs [name…]
//
// With names, only those shots are taken ("review", "connect-error", …). PNGs go to $SHOT_DIR,
// or to shots/ beside this folder (git-ignored). Prints the stress numbers when the stress shot runs.
import { app, BrowserWindow, nativeTheme } from "electron"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const page = path.join(root, "dist/renderer/index.html")
const out = process.env.SHOT_DIR ?? path.join(root, "shots")

const click = (selector) => `document.querySelector(${JSON.stringify(selector)}).click()`
const type = (selector, text) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event("input", { bubbles: true })) })()`

/** Types into the message box as a person would: focus, text, caret at the end, an input event. */
const typeIn = (text) =>
  `(() => { const el = document.querySelector(".composer textarea"); el.focus(); el.value = ${JSON.stringify(text)}; el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event("input", { bubbles: true })) })()`
const append = (text) =>
  `(() => { const el = document.querySelector(".composer textarea"); el.value += ${JSON.stringify(text)}; el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event("input", { bubbles: true })) })()`
const key = (k, extra = {}) =>
  `document.querySelector(".composer textarea").dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} }))`
const pause = (ms) => `new Promise((r) => setTimeout(r, ${ms}))`
/** Pastes a drawn picture into the message box, the way a clipboard image arrives. */
const pastePicture = `(async () => {
  const c = document.createElement("canvas"); c.width = 640; c.height = 400
  const g = c.getContext("2d"); g.fillStyle = "hsl(200 30% 92%)"; g.fillRect(0, 0, 640, 400)
  g.fillStyle = "hsl(200 40% 45%)"; g.fillRect(40, 40, 300, 48); g.fillRect(40, 120, 560, 20); g.fillRect(40, 160, 480, 20)
  const blob = await new Promise((r) => c.toBlob(r, "image/png"))
  const dt = new DataTransfer(); dt.items.add(new File([blob], "reference.png", { type: "image/png" }))
  document.querySelector(".composer textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
})()`

/** name, mock scenario, then optional: extra query, script to run after load, ms to wait, size. */
const SHOTS = [
  { name: "connect", mock: "connect" },
  {
    name: "connect-error",
    mock: "connect",
    run: [type("input[name=url]", "http://my-box.example:4096"), type("input[name=password]", "wrong"), click(".connect-form button[type=submit]")],
    wait: 1300,
  },
  {
    name: "connect-progress",
    mock: "connect",
    run: [type("input[name=url]", "http://my-box.example:4096"), type("input[name=password]", "wrong"), click(".connect-form button[type=submit]")],
    wait: 300,
  },
  // The second first-run step: which model conversations start with. Then narrowed by typing,
  // and the same chooser in the settings dialog.
  { name: "model-choice", mock: "model-choice" },
  { name: "model-choice-filter", mock: "model-choice", query: "&previous", run: [type(".model-form input[type=search]", "gpt")], wait: 300, report: `[document.querySelector(".model-form button[type=submit]").textContent, document.querySelector(".connect-lead").textContent]` },
  { name: "model-choice-settings", mock: "review", run: [click("[data-action=settings]"), pause(300), click("[data-action=default-model]")], wait: 500 },
  { name: "repo", mock: "repo" },
  { name: "empty", mock: "empty" },
  { name: "switcher", mock: "review", run: [click('[data-action="switcher"]')], wait: 500 },
  { name: "switcher-browse", mock: "review", run: [click('[data-action="switcher"]'), pause(300), click(".switcher-rows li:last-child .row")], wait: 600 },
  { name: "folder", mock: "folder" },
  { name: "folder-browse", mock: "folder", run: [click(".folder .folder-actions .btn")], wait: 500 },
  { name: "fresh", mock: "fresh" },
  { name: "review", mock: "review" },
  { name: "review-mac", mock: "review", query: "&platform=darwin" },
  { name: "review-menu", mock: "review", run: [click(".convo-current")] },
  { name: "review-open", mock: "review", run: [`document.querySelectorAll(".transcript details").forEach((d) => (d.open = true))`] },
  { name: "review-narrow", mock: "review", size: [760, 560] },
  { name: "collapsed", mock: "review", run: [click("[data-action=panel]")] },
  { name: "busy", mock: "busy", wait: 1500 },
  { name: "permission", mock: "permission" },
  { name: "question", mock: "question" },
  { name: "noconversation", mock: "noconversation" },
  { name: "offline", mock: "offline" },
  { name: "pageerror", mock: "pageerror" },
  { name: "settings", mock: "review", run: [click("[data-action=settings]")], wait: 500 },
  // A tunnel's address is one long word; named, the name leads and the address goes under it.
  {
    name: "settings-tunnel",
    mock: "review",
    run: [
      `window.__mock.state.connection.url = "https://eb501e0e4f991ca4.7fek5zuoivit.opentunnel.xyz"; 0`,
      click("[data-action=draw]"), // anything that makes the mock send its state
      click("[data-action=draw]"),
      click("[data-action=settings]"),
    ],
    wait: 500,
  },
  { name: "settings-rename", mock: "review", run: [click("[data-action=settings]"), pause(300), click("[data-action=rename-server]")], wait: 500 },
  {
    name: "settings-named",
    mock: "review",
    run: [click("[data-action=settings]"), pause(300), click("[data-action=rename-server]"), pause(100), `(() => { const f = document.querySelector(".server-name-form input"); f.value = "Studio Mac"; f.form.requestSubmit() })()`],
    wait: 500,
  },
  // The pointer rests on a mode: what it does and its key, in the bar.
  { name: "hint", mock: "review", run: [`document.querySelector('.mode[data-mode="edit"]').dispatchEvent(new PointerEvent("pointerenter"))`], wait: 900 },
  { name: "slash-menu", mock: "review", run: [typeIn("/")], wait: 300 },
  { name: "slash-filter", mock: "review", run: [typeIn("/re")], wait: 300 },
  // The app's own commands: /compact leaves a folded summary in the conversation; /undo asks first.
  { name: "slash-compact", mock: "review", run: [typeIn("/compact"), key("Escape"), key("Enter"), pause(1200), `document.querySelector("[data-summary]").open = true`], wait: 400, report: `document.querySelector("[data-summary=done] summary").textContent` },
  { name: "slash-undo", mock: "review", run: [typeIn("/undo"), key("Escape"), key("Enter")], wait: 500, report: `[document.querySelector(".composer-hint").textContent, document.querySelector(".composer textarea").value]` },
  { name: "mention-menu", mock: "review", run: [typeIn("Match the spacing in @her")], wait: 500 },
  { name: "mention-empty", mock: "review", run: [typeIn("@")], wait: 500 },
  { name: "mention-narrow", mock: "review", size: [640, 720], run: [typeIn("Look at @nav")], wait: 500 },
  {
    name: "attach-mention",
    mock: "review",
    run: [typeIn("Use the spacing from @hero"), pause(400), key("Enter"), pause(100), append("on the pricing cards too"), pastePicture],
    wait: 600,
  },
  { name: "busy-hint", mock: "busy", run: [typeIn("make the heading bolder")], wait: 1000 },
  { name: "requests", mock: "permission", run: [`document.querySelector(".asks .ask").focus()`] },
  { name: "requests-narrow", mock: "permission", size: [640, 720] },
  { name: "long", mock: "long", run: [`document.querySelectorAll(".transcript details").forEach((d) => (d.open = true))`, pause(300), `document.querySelector("[data-item=u-long]").scrollIntoView()`], wait: 600 },
  // Headless windows never have focus, so :hover and :focus cannot show the copy controls; they
  // are made visible by hand to check how they look.
  { name: "long-code", mock: "long", run: [`document.querySelector(".md .code").scrollIntoView({ block: "center" })`, `document.querySelectorAll(".code-copy, .msg-tools").forEach((el) => (el.style.opacity = 1))`], wait: 400 },
  // Behaviour, with what happened printed next to the picture.
  { name: "history", mock: "review", run: [typeIn(""), key("ArrowUp")], report: `document.querySelector(".composer textarea").value` },
  { name: "slash-run", mock: "review", run: [typeIn("/te"), pause(100), key("Enter"), pause(50), append("the pricing page"), key("Enter")], wait: 1500, report: `[...document.querySelectorAll(".user .user-text")].at(-1).textContent` },
  { name: "steer", mock: "busy", run: [pause(300), typeIn("stop, use the brand green instead"), key("Enter", { ctrlKey: true })], wait: 300, report: `[...document.querySelectorAll(".marker")].map((m) => m.textContent)` },
  { name: "cancel", mock: "busy", run: [click(".wait-cancel")], wait: 300, report: `document.querySelectorAll(".user.pending").length` },
  {
    name: "drop",
    mock: "review",
    run: [`(() => { const dt = new DataTransfer(); dt.items.add(new File(["x"], "a.png", { type: "image/png" })); document.querySelector(".composer-box").dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true })) })()`],
  },
  { name: "tool-failed", mock: "review", run: [`[...document.querySelectorAll(".tool")].find((t) => t.textContent.includes("lint")).scrollIntoView({ block: "center" })`], wait: 300 },
  { name: "lightbox", mock: "review", run: [click(".thumbs .thumb")], wait: 500 },
  { name: "note-flash", mock: "review", run: [`window.__mock.focusNote("n2")`], wait: 500 },
  // Canvas notes in the list: one with the reviewer's words (its pin clicked, so its edits are
  // listed under it), one named by its edits.
  { name: "canvas", mock: "canvas", run: [`window.__mock.focusNote("n5")`], wait: 1200 },
  { name: "stress", mock: "stress", until: "window.__stress", report: "window.__stress" },
  { name: "stress-code", mock: "stress-code", until: "window.__stress", report: "window.__stress" },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Each shot closes its window; the default would quit the app with the first one.
app.on("window-all-closed", () => {})

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true })
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-") && !a.endsWith("shot.mjs"))
  const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS
  let failed = 0
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme
    for (const shot of shots) {
      const [width, height] = shot.size ?? [1440, 900]
      // Offscreen, and sized after creation: under the headless platform a plain window is 1x1
      // and has no surface to capture; an offscreen one renders at the content size it is given.
      const win = new BrowserWindow({ width, height, show: false, webPreferences: { offscreen: true } })
      win.setContentSize(width, height)
      // The window remembers panel width and what is collapsed; every shot starts from defaults.
      await win.webContents.session.clearStorageData({ storages: ["localstorage"] })
      const errors = []
      win.webContents.on("console-message", (e) => {
        if (e.level === "error" || e.level === "warning") errors.push(e.message)
      })
      try {
        await win.loadFile(page, { search: `mock=${shot.mock}${shot.query ?? ""}` })
        if (shot.report) {
          // Counted from here on, which is before the mock starts its stress run.
          win.webContents.debugger.attach()
          await win.webContents.debugger.sendCommand("Performance.enable")
        }
        await sleep(400)
        for (const js of shot.run ?? []) await win.webContents.executeJavaScript(js)
        if (shot.until) {
          for (let i = 0; i < 300 && !(await win.webContents.executeJavaScript(`!!(${shot.until})`)); i++) await sleep(100)
        }
        await sleep(shot.wait ?? 400)
        const image = await win.webContents.capturePage()
        const file = path.join(out, `${shot.name}-${theme}.png`)
        fs.writeFileSync(file, image.toPNG())
        const size = image.getSize()
        console.log(`${file}  ${size.width}x${size.height}`)
        if (shot.report) {
          console.log(`  ${shot.name}:`, JSON.stringify(await win.webContents.executeJavaScript(shot.report)))
          // What the renderer's main thread spent during the run, from the debugger.
          const { metrics } = await win.webContents.debugger.sendCommand("Performance.getMetrics")
          const ms = (name) => Math.round(metrics.find((m) => m.name === name).value * 1000)
          console.log(`  renderer main thread: task ${ms("TaskDuration")} ms, script ${ms("ScriptDuration")} ms, layout ${ms("LayoutDuration")} ms, style ${ms("RecalcStyleDuration")} ms`)
        }
        // The page's box as last told to main, to compare with the picture.
        const bounds = await win.webContents.executeJavaScript(`JSON.stringify(window.__mock?.calls.at(-1) ?? null)`)
        console.log(`  page bounds: ${bounds}`)
      } catch (err) {
        failed++
        console.error(`${shot.name}-${theme}: ${err.message}`)
      }
      for (const e of errors) console.error(`  [console] ${e}`), failed++
      win.destroy()
    }
  }
  app.exit(failed ? 1 : 0)
})

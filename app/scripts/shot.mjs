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

/** The phone line's width, and whether anything in it is cut: what it needs over what it has. */
const PHONE_LINE = `(() => { const l = document.querySelector(".pl"), f = l.querySelector(".pl-facts"); return Math.round(l.getBoundingClientRect().width) + " wide; facts " + f.scrollWidth + "/" + f.clientWidth })()`
/** The inspector's footer: its width and rows, and whether a part of it is cut (needs/has), or
 *  reaches past the inspector's box. */
const FOOTER = `(() => { const f = document.querySelector(".cd-foot"), r = f.getBoundingClientRect(), box = document.querySelector(".cd").getBoundingClientRect(); const cut = [...f.querySelectorAll(".cd-count, .cd-acts, .cd-note, .cd-msg, .cd-send, .cd-help, .cd-reset")].filter((e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > box.right + 0.5).map((e) => e.className); const rows = new Set([...f.children].map((e) => Math.round(e.getBoundingClientRect().top))).size; return Math.round(r.width) + " wide, " + rows + " row(s), text at " + Math.round(f.querySelector(".cd-count").getBoundingClientRect().left - box.left) + "px; cut: " + (cut.join(" ") || "nothing") })()`
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

/** The panel at 360px, about the narrowest it is used at. */
const narrowPanel = `document.querySelector(".panel").style.setProperty("--panel-width", "360px")`

/** name, mock scenario, then optional: extra query, script to run after load, ms to wait, size. */
/** Presses the suggestion that asks the agent to get the site running. */
const START_SITE = `document.querySelector('.suggestion[title^="The agent starts it"]').click()`

/** The panel at its least (320px): the resizer's Home key. */
const leastPanel = `document.querySelector(".resizer").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))`
/** Makes the mock send its state again after `window.__mock.state` was changed by hand. */
const resend = [click("[data-action=draw]"), click("[data-action=draw]")]
/** What the place row shows, and whether any part of it is cut or runs past the row. */
const PLACE = `(() => { const p = document.querySelector(".place"), r = p.getBoundingClientRect(); const out = [...p.querySelectorAll(".place-agent, .place-folder, .place-settings")].filter((e) => e.getBoundingClientRect().right > r.right + 0.5).map((e) => e.className); return Math.round(r.width) + " wide: " + [...p.querySelectorAll(".place-agent-name, .place-word, .place-folder-name")].map((e) => e.textContent).join(" | ") + "; past the row: " + (out.join(" ") || "nothing") })()`

const SHOTS = [
  { name: "connect", mock: "connect" },
  // Someone who disconnected: the agents, then the ones connected to before, each with its mark.
  { name: "connect-returning", mock: "connect", query: "&returning", run: [`document.querySelector(".connect-saved").scrollIntoView({ block: "end" })`], wait: 300 },
  // The form inside the settings while Claude Code is in use: one agent in use, one to sign in
  // to, one not installed, one ready; the command that starts one, asked for.
  { name: "connect-agents", mock: "review", query: "&agent=claude", run: [click("[data-action=agents]"), pause(200), click("[data-action=connect-another]"), pause(400), click('[data-agent="opencode"] .agent-how')], wait: 400 },
  {
    name: "connect-error",
    mock: "connect",
    run: [click("[data-action=remote]"), type("input[name=url]", "http://my-box.example:4096"), type("input[name=password]", "wrong"), click(".connect-form button[type=submit]"), pause(1100), `document.querySelector(".agent-remote-form").scrollIntoView({ block: "end" })`],
    wait: 300,
  },
  {
    name: "connect-progress",
    mock: "connect",
    run: [click("[data-action=remote]"), type("input[name=url]", "http://my-box.example:4096"), type("input[name=password]", "wrong"), click(".connect-form button[type=submit]"), `document.querySelector(".agent-remote-form").scrollIntoView({ block: "end" })`],
    wait: 300,
  },
  // Another computer over ssh: its host typed, connected, the agents installed there.
  {
    name: "connect-ssh",
    mock: "connect",
    run: [type('input[aria-label^="The other computer"]', "me@dev-box"), click("[data-action=ssh]"), pause(1000), `document.querySelector(".connect-ssh").scrollIntoView({ block: "center" })`],
    wait: 300,
  },
  // The second step with an agent on this computer: who will work there, its folders under ~.
  { name: "repo-agent", mock: "repo", query: "&agent=claude" },
  // The panel's top row: the agent (mark, name, the connection's dot) and the repo's path.
  { name: "place-claude", mock: "review", query: "&agent=claude", report: PLACE },
  { name: "place-server", mock: "review", report: PLACE },
  { name: "place-custom", mock: "review", query: "&agent=custom", report: PLACE },
  // The panel at its least, with a long path: cut in the middle, its last folder kept.
  {
    name: "place-narrow",
    mock: "review",
    query: "&agent=claude",
    run: [leastPanel, `window.__mock.state.site.directory = "/home/dev/code/a-rather-long-organisation-name/internal-tools/storefront"; 0`, ...resend],
    wait: 500,
    report: PLACE,
  },
  // The agent's name pressed: the agents and servers to switch to.
  { name: "agent-switch", mock: "review", query: "&agent=claude", run: [click("[data-action=agents]")], wait: 500 },
  { name: "agent-switch-narrow", mock: "review", query: "&agent=claude", run: [leastPanel, pause(200), click("[data-action=agents]")], wait: 500 },
  // The second first-run step: which model conversations start with. Then narrowed by typing,
  // and the same chooser in the settings dialog.
  { name: "model-choice", mock: "model-choice" },
  { name: "model-choice-filter", mock: "model-choice", query: "&previous", run: [type(".model-form input[type=search]", "gpt")], wait: 300, report: `[document.querySelector(".model-form button[type=submit]").textContent, document.querySelector(".connect-lead").textContent]` },
  { name: "model-choice-settings", mock: "review", run: [click("[data-action=settings]"), pause(300), click("[data-action=default-model]")], wait: 500 },
  // The list of conversations (review-menu, below, is the list itself: pinned first, counts of
  // notes): a row's own controls, a name being changed, a delete asked about and the archived.
  // A finished note opened: its pictures, what changed in the code, the verdict. Then the
  // repo's line opened, with the commit message the notes suggest.
  { name: "note-detail", mock: "review", run: [click(".note:nth-of-type(3) .note-main"), pause(300), click(".note-diff-btn")], wait: 500 },
  // A note of another conversation names it at the end of its status line. Then Take back's
  // question, which says the way it will go: the agent asked (its conversation is at work), or
  // an exact undo (the newest message of an idle one).
  {
    name: "note-elsewhere",
    mock: "review",
    run: [`window.__mock.state.review.notes[2].session = "s-3"; 0`, click("[data-action=draw]"), click("[data-action=draw]"), click(".note:nth-of-type(3) .note-main")],
    wait: 400,
    report: `document.querySelector(".note-where").textContent`,
  },
  { name: "note-take-back", mock: "review", run: [click(".note:nth-of-type(3) .note-main"), pause(300), click(".note-undo")], wait: 400, report: `document.querySelector(".note-ask").textContent` },
  { name: "note-take-back-exact", mock: "long", run: [click(".note:nth-of-type(10) .note-main"), pause(300), click(".note-undo")], wait: 400, report: `document.querySelector(".note-ask").textContent` },
  { name: "repo-commit", mock: "review", run: [click(".repo-chip")], wait: 400 },
  { name: "conversations-row", mock: "review", run: [click(".convo-current"), pause(200), `document.querySelectorAll(".menu-main")[1].focus()`], wait: 300 },
  { name: "conversations-rename", mock: "review", run: [click(".convo-current"), pause(200), click(".menu-row:nth-of-type(2) [data-do=rename]")], wait: 300 },
  { name: "conversations-delete", mock: "review", run: [click(".convo-current"), pause(200), click(".menu-row:nth-of-type(3) [data-do=ask-delete]"), pause(100), click(".menu-archived")], wait: 400 },
  { name: "repo", mock: "repo" },
  // What the app asks in the reviewer's name: a line in the chat, and every word of it when opened.
  { name: "ask", mock: "empty", run: [START_SITE], wait: 600 },
  { name: "ask-open", mock: "empty", run: [START_SITE, pause(400), click(".user-ask summary")], wait: 400 },
  { name: "empty", mock: "empty" },
  { name: "running", mock: "review", run: [click('[data-action="running"]')], wait: 500 },
  { name: "switcher", mock: "review", run: [click('[data-action="switcher"]')], wait: 500 },
  // The project's name in the panel under the pointer (made so by hand: a headless window has no
  // :hover), and what it opens.
  { name: "place-folder", mock: "review", run: [`(() => { const b = document.querySelector('[data-action="projects"]'); b.style.background = "var(--surface)"; b.querySelector(".icon").style.opacity = 1 })()`], wait: 300 },
  { name: "place-folder-open", mock: "review", run: [click('[data-action="projects"]')], wait: 500 },
  { name: "switcher-browse", mock: "review", run: [click('[data-action="switcher"]'), pause(300), click(".switcher-rows li:last-child .row")], wait: 600 },
  { name: "folder", mock: "folder" },
  { name: "folder-browse", mock: "folder", run: [click(".folder .folder-actions .btn")], wait: 500 },
  { name: "fresh", mock: "fresh" },
  { name: "review", mock: "review" },
  { name: "review-mac", mock: "review", query: "&platform=darwin" },
  { name: "review-menu", mock: "review", run: [click(".convo-current")] },
  { name: "review-open", mock: "review", run: [`document.querySelectorAll(".transcript details").forEach((d) => (d.open = true))`] },
  { name: "review-narrow", mock: "review", size: [760, 560] },
  // The page as a phone's, with "This page on this phone" beside it (Annotate, then Preview);
  // and a page that fits the phone.
  { name: "phone", mock: "review", query: "&device=phone" },
  { name: "phone-se", mock: "review", query: "&device=phone&phone=iphone-se&mode=preview" },
  // A phone taller than its room (a laptop's window), and the largest phone with the panel shut.
  { name: "phone-short", mock: "review", query: "&device=phone", size: [1280, 720] },
  // A window with no room for all three: the panel and the page, or (Edit, Motion) the page and its dock.
  { name: "phone-narrow", mock: "review", query: "&device=phone", size: [900, 700] },
  { name: "phone-narrow-dock", mock: "review", query: "&device=phone&docks=canvas&mode=edit", size: [900, 700], report: FOOTER },
  // The column at its least (300px, the panel as wide as it goes): the inspector's footer in two
  // rows, the phone line's counts shortened, nothing cut.
  { name: "phone-least-dock", mock: "review", query: "&device=phone&docks=canvas&mode=edit", run: [`document.querySelector(".resizer").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))`], wait: 300, report: FOOTER },
  { name: "phone-least", mock: "review", query: "&device=phone&mode=preview", run: [`document.querySelector(".resizer").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))`], wait: 300, report: PHONE_LINE },
  { name: "phone-max-collapsed", mock: "review", query: "&device=phone&phone=iphone-18-pro-max&mode=preview", run: [click("[data-action=panel]")] },
  { name: "phone-wide", mock: "review", query: "&device=phone&mode=preview", size: [1984, 1276] },
  { name: "phone-clear", mock: "review", query: "&device=phone&mode=preview&facts=clear" },
  { name: "dock", mock: "review", query: "&docks=motion&mode=motion" },
  { name: "phone-dock", mock: "review", query: "&device=phone&docks=canvas&mode=edit", report: FOOTER },
  // The keys list from the footer's "?", inside the inspector's box.
  { name: "phone-dock-keys", mock: "review", query: "&device=phone&docks=canvas&mode=edit", run: [click(".cd-help")], wait: 300, report: `(() => { const k = document.querySelector(".cd-keys").getBoundingClientRect(), b = document.querySelector(".cd").getBoundingClientRect(); return k.top >= b.top && k.bottom <= b.bottom && k.left >= b.left && k.right <= b.right ? "inside the inspector" : "OUTSIDE " + JSON.stringify([k, b]) })()` },
  // Motion's dock drawn by the window: beside a phone's page (the list above what is open), and
  // under the page with its "more" sheet open (inside the dock's box, never over the page).
  { name: "phone-motion-dock", mock: "review", query: "&device=phone&docks=motion&mode=motion" },
  { name: "dock-more", mock: "review", query: "&docks=motion&mode=motion", run: [click('.mdock-hd [aria-label="More"]')], wait: 400 },
  // Under a page in a narrow window: what is open, with a way back to the list.
  { name: "dock-narrow", mock: "review", query: "&docks=motion&mode=motion", size: [1000, 720] },
  // Edit mode's inspector, drawn by the window under a desktop's page (mock-canvas.ts: a card selected).
  { name: "canvas-dock", mock: "review", query: "&docks=canvas&mode=edit", report: FOOTER },
  // …and its footer's list of the unsent edits, opened from the count: inside the inspector too.
  { name: "canvas-dock-edits", mock: "review", query: "&docks=canvas&mode=edit", run: [click(".cd-count")], wait: 300, report: `(() => { const k = document.querySelector(".cd-edits").getBoundingClientRect(), b = document.querySelector(".cd").getBoundingClientRect(); return k.top >= b.top && k.bottom <= b.bottom && k.left >= b.left && k.right <= b.right ? "inside the inspector" : "OUTSIDE " + JSON.stringify([k, b]) })()` },
  { name: "canvas-dock-narrow", mock: "review", query: "&docks=canvas&mode=edit", size: [1000, 720], report: FOOTER },
  { name: "collapsed", mock: "review", run: [click("[data-action=panel]")] },
  { name: "busy", mock: "busy", wait: 1500 },
  { name: "permission", mock: "permission" },
  { name: "question", mock: "question" },
  { name: "noconversation", mock: "noconversation" },
  { name: "offline", mock: "offline" },
  { name: "pageerror", mock: "pageerror" },
  { name: "settings", mock: "review", run: [click("[data-action=settings]")], wait: 500 },
  { name: "settings-servers", mock: "review", run: [click("[data-action=settings]"), pause(300), click(".dialog .disclosure summary")], wait: 500 },
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
  // The context meter: quiet from half full, the warning colour from 80% with its question
  // open, and the bottom row of a sidebar at its narrowest, while the agent works.
  { name: "context", mock: "review", query: "&context=0.62", report: `document.querySelector(".meter").title` },
  { name: "context-rest", mock: "empty", query: "&context=0.62" },
  { name: "context-warn", mock: "review", query: "&context=0.853", run: [click(".meter")], wait: 400, report: `document.querySelector(".meter-pop").textContent` },
  { name: "context-narrow", mock: "busy", query: "&context=0.853", run: [narrowPanel], wait: 1200 },
  { name: "context-narrow-open", mock: "review", query: "&context=0.62", run: [narrowPanel, click(".meter")], wait: 400 },
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
  // A waiting note is in the list only; its own view says so and has its Cancel.
  { name: "note-waiting", mock: "busy", run: [click('.note:has(.badge[data-status="queued"]) .note-main')], wait: 400, report: `[document.querySelectorAll(".user.pending").length, document.querySelector(".note-wait").textContent]` },
  { name: "cancel", mock: "busy", run: [click('.note:has(.badge[data-status="queued"]) .note-main'), pause(300), click(".note-cancel")], wait: 300, report: `document.querySelector(".note-view .note-status").textContent` },
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

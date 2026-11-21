// The app's own requests to the agent (main/asks.ts): what each says, and that the chat can
// read back what it asks in a line.
import assert from "node:assert/strict"
import test from "node:test"
import { commitPrompt, parseAsk, splitTold, startPrompt, takeBackPrompt, toldLine } from "../src/main/asks"

test("startPrompt says what the agent cannot know, and no more", () => {
  const near = startPrompt("", false)
  assert.match(near, /^Get this project's site running so I can review it in bicycle 42\.\n/)
  assert.match(near, /background command of your shell tool/)
  assert.doesNotMatch(near, /another computer|did not answer/)
  assert.match(near, /SITE: <address>$/)
  const far = startPrompt("http://box:4242/", true)
  assert.match(far, /I expected it at http:\/\/box:4242\/, which did not answer\.\n/)
  assert.match(far, /another computer, so localhost will not open/)
  assert.ok(far.split(/\s+/).length < 80, "short: it is the reviewer's message in the conversation")
})

test("commitPrompt carries the message word for word", () => {
  const message = "Tidy the hero\n\n- more air\n----\n- a line of dashes of its own"
  const text = commitPrompt(message)
  assert.ok(text.includes(`\n----\n${message}\n----\n`))
  assert.match(text, /git add -A/)
  assert.match(text, /Do not push, and do not change any file\./)
})

test("parseAsk: what each of the app's requests asks, in a line", () => {
  assert.deepEqual(parseAsk(startPrompt("", false)), { title: "Get the site running" })
  assert.deepEqual(parseAsk(startPrompt("http://box:4242/", true)), { title: "Get the site running" })
  assert.deepEqual(parseAsk(commitPrompt("Tidy the hero\n\n- more air\n----\nmore")), { title: "Commit: Tidy the hero" })
  assert.deepEqual(parseAsk(takeBackPrompt(3, 'make the "CTA" bigger\nand bolder', [])), { title: 'Take back note 3: make the "CTA" bigger' })
  const diff = [{ file: "a.css", patch: "--- a/a.css\n+++ b/a.css\n----\n+x", additions: 1, deletions: 0 }]
  assert.deepEqual(parseAsk(takeBackPrompt(12, "x", diff)), { title: "Take back note 12: x" })
  assert.equal(parseAsk(commitPrompt("a".repeat(300)))!.title.length, "Commit: ".length + 120)
})

test("parseAsk: the requests as they were before they were shortened are still read", () => {
  const start = "Get this project's site running so I can review it in bicycle 42.\nI expected it at http://box:4242/, which did not answer.\n\n- If its dev server is already running, use that."
  assert.deepEqual(parseAsk(start), { title: "Get the site running" })
  const commit = ["Commit the work in this folder with git.", "", "- Stage every change in the working tree, new files included (git add -A).", "- Use exactly this commit message, as it is written between the lines:", "----", "Tidy the hero", "----", "- Do not push, and do not change any file."].join("\n")
  assert.deepEqual(parseAsk(commit), { title: "Commit: Tidy the hero" })
})

test("parseAsk: what the reviewer says is not one of them", () => {
  assert.equal(parseAsk("Commit everything, please"), undefined)
  assert.equal(parseAsk("Can you get this project's site running?"), undefined)
  assert.equal(parseAsk("Take back what you changed for the hero."), undefined)
  assert.equal(parseAsk("UI review note 3 on http://x/, window 1×1 @1x.\nNote: x"), undefined)
  assert.equal(parseAsk(""), undefined)
})

test("the line about notes the app took back names them, and the message after it reads as it would alone", () => {
  const line = toldLine([{ n: 4, text: "and the footer" }, { n: 3, text: "make the header blue" }], 1)
  assert.equal(
    line,
    '(bicycle 42: I took back note 3 ("make the header blue"), note 4 ("and the footer") and what you changed for one other message myself, before this message: those files are as they were before it, though the conversation above still shows the changes. Do not make them again unless I ask.)',
  )
  assert.match(toldLine([], 2), /I took back what you changed for 2 other messages myself/)
  // A typed message: its first line, with the line folded under it.
  assert.deepEqual(splitTold(`${line}\n\nmake it bigger\nand bolder`), { told: line, rest: "make it bigger\nand bolder" })
  assert.deepEqual(parseAsk(`${line}\n\nmake it bigger\nand bolder`), { title: "make it bigger" })
  // A request of the app's: the request.
  assert.deepEqual(parseAsk(`${line}\n\n${commitPrompt("Tighten the header")}`), { title: "Commit: Tighten the header" })
  // A note: not a request (the note is read from what follows the line).
  assert.equal(parseAsk(`${line}\n\nUI review note 5 on http://x/, window 800×600 @1x.\nNote: hi`), undefined)
  // Without the blank line after it, or anywhere but first, it is the reviewer's text.
  assert.deepEqual(splitTold(`${line}\nmore`), { rest: `${line}\nmore` })
  assert.equal(parseAsk(`hello\n\n${line}`), undefined)
})

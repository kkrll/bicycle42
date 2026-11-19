// The browser side of test/markdown.test.ts: bundled for a page and run in Electron, since the
// markdown view needs a real DOM. `window.markdownChecks()` streams replies through the view the
// chat uses and returns what it saw; the Node side asserts on that.
import { closeLinks, markdownView, splitItems } from "../../src/renderer/markdown"

type Check = { name: string; actual: unknown; expected: unknown }

const frame = () => new Promise<void>((r) => setTimeout(r, 0))

/** The text the reply's whole parse gives, as the view draws a finished reply. */
function whole(text: string): HTMLDivElement {
  const root = document.body.appendChild(document.createElement("div"))
  markdownView(root, { text, streaming: false }).paint(true)
  return root
}

/** What a streaming view shows, as one piece of HTML: its blocks unwrapped, the caret left out,
 *  and the newlines marked puts between tags dropped (they are not shown). */
function shown(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement
  copy.querySelector(".md-caret")?.remove()
  const html = copy.querySelector(":scope > div") ? [...copy.children].map((c) => c.innerHTML).join("") : copy.innerHTML
  return html.replace(/>\s+</g, "><").trim()
}

/** Streams `text` in pieces of 1 to 4 characters, painting after each, then finishes it. With
 *  `exact`, every frame must show what parsing the text so far whole shows (a tight list or a
 *  table, where the item-by-item drawing must never differ from the whole parse). */
function stream(name: string, text: string, exact: boolean, out: Check[]): void {
  const root = document.body.appendChild(document.createElement("div"))
  const props = { text: "", streaming: true }
  const view = markdownView(root, props)
  view.paint(true)
  const wrong: string[] = []
  for (let at = 0, step = 0; at < text.length; step++) {
    at = Math.min(text.length, at + 1 + (step % 4))
    props.text = text.slice(0, at)
    view.paint()
    if (exact && wrong.length < 3) {
      const ref = whole(closeLinks(props.text))
      const want = shown(ref)
      ref.remove()
      const got = shown(root)
      if (got !== want)
        wrong.push(`at ${at} (${JSON.stringify(props.text.slice(-24))}):\n  got  ${got}\n  want ${want}`)
    }
  }
  if (exact) out.push({ name: `${name}: every frame while it streams`, actual: wrong, expected: [] })
  props.streaming = false
  view.paint()
  const ref = whole(text)
  out.push({ name: `${name}: once it is done`, actual: root.innerHTML, expected: ref.innerHTML })
  ref.remove()
  root.remove()
}

const items = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join("\n")

async function checks(): Promise<Check[]> {
  const out: Check[] = []

  // ── where the items split ──
  const kinds = (text: string) => {
    const s = splitItems(text, 0)
    return s && { kind: s.kind, live: text.slice(s.live) }
  }
  out.push({
    name: "split: a tight list",
    actual: kinds("- a\n- b\n- c"),
    expected: { kind: "list", live: "- b\n- c" },
  })
  out.push({
    name: "split: an item's indented lines stay with it",
    actual: kinds("- a\n  - a1\n- b\n  more\n"),
    expected: { kind: "list", live: "- b\n  more\n" },
  })
  out.push({ name: "split: another bullet is another list", actual: kinds("- a\n* b\n"), expected: undefined })
  out.push({ name: "split: a blank line with more after it", actual: kinds("- a\n\n  b\n- c\n"), expected: undefined })
  out.push({ name: "split: a rule is not an item", actual: kinds("- a\n- - -\n"), expected: undefined })
  out.push({
    name: "split: a table's rows",
    actual: kinds("| a | b |\n|---|---|\n| 1 | 2 |\n| 3"),
    expected: { kind: "table", live: "| 3" },
  })
  out.push({
    name: "split: a line without a pipe under a table",
    actual: kinds("| a | b |\n|---|---|\n| 1 | 2 |\nmore\n"),
    expected: undefined,
  })
  out.push({ name: "split: a paragraph", actual: kinds("Some words\n- a\n"), expected: undefined })

  // ── streamed, frame by frame, against the whole parse ──
  const list = items(
    24,
    (i) => `- \`src/Thing${i}.tsx\` uses **padding ${i}px** where the grid says [${i + 4}px](https://example.com/${i})`,
  )
  stream("a tight list", `Here is what I found:\n\n${list}\n\nThat is all.`, true, out)
  stream("a tight list with no end", list, true, out)
  stream(
    "nested lists",
    `- one\n  - one a\n  - one b\n    1. deep\n    2. deeper\n- two\n  continued on an indented line\n- three\n  * other bullet inside\n- [ ] a task\n- [x] done`,
    true,
    out,
  )
  stream(
    "an ordered list with a start number",
    items(18, (i) => `${i + 7}. step ${i + 7}, *with* \`code\``),
    true,
    out,
  )
  stream(
    "an ordered list with parentheses",
    items(12, (i) => `${i + 1}) item ${i}`),
    true,
    out,
  )
  stream(
    "a table",
    `The audit:\n\n| File | Before | After |\n|:---|:---:|---:|\n${items(20, (i) => `| \`src/Thing${i}.tsx\` | ${i}px | **${i + 4}px** |`)}\n\nDone.`,
    true,
    out,
  )
  stream("a table with short and long rows", `| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n| x \\| y | z |`, true, out)
  // A blank line between items makes the whole list loose; while it streams the blocks are
  // drawn apart, and the whole parse at the end puts it right.
  stream(
    "a list that turns out loose",
    `- first\n- second\n- third\n\n- fourth, after a blank line\n- fifth`,
    false,
    out,
  )
  stream("a list loose inside an item", `- first\n- second\n\n  its second paragraph\n- third\n- fourth`, false, out)
  stream("a list then a heading", `- a\n- b\n# Heading\n- c\n- d`, false, out)
  stream("a list then a paragraph", `- a\n- b\nlazy line\n- c\n\nAfter.`, false, out)
  stream("a list with code", "- a\n- b:\n  ```ts\n  const x = 1\n  ```\n- c\n\n```js\nlet y\n```\n- d", false, out)
  stream("a list, a table, a list", `- a\n- b\n\n| h | i |\n|---|---|\n| 1 | 2 |\n\n1. x\n2. y`, false, out)

  // ── the reader's selection ──
  {
    const root = document.body.appendChild(document.createElement("div"))
    const props = { text: "First paragraph, finished.\n\nSecond, still", streaming: true }
    const view = markdownView(root, props)
    view.paint(true)
    const words = root.querySelector("p")!.firstChild!
    const range = document.createRange()
    range.setStart(words, 0)
    range.setEnd(words, 5)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    await frame() // selectionchange is a task of its own
    const before = root.innerHTML
    props.text += " arriving"
    view.paint()
    out.push({
      name: "selection: a paint waits while the reader has text selected here",
      actual: root.innerHTML === before && getSelection()!.toString(),
      expected: "First",
    })
    getSelection()!.removeAllRanges()
    await frame()
    await new Promise((r) => requestAnimationFrame(r))
    await frame()
    out.push({
      name: "selection: and draws once it goes",
      actual: root.textContent!.includes("still arriving"),
      expected: true,
    })
    view.dispose()
    root.remove()
  }
  return out
}

;(window as unknown as { markdownChecks: typeof checks }).markdownChecks = checks

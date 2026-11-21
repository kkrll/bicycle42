// A file's change as a unified diff, from its text before and after. An ACP agent says what an
// edit does as the old and the new text of the file (a "diff" tool content); the chat, a
// permission's card and a note's diff show patches, as OpenCode sends them.
import type { FileChange } from "../shared/types"

/** Lines of context around each change, as OpenCode's own diffs have. */
const CONTEXT = 3
/** Past this many cells the table of common lines is not worth making: the change is shown as
 *  the whole old text out and the whole new text in. (A 2000-line file against itself.) */
const TABLE_MAX = 4_000_000

const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"))

type Op = { kind: " " | "-" | "+"; text: string; a: number; b: number }

/** The edit script from `a` to `b`, by the longest common subsequence of their lines, with the
 *  same lines at both ends taken off first (an edit is mostly a few lines in a long file). */
function script(a: string[], b: string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const ops: Op[] = []
  for (let i = 0; i < head; i++) ops.push({ kind: " ", text: a[i]!, a: i, b: i })
  if ((x.length + 1) * (y.length + 1) > TABLE_MAX) {
    x.forEach((text, i) => ops.push({ kind: "-", text, a: head + i, b: head }))
    y.forEach((text, i) => ops.push({ kind: "+", text, a: head + x.length, b: head + i }))
  } else {
    // lcs[i][j]: the longest common subsequence of x[i..] and y[j..].
    const w = y.length + 1
    const lcs = new Uint32Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
    let i = 0
    let j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) ops.push({ kind: " ", text: x[i]!, a: head + i++, b: head + j++ })
      // What goes out before what comes in, as diff writes it.
      else if (i < x.length && (j === y.length || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) ops.push({ kind: "-", text: x[i]!, a: head + i++, b: head + j })
      else ops.push({ kind: "+", text: y[j]!, a: head + i, b: head + j++ })
    }
  }
  for (let i = 0; i < tail; i++) ops.push({ kind: " ", text: a[a.length - tail + i]!, a: a.length - tail + i, b: b.length - tail + i })
  return ops
}

/** `file` as the chat names it (relative to the conversation's folder when it is inside). A new
 *  file has no old text. */
export function unifiedPatch(file: string, before: string | null | undefined, after: string): FileChange {
  const ops = script(lines(before ?? ""), lines(after))
  const out = [`--- ${before == null ? "/dev/null" : `a/${file}`}`, `+++ b/${file}`]
  let additions = 0
  let deletions = 0
  // Hunks: each change with up to CONTEXT unchanged lines around it, nearby ones joined.
  const changed = ops.flatMap((op, i) => (op.kind === " " ? [] : [i]))
  let k = 0
  while (k < changed.length) {
    const from = Math.max(0, changed[k]! - CONTEXT)
    let to = changed[k]!
    while (k + 1 < changed.length && changed[k + 1]! - to <= 2 * CONTEXT) to = changed[++k]!
    k++
    const end = Math.min(ops.length, to + CONTEXT + 1)
    const hunk = ops.slice(from, end)
    const oldLen = hunk.filter((o) => o.kind !== "+").length
    const newLen = hunk.filter((o) => o.kind !== "-").length
    const first = hunk[0]!
    out.push(`@@ -${oldLen ? first.a + 1 : first.a},${oldLen} +${newLen ? first.b + 1 : first.b},${newLen} @@`)
    for (const o of hunk) {
      if (o.kind === "+") additions++
      if (o.kind === "-") deletions++
      out.push(o.kind + o.text)
    }
  }
  return { file, patch: out.join("\n"), additions, deletions }
}

// What the app itself asks the agent, in the reviewer's name: to get the site running, to commit,
// to take a note back; and what it tells the agent before the reviewer's next message, when it
// took a note back by itself. Each is a message in the conversation like any other, so the chat would
// show all of it as if the reviewer had typed it: `parseAsk` reads back what one asks in a line,
// and the chat shows that line, with the whole text folded under it (ChatUser.ask). A review
// note's prompt is overlay/prompt.js, read back by `parseNote` (opencode.ts).

import type { FileChange } from "../shared/types"

/** A line for the chat, of the first line of something longer. */
const head = (s: string, max = 120) => {
  const line = s.trim().split("\n", 1)[0]!.trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// ── the site ────────────────────────────────────────────────────────────────────────────────────

/** How the request to get the site running starts, in every version of it. */
const START_PROMPT = "Get this project's site running so I can review it in bicycle 42."

/** What the agent is asked when the reviewer has a repo and no running site. It says only what
 *  the agent cannot know: that what it starts as a background command of its shell tool ends
 *  with this session (ACP gives the app no way to list or stop it, and a detached process would
 *  outlive the agent), and the line the app reads the address from (SITE_LINE in core.ts). An
 *  agent on another computer serves on its own localhost, which the app forwards here, so it is
 *  not told where the app is. `failed` is an address that did not answer. */
export function startPrompt(failed: string) {
  return [
    [START_PROMPT, ...(failed ? [`I expected it at ${failed}, which did not answer.`] : [])].join(" "),
    "",
    "Run it as a background command of your shell tool (not nohup, & or tmux), so it ends when this session does.",
    "",
    "When it answers, end your reply with one line: SITE: <address>",
  ].join("\n")
}

// ── a commit ────────────────────────────────────────────────────────────────────────────────────

const RULE = "----"
/** (The second is how it started before it was shortened: conversations that have it are still read.) */
const COMMIT_HEAD = /^Commit (everything in this folder \(|the work in this folder with git\.$)/

/** What the agent is asked for a commit. The message is the reviewer's, word for word. */
export function commitPrompt(message: string) {
  return [
    "Commit everything in this folder (git add -A, new files too) with exactly this message, as it is written between the lines:",
    RULE,
    message,
    RULE,
    "Do not push, and do not change any file. Reply with the commit's short hash and its subject, or with what stopped you.",
  ].join("\n")
}

// ── a note taken back ───────────────────────────────────────────────────────────────────────────

const DIFF_IN_PROMPT_MAX = 20_000
const TAKE_BACK_HEAD = /^Take back what you changed for UI review note (\d+): (".*")\.$/

/** What the agent is asked when a note that is not the newest message is taken back. */
export function takeBackPrompt(n: number, text: string, diff: FileChange[]) {
  const patch = diff.map((f) => f.patch).join("\n")
  return [
    `Take back what you changed for UI review note ${n}: ${JSON.stringify(text)}.`,
    "",
    "- Put the code back to how it was before that note, and only that: leave every other change, earlier or later, as it is.",
    "- If something done since depends on it, say so instead of breaking it.",
    ...(patch
      ? [
          "",
          "For reference, the diff of the turn that note was part of. Notes that waited together share a turn, so it may hold other notes' changes too:",
          "```diff",
          patch.length > DIFF_IN_PROMPT_MAX ? `${patch.slice(0, DIFF_IN_PROMPT_MAX)}\n… (cut)` : patch,
          "```",
        ]
      : []),
  ].join("\n")
}

// ── a note the app took back by itself ──────────────────────────────────────────────────────────
// The app reverses a note's files from its own snapshots (snapshots.ts) without the agent, and
// the conversation still has the note and the agent's changes in it. So the next message to that
// conversation, whatever it is, starts with a line that says so, and a blank line.

const TOLD = /^\(bicycle 42: I took back .*\)$/

/** The line put before the next message: the notes taken back (number and words) and how many
 *  other turns of the agent's (a typed message's, from /undo or a checkpoint). */
export function toldLine(notes: Array<{ n: number; text: string }>, others: number) {
  const what = [
    ...[...notes].sort((a, b) => a.n - b.n).map((x) => `note ${x.n} (${JSON.stringify(head(x.text, 60))})`),
    ...(others ? [others === 1 ? "what you changed for one other message" : `what you changed for ${others} other messages`] : []),
  ]
  const list = what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : (what[0] ?? "some of your changes")
  return `(bicycle 42: I took back ${list} myself, before this message: those files are as they were before it, though the conversation above still shows the changes. Do not make them again unless I ask.)`
}

/** A message with the line in front, and without it. The line alone is a message too: sent
 *  before a summary or an agent's own command, which can't carry it. */
export function splitTold(text: string): { told?: string; rest: string } {
  const lines = text.split("\n")
  if (lines.length === 1 && TOLD.test(text)) return { told: text, rest: "" }
  if (!TOLD.test(lines[0] ?? "") || lines[1] !== "") return { rest: text }
  return { told: lines[0]!, rest: lines.slice(2).join("\n") }
}

/** How a review note's prompt starts (overlay/prompt.js; `parseNote` in opencode.ts reads it). */
const NOTE_START = /^UI review note \d+ on /

// ── reading them back ───────────────────────────────────────────────────────────────────────────

/** What a message asks, in a line, when it is one of the app's own requests. */
export function parseAsk(text: string): { title: string } | undefined {
  // The line about a note the app took back: what follows is what this message is. A note shows
  // as the note; a typed message by its first line, with the line folded under it.
  const told = splitTold(text)
  if (told.told && !told.rest) return { title: "Told the agent what was taken back" }
  if (told.told) return NOTE_START.test(told.rest) ? undefined : (parseAsk(told.rest) ?? { title: head(told.rest) || "Note taken back" })
  const lines = text.split("\n")
  const first = lines[0] ?? ""
  if (first.startsWith(START_PROMPT)) return { title: "Get the site running" }
  if (COMMIT_HEAD.test(first)) {
    const from = lines.indexOf(RULE)
    const to = lines.lastIndexOf(RULE)
    if (from < 0 || to <= from) return undefined
    const message = head(lines.slice(from + 1, to).join("\n"))
    return { title: message ? `Commit: ${message}` : "Commit" }
  }
  const back = TAKE_BACK_HEAD.exec(first)
  if (back) {
    let words = ""
    try {
      words = head(String(JSON.parse(back[2]!)))
    } catch {
      // Not what takeBackPrompt writes: the number is enough.
    }
    return { title: `Take back note ${back[1]}${words ? `: ${words}` : ""}` }
  }
  return undefined
}

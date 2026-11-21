// What the app itself asks the agent, in the reviewer's name: to get the site running, to commit,
// to take a note back. Each is a message in the conversation like any other, so the chat would
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
 *  the agent cannot know: that the app stops what runs through the server's shell (a detached
 *  process is not there, see `refreshRunning` in core.ts), that localhost does not open on
 *  another computer (`remote`), and the line the app reads the address from (SITE_LINE in
 *  core.ts). `failed` is an address that did not answer. `stoppable`: the app can list and stop
 *  what the agent's shell runs (an OpenCode server); an ACP agent's background command can't be
 *  seen from here, and ends with the agent's process, so that is what is said instead. */
export function startPrompt(failed: string, remote: boolean, stoppable = true) {
  return [
    [START_PROMPT, ...(failed ? [`I expected it at ${failed}, which did not answer.`] : [])].join(" "),
    "",
    [
      `Run it as a background command of your shell tool (not nohup, & or tmux), ${stoppable ? "so I can stop it from here" : "so it ends when this session does"}.`,
      ...(remote ? ["I am on another computer, so localhost will not open: bind it to the network, and ask before a tunnel makes it public."] : []),
    ].join(" "),
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

// ── reading them back ───────────────────────────────────────────────────────────────────────────

/** What a message asks, in a line, when it is one of the app's own requests. */
export function parseAsk(text: string): { title: string } | undefined {
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

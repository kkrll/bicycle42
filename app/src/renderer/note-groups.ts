// Which group of the notes list a note sits in (panel.tsx). Kept apart from the panel, which
// needs a DOM, so a plain Node test can check it.
import type { NoteRow } from "../shared/types"

/** The list is sorted by what a note needs, most urgent first. Finished ones (done, or taken
 *  back) fold into one line. "Working" is only what the agent has (one note at a time, and any
 *  in the background); a note still being captured or sent waits with the queued ones. */
export type Group = "needs" | "working" | "waiting" | "done"
export const GROUPS: Array<{ key: Group; name: string }> = [
  { key: "needs", name: "Needs you" },
  { key: "working", name: "Working" },
  { key: "waiting", name: "Waiting" },
  { key: "done", name: "Done" },
]
export const groupOf = (note: NoteRow): Group =>
  note.takenBack || note.status === "done" ? "done" : note.status === "failed" ? "needs" : note.status === "working" ? "working" : "waiting"

/** The group's name. While the agent can't be reached and works nowhere else meanwhile, what it
 *  had is paused, and its group says so (its rows then need no word of their own). */
export const groupName = (key: Group, paused: boolean): string =>
  key === "working" && paused ? "Paused" : GROUPS.find((g) => g.key === key)!.name

/** Whether a row prints its state's word: not where its group says it (waiting, working, paused,
 *  done), nor for a failed note, whose red badge and error line say it. "Stopped" is not a
 *  failure, and capturing and sending wait among the queued: those keep theirs. */
export const rowSaysWord = (shown: string, takenBack: boolean): boolean =>
  takenBack || !["queued", "working", "paused", "done", "failed"].includes(shown)

/** The short counts ("1 failed · 8 left") in `room` px, about 6.4 px a character at 12 px: what
 *  is left goes first, being the least to act on (the list says it), so nothing beside them is
 *  cut. What still does not fit is clipped whole by the header's CSS. */
export function fitShort(short: string, room: number): string[] {
  const parts = short ? short.split(" · ") : []
  const fits = (p: string[]) => p.join(" · ").length * 6.4 <= room
  if (fits(parts)) return parts
  return parts.filter((p) => !p.endsWith(" left"))
}

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

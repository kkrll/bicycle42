// A note's pictures on disk: the area as it was when the note was made ("before") and the same
// area once the agent was done ("after"). They are not in the review file, which is read whole
// and written on every change; a picture is read when the note is looked at.
//
//   <dir>/shots/<hash of the note's id>-before.jpg | -after.jpg
//
// The id is the page's own word, so it never becomes a file name itself.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type Which = "before" | "after"
export type Shots = {
  /** `uri` is a JPEG data URI. False when it could not be written. */
  save(id: string, which: Which, uri: string): boolean
  /** Data URIs of the pictures there are. */
  read(id: string): { before?: string; after?: string }
  drop(id: string): void
}

const PREFIX = "data:image/jpeg;base64,"

export function createShots(dir: string, log: (level: "warn", msg: string, data?: unknown) => void = () => undefined): Shots {
  const folder = path.join(dir, "shots")
  const file = (id: string, which: Which) => path.join(folder, `${crypto.createHash("sha1").update(id).digest("hex")}-${which}.jpg`)
  return {
    save(id, which, uri) {
      if (!uri.startsWith(PREFIX)) return false
      try {
        fs.mkdirSync(folder, { recursive: true })
        fs.writeFileSync(file(id, which), Buffer.from(uri.slice(PREFIX.length), "base64"))
        return true
      } catch (err) {
        log("warn", "can't save a note's picture", String(err))
        return false
      }
    },
    read(id) {
      const out: { before?: string; after?: string } = {}
      for (const which of ["before", "after"] as const) {
        try {
          out[which] = PREFIX + fs.readFileSync(file(id, which)).toString("base64")
        } catch {
          // none taken
        }
      }
      return out
    },
    drop(id) {
      for (const which of ["before", "after"] as const) fs.rmSync(file(id, which), { force: true })
    },
  }
}

// A note's pictures on disk: the area as it was when the note was made ("before") and the same
// area once the agent was done ("after"). They are not in the review file, which is read whole
// and written on every change; a picture is read when the note is looked at.
//
//   <dir>/shots/<hash of the note's id>-before.jpg | -after.jpg
//
// The id is the page's own word, so it never becomes a file name itself. Writes go off the main
// thread, one at a time per note, so a picture dropped while it is being written stays dropped.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createQueue } from "./queue"

export type Which = "before" | "after"
export type Shots = {
  /** `uri` is a JPEG data URI. Resolves false when it could not be written. */
  save(id: string, which: Which, uri: string): Promise<boolean>
  /** Data URIs of the pictures there are. */
  read(id: string): Promise<{ before?: string; after?: string }>
  /** One picture's JPEG bytes, or undefined when there is none. */
  bytes(id: string, which: Which): Promise<Buffer | undefined>
  drop(id: string): Promise<void>
  /** Resolves when everything asked so far is done. */
  idle(): Promise<void>
}

const PREFIX = "data:image/jpeg;base64,"

export function createShots(
  dir: string,
  log: (level: "warn", msg: string, data?: unknown) => void = () => undefined,
): Shots {
  const folder = path.join(dir, "shots")
  const file = (id: string, which: Which) =>
    path.join(folder, `${crypto.createHash("sha1").update(id).digest("hex")}-${which}.jpg`)
  const queue = createQueue()
  return {
    save(id, which, uri) {
      if (!uri.startsWith(PREFIX)) return Promise.resolve(false)
      const bytes = Buffer.from(uri.slice(PREFIX.length), "base64")
      return queue.run(id, async () => {
        try {
          await fs.promises.mkdir(folder, { recursive: true })
          await fs.promises.writeFile(file(id, which), bytes)
          return true
        } catch (err) {
          log("warn", "can't save a note's picture", String(err))
          return false
        }
      })
    },
    read(id) {
      return queue.run(id, async () => {
        const out: { before?: string; after?: string } = {}
        for (const which of ["before", "after"] as const) {
          // None taken, when it is not there.
          const bytes = await fs.promises.readFile(file(id, which)).catch(() => undefined)
          if (bytes) out[which] = PREFIX + bytes.toString("base64")
        }
        return out
      })
    },
    bytes(id, which) {
      return queue.run(id, () => fs.promises.readFile(file(id, which)).catch(() => undefined))
    },
    drop(id) {
      return queue.run(id, async () => {
        for (const which of ["before", "after"] as const)
          await fs.promises.rm(file(id, which), { force: true }).catch(() => undefined)
      })
    },
    idle: () => queue.idle(),
  }
}

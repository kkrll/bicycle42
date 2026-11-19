// What a note sends to the agent (its prompt and its pictures), on disk until the note is done.
// A note waits in the app while the agent is on another one, and a failed one can be sent again:
// both must still have their pictures after the app is restarted.
//
//   <dir>/outbox/<hash of the note's id>.json
//
// The id is the page's own word, so it never becomes a file name itself. The files are written
// off the main thread, one operation at a time per note and in the order asked: a read waits for
// the write before it, and a note dropped while its file is being written has no file after.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { PromptFile } from "../shared/types"
import { createQueue } from "./queue"

/** `id` is the message id the server knows it by, once it has been tried: a second try with the
 *  same id cannot queue the note twice. */
export type Outgoing = { text: string; files: PromptFile[]; id?: string }
export type Outbox = {
  /** Resolves once it is on disk: true, or false when it could not be written (the note still
   *  goes from memory). */
  save(id: string, payload: Outgoing): Promise<boolean>
  read(id: string): Promise<Outgoing | undefined>
  drop(id: string): Promise<void>
  /** Resolves when everything asked so far is done. */
  idle(): Promise<void>
}

export function createOutbox(
  dir: string,
  log: (level: "warn", msg: string, data?: unknown) => void = () => undefined,
): Outbox {
  const folder = path.join(dir, "outbox")
  const file = (id: string) => path.join(folder, `${crypto.createHash("sha1").update(id).digest("hex")}.json`)
  const queue = createQueue()
  return {
    save(id, payload) {
      // What is written is the payload as it is now, whatever happens to the object meanwhile.
      const text = JSON.stringify(payload)
      return queue.run(id, async () => {
        try {
          await fs.promises.mkdir(folder, { recursive: true })
          // Whole or not at all: a quit or a crash mid-write leaves the file it replaces.
          const tmp = `${file(id)}.tmp`
          await fs.promises.writeFile(tmp, text)
          await fs.promises.rename(tmp, file(id))
          return true
        } catch (err) {
          log("warn", "can't save what a note sends", String(err))
          return false
        }
      })
    },
    read(id) {
      return queue.run(id, async () => {
        try {
          const raw: unknown = JSON.parse(await fs.promises.readFile(file(id), "utf8"))
          if (typeof raw !== "object" || raw === null) return undefined
          const { text, files, id: message } = raw as Record<string, unknown>
          if (typeof text !== "string" || !Array.isArray(files)) return undefined
          return { text, files: files as PromptFile[], ...(typeof message === "string" ? { id: message } : {}) }
        } catch {
          return undefined
        }
      })
    },
    drop(id) {
      return queue.run(id, () => fs.promises.rm(file(id), { force: true }).catch(() => undefined))
    },
    idle: () => queue.idle(),
  }
}

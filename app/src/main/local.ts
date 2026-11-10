// The OpenCode server on this computer, if one is running.
//
// OpenCode's background service writes where it listens, and its password, to a registration
// file in the user's state folder; its own clients (the TUI, Desktop) find it the same way. This
// reads that file and nothing else: it starts no server and changes nothing.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type LocalServer = { url: string; password: string }

export function registrationFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "opencode", "service.json")
}

/** The registered server, or undefined when there is none or the file is not one we understand.
 *  A registration can outlive its server; whether it answers is for the caller to find out. */
export function readLocal(file = registrationFile()): LocalServer | undefined {
  let data: unknown
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return
  }
  if (typeof data !== "object" || data === null) return
  const { url, password } = data as Record<string, unknown>
  if (typeof url !== "string" || (password !== undefined && typeof password !== "string")) return
  try {
    const u = new URL(url)
    if (u.protocol !== "http:" && u.protocol !== "https:") return
  } catch {
    return
  }
  return { url, password: password ?? "" }
}

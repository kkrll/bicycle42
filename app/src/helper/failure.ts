// Why the helper could not start, as a sentence for the reviewer: what the daemon prints after
// "B42 FAILED <code>", which the app shows as it is (src/main/ssh.ts). Never node's own last line
// ("Node.js v22.12.0") or a stack: a code the reviewer can look up, and what to do about it.

/** The longest path a unix socket may have (sun_path, less its closing NUL): 104 bytes on macOS
 *  and the BSDs, 108 on Linux. */
export const socketMax = (platform: NodeJS.Platform) => (platform === "linux" ? 107 : 103)

/** A sentence for a socket path that is too long, or undefined when it fits. */
export function socketTooLong(socket: string, platform: NodeJS.Platform): string | undefined {
  const n = Buffer.byteLength(socket)
  const max = socketMax(platform)
  if (n <= max) return undefined
  return `its socket would be ${socket}, ${n} bytes, and a socket's path may be ${max} at most on this system: the home folder's path is too long for it.`
}

/** "B42 FAILED <code> <sentence>": `what` is the step ("can't write ~/.bicycle42/helper.log"). */
export function failure(err: unknown, what: string): { code: string; sentence: string } {
  const e = err as NodeJS.ErrnoException
  const code = typeof e?.code === "string" && /^[A-Z0-9_]+$/.test(e.code) ? e.code : "ERROR"
  const why: Record<string, string> = {
    EACCES: "permission denied: ~/.bicycle42 there, or the home folder, is not writable by this user (its owner or its permissions were changed)",
    EPERM: "not permitted: ~/.bicycle42 there, or the home folder, is not writable by this user (its owner or its permissions were changed)",
    EROFS: "the home folder there is on a read-only file system",
    ENOSPC: "the disk there is full",
    EDQUOT: "this user's disk quota there is used up",
    ENAMETOOLONG: "a path there is too long",
    EMFILE: "this user has too many files open there",
    ENFILE: "the computer has too many files open",
    EAGAIN: "the computer would not start another process for this user (a process limit)",
    ENOMEM: "the computer is out of memory",
  }
  const said = why[code] ?? (e?.message ? String(e.message).split("\n")[0]!.replace(/^Error: /, "") : String(err))
  return { code, sentence: `${what}: ${said}.` }
}

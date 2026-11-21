// The wire between the app and its helper on another computer (src/main/ssh.ts ⇄ src/helper/
// helper.ts): one JSON message per line, both ways. What both ends must agree on is here, so the
// helper's bundle and the app read and write lines the same way.
//
// Lines are split on the newline byte (0x0A) in the bytes as they come, and each line is decoded
// as UTF-8 only once it is whole: a character of two to four bytes that a read splits in two is
// never read as two halves (each a U+FFFD). In UTF-8 a byte 0x0A is only ever a newline, never part
// of another character, so splitting the bytes first is exact.

/** What the helper speaks. `hello` answers it; an app that finds another number refuses that helper
 *  with a sentence. Raised whenever a call, its params or what it answers changes meaning. */
export const PROTOCOL = 1

/** The longest line either end takes, in bytes. The largest lines that are meant are a command's
 *  output in `run`'s answer (git at up to 16 MiB in acp.ts, up to 32 MiB of an agent's own CLI in
 *  model-facts.ts, which JSON's escapes can make longer still), a file read or written whole, and a
 *  piece of the agent's stdin (at most WRITE_CHUNK, as base64). 64 MiB takes those with room, and
 *  bounds what a computer that sends bytes with no newline (or a link that went bad) can make the
 *  other end hold: one line's bytes, at most, before the link is dropped with a sentence. */
export const LINE_MAX = 64 * 1024 * 1024

/** The most of the agent's stdin one `write` carries (bytes, before base64): what waits is sent
 *  joined into writes of this size at most. 4 MiB is a screenshot or two in a prompt. */
export const WRITE_CHUNK = 4 * 1024 * 1024

/** "64 MiB", "200 KB": a size in a sentence. */
export const sizeOf = (n: number) => (n >= 1024 * 1024 ? `${Math.round((n / 1024 / 1024) * 10) / 10} MiB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`)

/** Reads lines out of the bytes of a stream, however they are cut. `line` gets each whole line,
 *  decoded, without its newline (and without a "\r" before it); blank lines are skipped. A line
 *  longer than `max` bytes calls `tooLong` once, and nothing more is read: the caller drops the
 *  link, since what follows can't be told apart from the rest of that line. */
export function lineReader(o: { max?: number; line(text: string): void; tooLong(bytes: number): void }) {
  const max = o.max ?? LINE_MAX
  /** The pieces of the line not yet ended, and their length. */
  let parts: Buffer[] = []
  let size = 0
  let over = false
  const emit = (b: Buffer) => {
    let end = b.length
    if (end && b[end - 1] === 0x0d) end--
    const text = b.toString("utf8", 0, end)
    if (text.trim()) o.line(text)
  }
  /** Too long: what is held goes, and so does all that comes after. */
  const over_ = (bytes: number) => {
    reader.stop()
    o.tooLong(bytes)
  }
  const reader = {
    push(chunk: Buffer) {
      if (over) return
      let from = 0
      for (let nl = chunk.indexOf(0x0a); nl >= 0; nl = chunk.indexOf(0x0a, from)) {
        const piece = chunk.subarray(from, nl)
        if (size + piece.length > max) return over_(size + piece.length)
        emit(parts.length ? Buffer.concat([...parts, piece]) : piece)
        parts = []
        size = 0
        from = nl + 1
        // A line's handler may have ended the link.
        if (over) return
      }
      if (from < chunk.length) {
        const rest = chunk.subarray(from)
        if (size + rest.length > max) return over_(size + rest.length)
        // Kept as a copy: the stream may reuse its buffer.
        parts.push(Buffer.from(rest))
        size += rest.length
      }
    },
    /** Stops reading: what is held, and what comes after, is let go. */
    stop() {
      over = true
      parts = []
      size = 0
    },
    /** Bytes held for a line not yet ended. */
    get pending() {
      return size
    },
  }
  return reader
}

// The pictures of a conversation, served to the window by address instead of carried in it.
//
// A message's screenshots arrive from the server as base64 inside the message list. Sent on to
// the window as data URLs they made every re-read of a conversation tens of megabytes to clone
// (150 notes: 49 MB, 84–100 ms), and the window kept them all. Now each picture is named by an
// address, `b42-img://pic/<conversation>/<message>/<file>`, and the window's <img> asks for it
// here (`protocol.handle` in index.ts, the app window's session only: the page under review
// cannot reach it). The bytes come from the note's own picture on disk when the app has it, else
// from the base64 the message list brought, decoded once and kept in a bounded cache, else from
// the server again (one message).
//
// No electron: the handler takes a URL and answers a Response, so it is tested in plain Node.

export const SCHEME = "b42-img"
const HOST = "pic"

/** Where a picture is: the conversation, the message (or queued item), and the file's place in
 *  the message's list of files. */
export type PictureSource = { session: string; message: string; file: number }
/** A picture as the server sends it. */
export type Wire = { mime: string; data: string }

export type Pictures = {
  /** The address the window shows the picture by. `data` (base64), when given, is kept a while,
   *  so showing it needs no trip to the server. */
  name(src: PictureSource, mime: string, data?: string): string
  /** The answer to a request for an address; anything not named here is refused. */
  serve(url: string): Promise<Response>
  /** Forgets everything (another server: its conversations are not these). */
  clear(): void
}

type Options = {
  /** The picture from the server, again. */
  fetch(src: PictureSource): Promise<Wire | undefined>
  /** The picture from the app's own files, when it has it. */
  local?(src: PictureSource): Promise<Buffer | undefined>
  /** Bytes of pictures kept in memory, decoded or not. */
  maxBytes?: number
  /** Addresses remembered. Each is a few dozen bytes; the oldest are forgotten first. */
  maxKnown?: number
}

const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/

const keyOf = (src: PictureSource) =>
  `${encodeURIComponent(src.session)}/${encodeURIComponent(src.message)}/${src.file}`

export function createPictures(opts: Options): Pictures {
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024
  const maxKnown = opts.maxKnown ?? 20_000
  /** Every address handed out, oldest first: what it is and its type. */
  const known = new Map<string, { src: PictureSource; mime: string }>()
  /** The bytes, least recently used first: base64 until first shown, then decoded. */
  const cache = new Map<string, string | Buffer>()
  let bytes = 0
  /** Requests under way, so two looks at one picture make one trip. */
  const loading = new Map<string, Promise<Buffer | undefined>>()

  const size = (v: string | Buffer) => v.length
  function keep(key: string, value: string | Buffer) {
    const old = cache.get(key)
    if (old !== undefined) ((bytes -= size(old)), cache.delete(key))
    if (size(value) > maxBytes) return
    cache.set(key, value)
    bytes += size(value)
    for (const [k, v] of cache) {
      if (bytes <= maxBytes) break
      cache.delete(k)
      bytes -= size(v)
    }
  }

  async function load(key: string, src: PictureSource): Promise<Buffer | undefined> {
    const local = await opts.local?.(src).catch(() => undefined)
    if (local) return local
    const wire = await opts.fetch(src).catch(() => undefined)
    if (!wire || !IMAGE_MIME.test(wire.mime)) return undefined
    const buffer = Buffer.from(wire.data, "base64")
    if (known.has(key)) keep(key, buffer)
    return buffer
  }

  const refuse = (status: number) => new Response(null, { status })

  return {
    name(src, mime, data) {
      const key = keyOf(src)
      known.delete(key)
      known.set(key, { src, mime })
      for (const k of known.keys()) {
        if (known.size <= maxKnown) break
        known.delete(k)
        const kept = cache.get(k)
        if (kept !== undefined) ((bytes -= size(kept)), cache.delete(k))
      }
      if (data !== undefined && !cache.has(key)) keep(key, data)
      return `${SCHEME}://${HOST}/${key}`
    },

    async serve(url) {
      let key: string
      try {
        const u = new URL(url)
        if (u.protocol !== `${SCHEME}:` || u.host !== HOST || u.search || u.hash) return refuse(404)
        key = u.pathname.slice(1)
      } catch {
        return refuse(400)
      }
      const entry = known.get(key)
      if (!entry || !IMAGE_MIME.test(entry.mime)) return refuse(404)
      let value = cache.get(key)
      if (typeof value === "string") {
        // Decoded once, on the first look; what is kept from then on is the bytes.
        value = Buffer.from(value, "base64")
        keep(key, value)
      } else if (value) keep(key, value)
      else {
        let pending = loading.get(key)
        if (!pending) {
          pending = load(key, entry.src).finally(() => loading.delete(key))
          loading.set(key, pending)
        }
        value = await pending
      }
      if (!value) return refuse(404)
      return new Response(new Uint8Array(value), {
        headers: {
          "Content-Type": entry.mime,
          "Content-Length": String(value.length),
          // A message's files never change: the same address is always the same picture.
          "Cache-Control": "private, max-age=31536000, immutable",
        },
      })
    },

    clear() {
      known.clear()
      cache.clear()
      bytes = 0
    },
  }
}

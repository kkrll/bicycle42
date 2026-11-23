// Chrome extensions made for the tests: a zip of the given files (stored, not deflated, as a zip
// may be), in a .crx 3 signed with a key made here, as the Chrome Web Store hands one out
// (src/main/crx.ts reads it). The id is the key's, so a test names the extension by what this returns.
import crypto from "node:crypto"
import zlib from "node:zlib"
import { idOfKey } from "../src/main/crx"

const varint = (n: number) => {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  out.push(n)
  return Buffer.from(out)
}
/** A protocol buffer's length-delimited field. */
const field = (num: number, value: Buffer) => Buffer.concat([varint(num * 8 + 2), varint(value.length), value])

/** A zip of `files` (deflated when `deflate`). */
export function makeZip(files: Record<string, string | Buffer>, deflate = false): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const packed = deflate ? zlib.deflateRawSync(data) : data
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(zlib.crc32(data), 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(deflate ? 8 : 0, 10)
    central.writeUInt32LE(zlib.crc32(data), 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, packed)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + packed.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

export type MadeCrx = { id: string; crx: Buffer }

/** A signed .crx of a zip, with a new key (or `key`, to make another of the same extension). */
export function makeCrx(zip: Buffer, key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })): MadeCrx & { key: typeof key } {
  const der = key.publicKey.export({ type: "spki", format: "der" })
  const id = idOfKey(der)
  const crxId = Buffer.from([...id].map((ch) => (ch.charCodeAt(0) - 97).toString(16)).join(""), "hex")
  const signed = field(1, crxId)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(signed.length)
  const signature = crypto.sign("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\0", "latin1"), length, signed, zip]), key.privateKey)
  const header = Buffer.concat([field(2, Buffer.concat([field(1, der), field(2, signature)])), field(10000, signed)])
  const head = Buffer.alloc(12)
  head.write("Cr24", 0, "latin1")
  head.writeUInt32LE(3, 4)
  head.writeUInt32LE(header.length, 8)
  return { id, crx: Buffer.concat([head, header, zip]), key }
}

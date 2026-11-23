// A Chrome extension as the Chrome Web Store hands it out (a .crx, version 3), opened without
// Chrome: its signature checked, its files taken out of the zip it carries, and its manifest made
// fit for Electron (extensions.ts). Nothing here touches Electron, so it is tested in node.
//
// The format (Chromium's components/crx_file): "Cr24", the version (3), the header's length, the
// header (a protocol buffer, CrxFileHeader), then the zip. The header holds proofs, each a public
// key and a signature, and the signed data, which names the extension's id. Every proof signs
// "CRX3 SignedData\0" + the signed data's length (4 bytes, little-endian) + the signed data +
// the zip. The developer's key is the one whose SHA-256 begins with the id; the store adds a
// proof of its own, which is not needed to know the file is the developer's.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

export type Crx = {
  /** The extension's id, the one the store and Chrome know it by (32 letters a–p). */
  id: string
  /** The developer's public key (DER, SubjectPublicKeyInfo), base64: the manifest's "key", which
   *  keeps that id when the extension is loaded from a folder. */
  key: string
  /** The zip inside. */
  zip: Buffer
}

/** The id an extension of this public key (DER) has: the first 16 bytes of its SHA-256, each
 *  half-byte a letter from a to p. */
export const idOfKey = (der: Buffer) =>
  [...crypto.createHash("sha256").update(der).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("")

/** The fields of a protocol buffer: [field number, bytes] for each length-delimited one (all
 *  this format has); varints are read past. */
function* fields(buf: Buffer): Generator<[number, Buffer]> {
  let i = 0
  const varint = () => {
    let n = 0
    let shift = 0
    for (;;) {
      if (i >= buf.length) throw new Error("The extension's header is cut short.")
      const c = buf[i++]!
      n += (c & 0x7f) * 2 ** shift
      shift += 7
      if (c < 0x80) return n
    }
  }
  while (i < buf.length) {
    const key = varint()
    const wire = key % 8
    const num = Math.floor(key / 8)
    if (wire === 2) {
      const len = varint()
      if (i + len > buf.length) throw new Error("The extension's header is cut short.")
      yield [num, buf.subarray(i, i + len)]
      i += len
    } else if (wire === 0) varint()
    else throw new Error("The extension's header is not one this app reads.")
  }
}

/** The .crx checked: that it is version 3, that it is the extension `expectId` (when given), and
 *  that the developer's signature over it holds. Throws with a sentence for the person otherwise. */
export function openCrx(file: Buffer, expectId?: string): Crx {
  if (file.length < 12 || file.toString("latin1", 0, 4) !== "Cr24") throw new Error("What was downloaded is not a Chrome extension.")
  if (file.readUInt32LE(4) !== 3) throw new Error("The extension is in a format this app does not read (not CRX 3).")
  const headerLength = file.readUInt32LE(8)
  if (12 + headerLength > file.length) throw new Error("The extension's file is cut short.")
  const header = file.subarray(12, 12 + headerLength)
  const zip = file.subarray(12 + headerLength)
  const proofs: Array<{ key: Buffer; signature: Buffer }> = []
  let signed: Buffer | undefined
  for (const [num, value] of fields(header)) {
    // 2: sha256_with_rsa, 3: sha256_with_ecdsa; 10000: signed_header_data.
    if (num === 2 || num === 3) {
      let key: Buffer | undefined
      let signature: Buffer | undefined
      for (const [n, v] of fields(value)) {
        if (n === 1) key = v
        if (n === 2) signature = v
      }
      if (key && signature) proofs.push({ key, signature })
    } else if (num === 10000) signed = value
  }
  if (!signed) throw new Error("The extension's file names no id.")
  let crxId: Buffer | undefined
  for (const [n, v] of fields(signed)) if (n === 1) crxId = v
  if (!crxId || crxId.length !== 16) throw new Error("The extension's file names no id.")
  const id = [...crxId.toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("")
  if (expectId && id !== expectId) throw new Error(`The extension downloaded is not the one asked for (${id}).`)
  const mine = proofs.find((p) => idOfKey(p.key) === id)
  if (!mine) throw new Error("The extension is not signed by its developer's key.")
  const length = Buffer.alloc(4)
  length.writeUInt32LE(signed.length)
  const data = Buffer.concat([Buffer.from("CRX3 SignedData\0", "latin1"), length, signed, zip])
  const key = crypto.createPublicKey({ key: mine.key, format: "der", type: "spki" })
  if (!crypto.verify("sha256", data, key, mine.signature)) throw new Error("The extension's signature does not hold: the file was changed.")
  return { id, key: mine.key.toString("base64"), zip }
}

/** Every file of a zip, by its path inside. Stored and deflated entries only (what extensions
 *  are packed with); a path that would leave the folder it is put in is refused. */
export function unzip(zip: Buffer): Map<string, Buffer> {
  // The end of the central directory: its signature, searched for from the end (a comment may follow).
  let end = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  if (end < 0) throw new Error("The extension's archive is damaged.")
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const files = new Map<string, Buffer>()
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw new Error("The extension's archive is damaged.")
    const method = zip.readUInt16LE(at + 10)
    const compressed = zip.readUInt32LE(at + 20)
    const size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength
    if (name.endsWith("/")) continue
    const parts = name.split("/")
    if (name.startsWith("/") || name.includes("\\") || parts.some((p) => p === ".." || p === "" || p === ".")) throw new Error(`The extension's archive has a path that is not allowed: ${name}`)
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error("The extension's archive is damaged.")
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + compressed)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : undefined
    if (!data) throw new Error(`The extension's archive packs ${name} in a way this app does not read.`)
    if (data.length !== size) throw new Error("The extension's archive is damaged.")
    files.set(name, data)
  }
  return files
}

/** The manifest made fit to load in Electron: the developer's key (so the id stays the store's,
 *  which a sign-in's address is registered for), the host access Chrome would grant at a press of
 *  the toolbar button ("activeTab", which Electron never grants) given up front, and the
 *  permissions it would ask for later given now (Electron has no prompt for them). */
export function fitManifest(manifest: Record<string, unknown>, key: string): Record<string, unknown> {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
  const optional = list(manifest.optional_permissions)
  return {
    ...manifest,
    key,
    host_permissions: ["<all_urls>"],
    permissions: [...new Set([...list(manifest.permissions), ...optional.filter((p) => !p.includes("://") && p !== "<all_urls>")])],
    optional_permissions: [],
    optional_host_permissions: [],
  }
}

/** The extension's files put in `folder` (made anew: written beside it, then moved into place),
 *  its manifest fitted. Returns the manifest's version. */
export function unpackCrx(crx: Crx, folder: string): string {
  const files = unzip(crx.zip)
  const raw = files.get("manifest.json")
  if (!raw) throw new Error("The extension has no manifest.")
  const manifest = JSON.parse(raw.toString("utf8").replace(/^﻿/, "")) as Record<string, unknown>
  const version = typeof manifest.version === "string" ? manifest.version : "0"
  const temp = `${folder}.part-${process.pid}-${Date.now()}`
  fs.rmSync(temp, { recursive: true, force: true })
  for (const [name, data] of files) {
    // Chrome's own record of the store's hashes: of no use outside Chrome.
    if (name.startsWith("_metadata/")) continue
    const to = path.join(temp, name)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, data)
  }
  fs.writeFileSync(path.join(temp, "manifest.json"), JSON.stringify(fitManifest(manifest, crx.key), null, 1))
  fs.rmSync(folder, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(folder), { recursive: true })
  fs.renameSync(temp, folder)
  return version
}

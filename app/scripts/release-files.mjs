// Writes SHA256SUMS and latest.json beside the zip in release/, for install.sh and the in-app updater.
//   node scripts/release-files.mjs [--base <url the zip will be served from>]
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const release = path.join(root, "release")
const zip = "bicycle42-mac-arm64.zip"
const at = process.argv.indexOf("--base")
const base = at > 0 ? process.argv[at + 1].replace(/\/$/, "") : `https://github.com/kkrll/bicycle42/releases/download/v${version}`

const sha256 = createHash("sha256").update(fs.readFileSync(path.join(release, zip))).digest("hex")
fs.writeFileSync(path.join(release, "SHA256SUMS"), `${sha256}  ${zip}\n`)
fs.writeFileSync(path.join(release, "latest.json"), JSON.stringify({ version, url: `${base}/${zip}`, sha256 }, null, 2) + "\n")
console.log(`release files for ${version}: ${zip} ${sha256}`)

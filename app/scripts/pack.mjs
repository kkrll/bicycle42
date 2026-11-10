// Packages the built app as "bicycle 42" for this computer: a real app bundle with its own name
// and icon, so the menu bar and dock say bicycle 42 instead of Electron. Run: npm run pack
// The result is in release/. It is not signed with a developer certificate or notarised.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { packager } from "@electron/packager"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const png = path.join(root, "../assets/icon.png")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))

/** macOS wants an .icns; its own tools make one from the PNG. Elsewhere the window icon is the PNG. */
function macIcon() {
  if (process.platform !== "darwin" || !fs.existsSync(png)) return undefined
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-icon-"))
  const set = path.join(dir, "icon.iconset")
  fs.mkdirSync(set)
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`
      execFileSync("sips", ["-z", String(size * scale), String(size * scale), png, "--out", path.join(set, name)], { stdio: "ignore" })
    }
  }
  const icns = path.join(dir, "icon.icns")
  execFileSync("iconutil", ["-c", "icns", set, "-o", icns])
  return icns
}

// Everything the app needs is bundled into dist/ by the build, so only that and package.json ship.
const keep = (file) => file === "" || file === "/package.json" || file === "/dist" || (file.startsWith("/dist/") && !file.startsWith("/dist/test"))

const icon = macIcon()
const out = await packager({
  dir: root,
  out: path.join(root, "release"),
  name: "bicycle 42",
  appBundleId: "com.bicycle42.app",
  appVersion: pkg.version,
  overwrite: true,
  prune: false,
  ignore: (file) => !keep(file),
  ...(icon ? { icon } : {}),
})
console.log(out.map((dir) => `packaged: ${dir}`).join("\n"))

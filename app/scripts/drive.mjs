import { spawn, spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const out = args.indexOf("--out")
if (out !== -1 && args[out + 1]) args[out + 1] = path.resolve(args[out + 1])
if (!args.includes("--no-build")) {
  const build = spawnSync("node", ["scripts/build.mjs", "--tests"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  })
  if (build.status !== 0) process.exit(build.status ?? 1)
}
const child = spawn(
  path.join(root, "node_modules/.bin/electron"),
  ["--ozone-platform=headless", "--disable-gpu", "dist/test/drive.cjs", ...args.filter((a) => a !== "--no-build")],
  { cwd: root, stdio: ["ignore", "inherit", "pipe"] },
)
// Chromium's own log lines ([pid:date:LEVEL:file]) say nothing about the app
child.stderr.on("data", (d) => {
  const kept = String(d)
    .split("\n")
    .filter((l) => !/^\[\d+:\d+\/[\d.]+:[A-Z]+:/.test(l))
    .join("\n")
  if (kept.trim()) process.stderr.write(kept.endsWith("\n") ? kept : `${kept}\n`)
})
child.on("close", (code) => process.exit(code ?? 1))

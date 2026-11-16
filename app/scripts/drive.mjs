import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
if (!args.includes("--no-build")) {
  const build = spawnSync("node", ["scripts/build.mjs", "--tests"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  })
  if (build.status !== 0) process.exit(build.status ?? 1)
}
const run = spawnSync(
  path.join(root, "node_modules/.bin/electron"),
  ["--ozone-platform=headless", "--disable-gpu", "dist/test/drive.cjs", ...args.filter((a) => a !== "--no-build")],
  { cwd: root, stdio: "inherit" },
)
process.exit(run.status ?? 1)

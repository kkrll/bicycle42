import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const shown = (dir) => (dir.startsWith(ROOT) ? path.relative(ROOT, dir) : dir)
const usage = `node scripts/visual.mjs [<shots dir>] [--baseline <dir>] [--update] [--diff <dir>]

  Builds the app and takes its shots (app/scripts/shot.mjs), or reads them from <shots dir>,
  and compares each PNG with the one of the same name in the baseline (app/test/visual/<platform>/
  by default). A shot fails when more than TOLERANCE of its pixels differ.
  --update copies the shots over the baseline instead.`

// Share of pixels that may differ. The stress shots measure a loop whose frames depend on the
// machine, so they are not compared.
const TOLERANCE = 0.001
const SKIP = [/^stress/]

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args.splice(i, 2)[1]
}
if (args.includes("-h") || args.includes("--help")) {
  console.log(usage)
  process.exit(0)
}
const update = args.includes("--update") && args.splice(args.indexOf("--update"), 1)
const baseline = path.resolve(flag("--baseline") ?? path.join(ROOT, "app/test/visual", process.platform))
const diffDir = flag("--diff")
const shots = args[0] ? path.resolve(args[0]) : takeShots()
if (!existsSync(shots)) {
  console.error(usage)
  process.exit(2)
}

function takeShots() {
  const app = path.join(ROOT, "app")
  const dir = mkdtempSync(path.join(os.tmpdir(), "b42-shots-"))
  const run = (cmd, argv, env = {}) =>
    execFileSync(cmd, argv, { cwd: app, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, ...env } })
  run("node", ["scripts/build.mjs"])
  run(
    path.join(app, "node_modules/.bin/electron"),
    ["--ozone-platform=headless", "--disable-gpu", "scripts/shot.mjs"],
    {
      SHOT_DIR: dir,
    },
  )
  return dir
}

const names = readdirSync(shots)
  .filter((f) => f.endsWith(".png") && !SKIP.some((re) => re.test(f)))
  .sort()

if (update) {
  rmSync(baseline, { recursive: true, force: true })
  mkdirSync(baseline, { recursive: true })
  for (const n of names) copyFileSync(path.join(shots, n), path.join(baseline, n))
  console.log(`visual: ${names.length} baselines written to ${shown(baseline)}`)
  process.exit(0)
}

if (!existsSync(baseline)) {
  console.error(`visual: no baselines for ${process.platform} in ${shown(baseline)}; make them with --update`)
  process.exit(1)
}
if (diffDir) mkdirSync(diffDir, { recursive: true })

const failed = []
const known = new Set(readdirSync(baseline).filter((f) => f.endsWith(".png") && !SKIP.some((re) => re.test(f))))
for (const n of names) {
  if (!known.delete(n)) {
    failed.push(`${n}: new shot with no baseline`)
    continue
  }
  const a = PNG.sync.read(readFileSync(path.join(baseline, n)))
  const b = PNG.sync.read(readFileSync(path.join(shots, n)))
  if (a.width !== b.width || a.height !== b.height) {
    failed.push(`${n}: size ${b.width}x${b.height}, baseline ${a.width}x${a.height}`)
    continue
  }
  const out = diffDir ? new PNG({ width: a.width, height: a.height }) : null
  const differ = pixelmatch(a.data, b.data, out?.data, a.width, a.height, { threshold: 0.1 })
  const share = differ / (a.width * a.height)
  if (share > TOLERANCE) {
    failed.push(`${n}: ${(share * 100).toFixed(2)}% of pixels differ`)
    if (out) writeFileSync(path.join(diffDir, n), PNG.sync.write(out))
  }
}
for (const n of known) failed.push(`${n}: baseline with no shot`)

if (failed.length) {
  console.error(`visual: ${failed.length} of ${names.length} shots differ from ${shown(baseline)}`)
  for (const f of failed) console.error(`  ${f}`)
  if (diffDir) console.error(`  diffs: ${diffDir}`)
  console.error(`  If the change is meant, run the shots again with --update and commit the new baselines.`)
  process.exit(1)
}
console.log(`visual: ${names.length} shots match ${shown(baseline)}`)

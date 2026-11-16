import { spawn, execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BIN = path.join(ROOT, "node_modules", ".bin")

const usage = `node scripts/check.mjs [--changed] [--full] [--base <ref>]

  The gates, run in parallel. Hooks, the Stop hook and CI all call this.
  Fast (default): format, lint and knip against .baseline/, dependency rules, typecheck,
  app unit tests.
  --full     also the overlay's browser tests and the app's whole suite with e2e.
  --changed  only the packages this branch and the working tree touch (against --base,
             default origin/main). Root config touches both; the overlay touches the app.`

const args = process.argv.slice(2)
if (args.includes("-h") || args.includes("--help")) {
  console.log(usage)
  process.exit(0)
}
const full = args.includes("--full")
const changedOnly = args.includes("--changed")
const baseRef = args.includes("--base") ? args[args.indexOf("--base") + 1] : "origin/main"

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)

function touched() {
  let base
  try {
    base = git("merge-base", "HEAD", baseRef)[0]
  } catch {
    base = "HEAD"
  }
  const files = new Set([
    ...git("diff", "--name-only", base),
    ...git("diff", "--name-only", "--cached"),
    ...git("ls-files", "--others", "--exclude-standard"),
  ])
  const pkgs = new Set()
  for (const f of files) {
    if (f.startsWith("app/")) pkgs.add("app")
    else if (f.startsWith("overlay/")) pkgs.add("overlay").add("app")
    else if (/\.(m?[jt]s|cjs|json)$/.test(f) || f.startsWith("scripts/") || f.startsWith("."))
      pkgs.add("app").add("overlay")
  }
  return pkgs
}

const pkgs = changedOnly ? touched() : new Set(["app", "overlay"])
if (!pkgs.size) {
  console.log("check: nothing changed in app/ or overlay/")
  process.exit(0)
}

const gates = [
  { name: "format", cmd: path.join(BIN, "oxfmt"), args: ["--check", "app", "overlay", "scripts"] },
  { name: "lint", cmd: "node", args: ["scripts/ratchet.mjs", "oxlint"] },
  { name: "knip", cmd: "node", args: ["scripts/ratchet.mjs", "knip"] },
  { name: "deps", cmd: "bun", args: ["run", "--silent", "deps"] },
]
if (pkgs.has("app")) {
  gates.push({ name: "app typecheck", cmd: "bun", args: ["run", "--silent", "typecheck"], cwd: "app" })
  gates.push(
    full
      ? { name: "app tests + e2e", cmd: "bun", args: ["run", "--silent", "test"], cwd: "app" }
      : { name: "app unit tests", cmd: "bun", args: ["run", "--silent", "test:unit"], cwd: "app" },
  )
}
if (pkgs.has("overlay")) {
  gates.push({ name: "overlay typecheck", cmd: "bun", args: ["run", "--silent", "check"], cwd: "overlay" })
  if (full) gates.push({ name: "overlay tests", cmd: "bun", args: ["run", "--silent", "test"], cwd: "overlay" })
}

function run(gate) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = spawn(gate.cmd, gate.args, { cwd: path.join(ROOT, gate.cwd ?? ""), env: process.env })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (out += d))
    child.on("error", (err) => resolve({ gate, ok: false, out: String(err), ms: Date.now() - t0 }))
    child.on("close", (code) => resolve({ gate, ok: code === 0, out, ms: Date.now() - t0 }))
  })
}

const results = await Promise.all(gates.map(run))
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.gate.name}  ${(r.ms / 1000).toFixed(1)}s`)
const failed = results.filter((r) => !r.ok)
for (const r of failed) {
  const tail = r.out.trim().split("\n").slice(-60).join("\n")
  console.error(`\n${r.gate.name}:\n${tail}`)
}
if (failed.some((r) => r.gate.name === "format")) console.error("\nformat: bun run format fixes it.")
process.exit(failed.length ? 1 : 0)

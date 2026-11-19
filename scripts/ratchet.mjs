import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BIN = path.join(ROOT, "node_modules", ".bin")
const DIR = path.join(ROOT, ".baseline")

const usage = `node scripts/ratchet.mjs [oxlint|knip ...] [--update | --reset]

  Fails when a count of findings (per file and rule) grows past .baseline/<tool>.json.
  --update  writes the counts that went down. It never raises one.
  --reset   writes the counts as they are, raised ones too. Only for landing a new rule.`

function run(cmd, args, cwd = ROOT) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] })
  } catch (err) {
    if (typeof err.stdout === "string" && err.stdout.trim()) return err.stdout
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${err.stderr || err.message}`, { cause: err })
  }
}

const rel = (file) => path.relative(ROOT, path.resolve(ROOT, file)).split(path.sep).join("/")

const tools = {
  oxlint() {
    const out = JSON.parse(run(path.join(BIN, "oxlint"), ["-f", "json"]))
    return out.diagnostics.map((d) => ({
      key: `${rel(d.filename)}\t${d.code}`,
      line: `${rel(d.filename)}:${d.labels?.[0]?.span?.line ?? "?"}  ${d.code}  ${d.message}`,
    }))
  },
  knip() {
    const found = []
    for (const pkg of ["app", "overlay"]) {
      const out = JSON.parse(
        run(path.join(BIN, "knip"), ["--reporter", "json", "--no-progress", "--no-exit-code"], path.join(ROOT, pkg)),
      )
      for (const issue of out.issues ?? []) {
        const file = rel(path.join(pkg, issue.file))
        for (const [type, list] of Object.entries(issue)) {
          if (!Array.isArray(list)) continue
          for (const item of list) {
            const name = typeof item === "string" ? item : (item.name ?? "")
            found.push({ key: `${file}\t${type}`, line: `${file}  ${type}  ${name}` })
          }
        }
      }
    }
    return found
  },
}

function count(found) {
  const counts = {}
  for (const f of found) counts[f.key] = (counts[f.key] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

function read(tool) {
  const file = path.join(DIR, `${tool}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
}

function write(tool, counts) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(path.join(DIR, `${tool}.json`), `${JSON.stringify(counts, null, 2)}\n`)
}

const args = process.argv.slice(2)
if (args.includes("-h") || args.includes("--help")) {
  console.log(usage)
  process.exit(0)
}
const mode = args.includes("--reset") ? "reset" : args.includes("--update") ? "update" : "check"
const names = args.filter((a) => !a.startsWith("--"))
for (const n of names) if (!tools[n]) throw new Error(`unknown tool ${n}\n\n${usage}`)

let failed = false
for (const tool of names.length ? names : Object.keys(tools)) {
  const found = tools[tool]()
  const now = count(found)
  const base = read(tool)
  const grew = Object.keys(now).filter((k) => now[k] > (base[k] ?? 0))
  const shrank = Object.keys(base).filter((k) => (now[k] ?? 0) < base[k])

  if (mode === "reset") {
    write(tool, now)
    console.log(`${tool}: baseline reset, ${found.length} findings`)
    continue
  }
  if (grew.length) {
    failed = true
    console.error(`${tool}: findings grew past .baseline/${tool}.json. Fix the new ones:`)
    for (const k of grew) {
      const [file, rule] = k.split("\t")
      console.error(`\n  ${file}  ${rule}: ${now[k]}, baseline ${base[k] ?? 0}`)
      for (const f of found) if (f.key === k) console.error(`    ${f.line}`)
    }
  }
  if (mode === "update") {
    if (grew.length) console.error(`${tool}: not updated while findings grow`)
    else {
      const next = {}
      for (const [k, v] of Object.entries(base)) if ((now[k] ?? 0) > 0) next[k] = Math.min(v, now[k])
      write(tool, next)
      console.log(`${tool}: baseline lowered in ${shrank.length} places, ${found.length} findings left`)
    }
  } else if (!grew.length) {
    const hint = shrank.length ? ` (${shrank.length} counts went down: bun run baseline)` : ""
    console.log(`${tool}: ${found.length} findings, none new${hint}`)
  }
}
process.exit(failed ? 1 : 0)

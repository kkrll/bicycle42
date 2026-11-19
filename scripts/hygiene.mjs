import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)

const ROOT_MARKDOWN = new Set(["README.md", "AGENTS.md", "CLAUDE.md"])
const rules = [
  {
    test: (f) => !f.includes("/") && f.endsWith(".md") && !ROOT_MARKDOWN.has(f),
    why: "Markdown at the root is README, AGENTS and CLAUDE only",
  },
  {
    test: (f) => /(^|\/)(handoff|prd-|plan-|research-|session-)[^/]*\.md$/i.test(f),
    why: "plans, PRDs, handoffs and session notes are not committed",
  },
  { test: (f) => f.startsWith(".agents/reports/"), why: "review reports stay local" },
  { test: (f) => /(^|\/)shots\//.test(f) || f.endsWith(".tsbuildinfo"), why: "build output is not committed" },
]

const bad = []
for (const f of files) for (const r of rules) if (r.test(f)) bad.push(`${f}: ${r.why}`)
if (bad.length) {
  console.error(`hygiene: ${bad.length} files do not belong in the repo`)
  for (const b of bad) console.error(`  ${b}`)
  process.exit(1)
}
console.log(`hygiene: ${files.length} files, all in place`)

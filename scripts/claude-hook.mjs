import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BIN = path.join(ROOT, "node_modules", ".bin")
const event = process.argv[2]
const input = JSON.parse(readFileSync(0, "utf8") || "{}")

const run = (cmd, args) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, FORCE_COLOR: "0" } })

function block(text) {
  process.stderr.write(text.trim().split("\n").slice(-80).join("\n") + "\n")
  process.exit(2)
}

if (event === "post-edit") {
  const file = input.tool_input?.file_path ?? input.tool_response?.filePath
  if (!file) process.exit(0)
  const rel = path.relative(ROOT, path.resolve(file))
  if (rel.startsWith("..") || !/^(app|overlay|scripts)\//.test(rel) || !/\.(m?[jt]sx?|cjs|json)$/.test(rel))
    process.exit(0)
  run(path.join(BIN, "oxfmt"), ["--no-error-on-unmatched-pattern", rel])
  if (rel.endsWith(".json")) process.exit(0)
  const lint = run("node", ["scripts/ratchet.mjs", "oxlint"])
  if (lint.status !== 0) block(`${lint.stdout}${lint.stderr}`)
  process.exit(0)
}

if (event === "stop") {
  if (input.stop_hook_active) process.exit(0)
  const check = run("node", ["scripts/check.mjs", "--changed"])
  if (check.status !== 0)
    block(`The gates fail. Fix these before finishing (AGENTS.md, Gates):\n${check.stdout}${check.stderr}`)
  process.exit(0)
}

console.error(`usage: node scripts/claude-hook.mjs post-edit|stop  (hook JSON on stdin)`)
process.exit(1)

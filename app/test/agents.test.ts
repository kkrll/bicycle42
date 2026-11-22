// How the connect screen says each known agent stands (main/agents.ts: localAgents): installed or
// not, with the command that installs it, and whether a sign-in of it is on this computer.
//
//   node scripts/build.mjs --tests && node --test dist/test/agents.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { localAgents } from "../src/main/agents"

test("a known agent: installed or not with what installs it, signed in or not with what signs in", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "b42-agents-"))
  const bin = path.join(home, "bin")
  fs.mkdirSync(bin)
  // Programs found first on this process's PATH: codex and claude, and npx to fetch their adapters.
  for (const name of ["codex", "claude", "npx"]) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 })
  const kept = { HOME: process.env.HOME, PATH: process.env.PATH, keys: {} as Record<string, string | undefined> }
  const keys = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]
  for (const k of keys) (kept.keys[k] = process.env[k]), delete process.env[k]
  process.env.HOME = home
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
  try {
    const of = async (id: string) => (await localAgents()).find((a) => a.id === id)!
    const codex = await of("codex")
    assert.equal(codex.installed, true)
    assert.equal(codex.signIn, "codex login", "no auth.json, no key: it says how to sign in")
    if (process.platform === "linux") assert.equal((await of("claude")).signIn, "claude")
    // Signed in: the status says nothing more.
    fs.mkdirSync(path.join(home, ".codex"))
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}")
    fs.mkdirSync(path.join(home, ".claude"))
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{}")
    assert.equal((await of("codex")).signIn, undefined)
    assert.equal((await of("claude")).signIn, undefined)
    // A login kept in a keyring can't be told from here: not said to be missing.
    fs.rmSync(path.join(home, ".codex", "auth.json"))
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'cli_auth_credentials_store = "keyring"\n')
    assert.equal((await of("codex")).signIn, undefined)
    // OpenCode needs no sign-in of its own; one that is not installed says what installs it.
    const opencode = await of("opencode")
    assert.equal(opencode.signIn, undefined)
    if (!opencode.installed) assert.equal(opencode.install, "npm install -g opencode-ai")
  } finally {
    process.env.HOME = kept.HOME
    process.env.PATH = kept.PATH
    for (const k of keys) if (kept.keys[k] !== undefined) process.env[k] = kept.keys[k]
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

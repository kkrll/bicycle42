// The chat's markdown (src/renderer/markdown.tsx) in a real Chromium, since it needs a DOM: a
// reply streamed in small pieces ends as exactly the DOM of the same reply parsed whole, a tight
// list or a table drawn item by item shows at every frame what parsing it whole shows, and a
// paint waits while the reader has text selected in the message. The checks themselves are in
// test/browser/markdown.ts; this bundles them, runs them in Electron and asserts on the result.
//
//   node scripts/build.mjs --tests && node --test dist/test/markdown.test.cjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const root = path.join(__dirname, "../..")
// Loaded from the app's own packages when the test runs, not bundled into it.
const load = createRequire(path.join(root, "package.json"))

type Check = { name: string; actual: unknown; expected: unknown }

function run(): Check[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bicycle42-markdown-"))
  try {
    const esbuild = load("esbuild") as typeof import("esbuild")
    const bundle = path.join(dir, "checks.js")
    esbuild.buildSync({
      entryPoints: [path.join(root, "test/browser/markdown.ts")],
      outfile: bundle,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "chrome140",
      // The view is plain DOM; the Solid components beside it are bundled but never drawn here.
      jsx: "transform",
      jsxFactory: "noJSX",
      jsxFragment: "noJSX",
      banner: { js: "function noJSX() { throw new Error('no Solid components are drawn in this test') }" },
      logLevel: "error",
    })
    const main = path.join(dir, "main.cjs")
    fs.writeFileSync(
      main,
      `const { app, BrowserWindow } = require("electron")
const fs = require("node:fs")
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false })
    await win.loadURL("data:text/html,<!doctype html><meta charset=utf-8><body></body>")
    await win.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(bundle)}, "utf8"))
    const out = await win.webContents.executeJavaScript("window.markdownChecks()")
    process.stdout.write("CHECKS " + JSON.stringify(out) + "\\n")
  } catch (err) {
    process.stdout.write("ERROR " + String(err && err.stack || err) + "\\n")
  }
  app.exit(0)
})
`,
    )
    const electron = load("electron") as unknown as string
    const r = spawnSync(electron, ["--ozone-platform=headless", "--disable-gpu", main], { encoding: "utf8", timeout: 60_000 })
    const line = r.stdout.split("\n").find((l) => l.startsWith("CHECKS ") || l.startsWith("ERROR "))
    if (!line?.startsWith("CHECKS ")) throw new Error(`the checks did not run: ${line ?? r.stderr}`)
    return JSON.parse(line.slice(7)) as Check[]
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test("markdown, streamed and whole", async (t) => {
  const checks = run()
  assert.ok(checks.length > 20, `only ${checks.length} checks ran`)
  for (const c of checks) await t.test(c.name, () => assert.deepEqual(c.actual, c.expected))
})

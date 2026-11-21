// npm run agents:check: the agents' adapters as the app pins them against the newest on npm, and
// with --test / --bump the real check of the newest and its pin. See scripts/agent-pins.mjs and
// "Updating the agents' adapters" in README.md.
import path from "node:path"
import { fileURLToPath } from "node:url"
import { main, realDeps } from "./agent-pins.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
main(process.argv.slice(2), realDeps(root)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)

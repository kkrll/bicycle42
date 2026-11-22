// The lockfiles the pinned adapters (agent-pins.json) are installed from: for each, the
// package.json that asks for the adapter at its pinned version and the package-lock.json npm made
// for it, every package of the tree with its address and sha512, the per-platform ones included.
// `npm run agents:check -- --lock <id>` writes them, and `--bump` with a new pin (scripts/agent-pins.mjs).
import claudeLock from "./claude/package-lock.json"
import claudeManifest from "./claude/package.json"
import codexLock from "./codex/package-lock.json"
import codexManifest from "./codex/package.json"

export const LOCK_FILES: Readonly<Record<string, { manifest: unknown; lock: unknown }>> = {
  claude: { manifest: claudeManifest, lock: claudeLock },
  codex: { manifest: codexManifest, lock: codexLock },
}

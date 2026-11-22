// Holds the heavy-test lock (heavy-lock.mjs) around a command, and exits as it does:
//   node scripts/heavy-lock-run.mjs <command…>
// (Its own file: heavy-lock.mjs is also bundled into the e2e's CommonJS, which has no top-level await.)
import { spawn } from "node:child_process"
import { heavyLock } from "./heavy-lock.mjs"

const cmd = process.argv.slice(2)
await heavyLock(cmd.join(" ").slice(0, 60))
const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: process.env })
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig))
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)))

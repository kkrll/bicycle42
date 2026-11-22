// What the tests of another computer share: a fake ssh (test/fake-ssh.ts) in a folder of its own,
// pointed at by B42_SSH, and a way to drop its connection and to end its helper.
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

export type FakeHost = {
  root: string
  /** The other computer's HOME. */
  home: string
  /** The app's data folder. */
  data: string
  /** The connection drops: what runs "there" for it is hung up on, and nothing reaches it until `up`. */
  drop(): void
  up(): void
  /** Ends every helper running there, with what it runs. */
  end(): Promise<void>
}

/** `under`: the folder its own is made in (a long one gives the other computer a long home). */
export function fakeHost(o: { under?: string } = {}): FakeHost {
  if (o.under) fs.mkdirSync(o.under, { recursive: true })
  const root = fs.mkdtempSync(path.join(o.under ?? os.tmpdir(), "b42-ssh-"))
  const home = path.join(root, "home")
  const data = path.join(root, "data")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  const bin = path.join(root, "bin", "ssh")
  fs.mkdirSync(path.dirname(bin))
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, "fake-ssh.cjs")}" "$@"\n`, { mode: 0o755 })
  process.env.B42_SSH = bin
  process.env.B42_FAKE_SSH_ROOT = root
  return {
    root,
    home,
    data,
    drop() {
      fs.writeFileSync(path.join(root, "down"), "")
      fs.rmSync(path.join(root, "master"), { force: true })
      const sessions = path.join(root, "sessions")
      for (const pid of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
        try {
          process.kill(Number(pid), "SIGTERM")
        } catch {}
      }
    },
    up() {
      fs.rmSync(path.join(root, "down"), { force: true })
    },
    async end() {
      const dir = path.join(home, ".bicycle42")
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
        if (f.endsWith(".sock"))
          await new Promise<void>((resolve) => {
            const s = net.connect(path.join(dir, f))
            const t = setTimeout(() => (s.destroy(), resolve()), 2000)
            s.on("connect", () => s.write(`${JSON.stringify({ id: 1, method: "shutdown" })}\n`))
            s.on("data", () => (clearTimeout(t), s.destroy(), setTimeout(resolve, 400)))
            s.on("error", () => (clearTimeout(t), resolve()))
          })
      for (const f of fs.existsSync(path.join(root, "forwards")) ? fs.readdirSync(path.join(root, "forwards")) : []) {
        try {
          process.kill(Number(fs.readFileSync(path.join(root, "forwards", f), "utf8")))
        } catch {}
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export async function until(what: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms
  while (!(await what())) {
    if (Date.now() > end) throw new Error("timed out")
    await sleep(20)
  }
}

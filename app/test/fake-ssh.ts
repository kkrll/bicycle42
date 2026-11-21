// A stand-in for the system's `ssh`, for the tests of another computer (src/main/ssh.ts): the
// "other computer" is this one, under a home folder of its own, so the helper, its daemon, attaching,
// a connection that drops, the agent's output kept meanwhile and every Machine call are tested end
// to end without an sshd. The app is pointed at it with B42_SSH (a script that runs this file).
//
//   B42_FAKE_SSH_ROOT   its folder: home/ is the other computer's HOME; `master` is there while the
//                       shared connection is; `down` makes every call fail as an unreachable host
//                       does; sessions/<pid> for each command running "there" (kill them to drop
//                       the connection); forwards/<port>.pid for each port forward
//   B42_FAKE_SSH_FAIL   what ssh says on stderr before it fails (exit 255): a host key not known…
//   B42_FAKE_SSH_PATH   the other computer's PATH (no node on it, say)
//   B42_FAKE_SSH_SHELL  its login shell (/bin/sh)
//   B42_FAKE_SSH_BIND   "there=here" pairs, ";"-separated: the other computer sees folder `here`
//                       at path `there` (a mount namespace, `unshare -rm`), so the same path is two
//                       folders, one on each computer
//
// What it understands of ssh: -o, -O check|exit|forward|cancel, -L, -f -N (a master), -T, --,
// a host, and the command, run with `sh -c` there.
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

const argv = process.argv.slice(2)

if (argv[0] === "__proxy") proxy(Number(argv[1]), argv[2]!, Number(argv[3]), argv[4]!)
else main()

/** A port forward: the local port's connections go to host:port. */
function proxy(local: number, host: string, port: number, pidFile: string) {
  const server = net.createServer((sock) => {
    const to = net.connect(port, host === "localhost" ? "127.0.0.1" : host)
    sock.pipe(to).pipe(sock)
    to.on("error", () => sock.destroy())
    sock.on("error", () => to.destroy())
  })
  server.listen(local, "127.0.0.1", () => {
    fs.writeFileSync(pidFile, String(process.pid))
    process.stdout.write("listening\n")
  })
  server.on("error", (e) => {
    process.stdout.write(`failed ${e.message}\n`)
    process.exit(1)
  })
}

function main() {
  const root = process.env.B42_FAKE_SSH_ROOT
  if (!root) {
    process.stderr.write("fake-ssh: B42_FAKE_SSH_ROOT is not set\n")
    process.exit(255)
  }
  const home = path.join(root, "home")
  const opts: string[] = []
  let control: string | undefined
  const forwards: string[] = []
  let background = false
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--") {
      i++
      break
    }
    if (!a.startsWith("-")) break
    if (a === "-o") opts.push(argv[++i]!)
    else if (a === "-O") control = argv[++i]
    else if (a === "-L") forwards.push(argv[++i]!)
    else if (a === "-f") background = true
    else if (["-p", "-i", "-F", "-l", "-J"].includes(a)) i++
  }
  const host = argv[i++]
  const command = argv.slice(i).join(" ")
  if (!host) {
    process.stderr.write("usage: ssh host\n")
    process.exit(255)
  }
  if (!opts.includes("BatchMode=yes")) {
    process.stderr.write("fake-ssh: the app must ask for BatchMode\n")
    process.exit(255)
  }
  const fail = (said: string) => {
    process.stderr.write(`${said}\n`)
    process.exit(255)
  }
  if (process.env.B42_FAKE_SSH_FAIL) fail(process.env.B42_FAKE_SSH_FAIL)
  if (fs.existsSync(path.join(root, "down"))) fail(`ssh: connect to host ${host} port 22: Network is unreachable`)
  const master = path.join(root, "master")
  fs.mkdirSync(path.join(root, "forwards"), { recursive: true })

  if (control === "check") return process.exit(fs.existsSync(master) ? 0 : 255)
  if (control === "exit") {
    fs.rmSync(master, { force: true })
    for (const f of fs.readdirSync(path.join(root, "forwards"))) {
      try {
        process.kill(Number(fs.readFileSync(path.join(root, "forwards", f), "utf8")))
      } catch {}
      fs.rmSync(path.join(root, "forwards", f), { force: true })
    }
    return process.exit(0)
  }
  if (control === "forward") {
    if (!fs.existsSync(master)) fail("Control socket connect: No such file or directory")
    // [bind:]local:host:port
    const parts = forwards[0]!.split(":")
    const [local, there, port] = parts.slice(-3) as [string, string, string]
    const pidFile = path.join(root, "forwards", `${local}.pid`)
    const child = spawn(process.execPath, [__filename, "__proxy", local, there, port, pidFile], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
    child.stdout!.once("data", (d: Buffer) => {
      if (!String(d).startsWith("listening")) fail(`bind [127.0.0.1]:${local}: Address already in use`)
      child.unref()
      ;(child.stdout as unknown as { destroy(): void }).destroy()
      process.exit(0)
    })
    return
  }
  if (control) fail(`fake-ssh: -O ${control} is not known here`)
  if (background) {
    // A master: it is there until -O exit (or the test takes it away).
    fs.writeFileSync(master, String(process.pid))
    return process.exit(0)
  }

  // A command, run "there".
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHELL: process.env.B42_FAKE_SSH_SHELL ?? "/bin/sh", ...(process.env.B42_FAKE_SSH_PATH ? { PATH: process.env.B42_FAKE_SSH_PATH } : {}) }
  fs.mkdirSync(home, { recursive: true })
  const binds = (process.env.B42_FAKE_SSH_BIND ?? "").split(";").filter(Boolean).map((p) => p.split("=") as [string, string])
  const run = binds.length
    ? spawn("unshare", ["-rm", "sh", "-c", `${binds.map(([there, here]) => `mount --bind '${here}' '${there}'`).join(" && ")} && exec sh -c "$0"`, command], { cwd: home, env, stdio: "pipe", detached: true })
    : spawn("/bin/sh", ["-c", command], { cwd: home, env, stdio: "pipe", detached: true })
  const sessions = path.join(root, "sessions")
  fs.mkdirSync(sessions, { recursive: true })
  const mine = path.join(sessions, String(process.pid))
  fs.writeFileSync(mine, command)
  process.stdin.pipe(run.stdin)
  run.stdin.on("error", () => undefined)
  run.stdout.pipe(process.stdout)
  run.stderr.pipe(process.stderr)
  // The connection dropped: what ran there for it ends (its stdin closes, and it is hung up on).
  process.on("SIGTERM", () => {
    try {
      process.kill(-run.pid!, "SIGHUP")
    } catch {}
    fs.rmSync(mine, { force: true })
    process.exit(255)
  })
  run.on("close", (code, signal) => {
    fs.rmSync(mine, { force: true })
    process.exit(code ?? (signal ? 255 : 0))
  })
}

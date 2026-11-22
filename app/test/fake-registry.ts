// A stand-in for npm's registry, for the tests of the adapters' installs (src/main/adapters.ts):
// packages made from a few files each, packed with `tar` into a temporary folder, and served
// over http on 127.0.0.1 as npm asks for them (a package's metadata at /<name>, its tarball at
// /-/<file>.tgz). npm itself, the real one, makes the lockfile against it and installs from it, so
// what is tested is what npm does: its sha512 check, its scripts left unrun. No network.
import { execFile, execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { PINS } from "../src/main/agents"

export type FakePackage = {
  name: string
  version: string
  /** Its package.json beyond name and version (bin, dependencies, scripts, os, cpu). */
  manifest?: Record<string, unknown>
  /** Its files besides package.json, by path. */
  files?: Record<string, string>
}

export type FakeRegistry = {
  url: string
  /** Every path asked for, in order. */
  requests: string[]
  /** The tarballs asked for ("b42-fake-dep-1.0.0.tgz"). */
  tarballs(): string[]
  /** From now on, this package's tarball is served with other contents than its sha512 says
   *  (false: as it is again). */
  tamper(name: string, on?: boolean): void
  /** From now on, tarballs are held back until `release`. */
  hold(): void
  release(): void
  /** The lockfile npm makes for `manifest` against this registry (no tarball is fetched). */
  lockFor(manifest: unknown): Promise<unknown>
  close(): Promise<void>
}

const fileOf = (name: string, version: string) => `${name.replace("@", "").replace("/", "-")}-${version}.tgz`

function pack(dir: string, p: FakePackage, extra = ""): Buffer {
  const src = path.join(dir, `src-${crypto.randomBytes(4).toString("hex")}`, "package")
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: p.name, version: p.version, ...p.manifest }, null, 2))
  for (const [file, text] of Object.entries(p.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(src, file)), { recursive: true })
    fs.writeFileSync(path.join(src, file), text + extra, { mode: 0o755 })
  }
  const out = path.join(dir, `${crypto.randomBytes(4).toString("hex")}.tgz`)
  execFileSync("tar", ["-czf", out, "-C", path.dirname(src), "package"])
  return fs.readFileSync(out)
}

/** An environment for npm that reads nothing of this computer's own: no npmrc, no cache of its own. */
export function npmEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^npm_config_/i.test(k)) env[k] = v
  return { ...env, HOME: home, npm_config_cache: path.join(home, ".npm"), npm_config_update_notifier: "false" }
}

export async function fakeRegistry(dir: string, packages: FakePackage[]): Promise<FakeRegistry> {
  fs.mkdirSync(dir, { recursive: true })
  const tarballs = new Map<string, { good: Buffer; bad: Buffer; pkg: FakePackage }>()
  for (const p of packages) tarballs.set(fileOf(p.name, p.version), { good: pack(dir, p), bad: pack(dir, p, "\n// changed on its way\n"), pkg: p })
  const requests: string[] = []
  const tampered = new Set<string>()
  let held: (() => void)[] | undefined
  let url = ""
  const server = http.createServer((req, res) => {
    const at = decodeURIComponent((req.url ?? "/").split("?")[0]!)
    requests.push(at)
    const tgz = /^\/-\/(.+\.tgz)$/.exec(at)?.[1]
    if (tgz) {
      const t = tarballs.get(tgz)
      if (!t) return void res.writeHead(404).end()
      const send = () => res.writeHead(200, { "content-type": "application/octet-stream" }).end(tampered.has(t.pkg.name) ? t.bad : t.good)
      return held ? void held.push(send) : send()
    }
    const name = at.slice(1)
    const versions = packages.filter((p) => p.name === name)
    if (!versions.length) return void res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}')
    const doc = {
      name,
      "dist-tags": { latest: versions.at(-1)!.version },
      versions: Object.fromEntries(
        versions.map((p) => {
          const good = tarballs.get(fileOf(p.name, p.version))!.good
          return [
            p.version,
            {
              name,
              version: p.version,
              ...p.manifest,
              dist: {
                tarball: `${url}/-/${fileOf(p.name, p.version)}`,
                integrity: `sha512-${crypto.createHash("sha512").update(good).digest("base64")}`,
                shasum: crypto.createHash("sha1").update(good).digest("hex"),
              },
            },
          ]
        }),
      ),
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(doc))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    requests,
    tarballs: () => requests.filter((r) => r.endsWith(".tgz")).map((r) => r.slice(3)),
    tamper: (name, on = true) => void (on ? tampered.add(name) : tampered.delete(name)),
    hold: () => void (held ??= []),
    release() {
      const waiting = held ?? []
      held = undefined
      for (const send of waiting) send()
    },
    // Not execFileSync: this process is the registry npm asks.
    lockFor: (manifest) =>
      new Promise((resolve, reject) => {
        const at = fs.mkdtempSync(path.join(dir, "lock-"))
        fs.writeFileSync(path.join(at, "package.json"), JSON.stringify(manifest, null, 2))
        execFile("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${url}/`], { cwd: at, env: npmEnv(at) }, (err, _out, errText) =>
          err ? reject(new Error(`npm: ${errText || err.message}`)) : resolve(JSON.parse(fs.readFileSync(path.join(at, "package-lock.json"), "utf8"))),
        )
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** The cpu of the fake adapter's optional package that is not this computer's. */
export const otherCpu = process.arch === "arm64" ? "x64" : "arm64"

/** A fake Claude Code adapter at the pinned version, as npm would install it: its program needs a
 *  dependency (whose postinstall, were it run, would write `marker`) and a peer (as 102 of the real
 *  one's 115 packages are), and it has an optional package per cpu of this computer's os (as the
 *  real one's platform programs are: only this computer's is installed); then it runs the fake
 *  ACP agent (test/acp-agent.ts) with the state file in B42_FAKE_ADAPTER_STATE. Four tarballs
 *  are fetched for it. */
export function fakeAdapterPackages(marker: string): FakePackage[] {
  const pin = PINS.claude!
  const native = (cpu: string): FakePackage => ({ name: `b42-fake-native-${process.platform}-${cpu}`, version: "1.0.0", manifest: { os: [process.platform], cpu: [cpu], main: "index.js" }, files: { "index.js": `module.exports = ${JSON.stringify(cpu)}\n` } })
  return [
    {
      name: "b42-fake-dep",
      version: "1.0.0",
      manifest: { main: "index.js", scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker).replace(/"/g, "'")}, 'ran')"` } },
      files: { "index.js": "module.exports = 'dep'\n" },
    },
    { name: "b42-fake-peer", version: "1.0.0", manifest: { main: "index.js" }, files: { "index.js": "module.exports = 'peer'\n" } },
    native(process.arch),
    native(otherCpu),
    {
      name: pin.package,
      version: pin.version,
      manifest: {
        bin: { [pin.bin]: "bin/agent.js" },
        dependencies: { "b42-fake-dep": "^1.0.0" },
        peerDependencies: { "b42-fake-peer": "^1.0.0" },
        optionalDependencies: { [`b42-fake-native-${process.platform}-${process.arch}`]: "1.0.0", [`b42-fake-native-${process.platform}-${otherCpu}`]: "1.0.0" },
      },
      files: {
        "bin/agent.js": `#!/usr/bin/env node\nrequire("b42-fake-dep")\nrequire("b42-fake-peer")\nprocess.argv.splice(2, 0, process.env.B42_FAKE_ADAPTER_STATE || "")\nrequire(${JSON.stringify(path.join(__dirname, "acp-agent.cjs"))})\n`,
      },
    },
  ]
}

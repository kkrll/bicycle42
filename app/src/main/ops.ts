// The work that runs where the files are. What the app does to a folder's repo, the panel's line
// (vcs.ts) and the app's own file history (snapshots.ts's `Shadows`), needs nothing but node and
// a `Machine`, so it is done on the computer the folder is on, by one implementation:
//
//   this computer      the app does it, over this computer's Machine (`localOps`)
//   another computer   its helper does it, with this very code over that computer's own files
//                      (src/helper/host.ts serves `OPS`), and the app asks once per operation
//                      (`remoteOps`): a snapshot, a take-back, the repo's line are each one call
//                      over ssh, where before each git command and each file was one
//
// Errors cross the wire as {message, code}: a `Refused` comes back as one (its code, EREFUSED).
import type { Repo } from "../shared/types"
import type { Machine } from "./machine"
import { createShadows, Refused, type Reversal, type Shadows } from "./snapshots"
import { vcs } from "./vcs"

export type RepoOps = {
  /** The folder's branch and what is not committed (vcs.ts). */
  vcs(dir: string, max?: number): Promise<Repo | undefined>
  /** The git side of the file history of folders on that computer, kept under `root` there. */
  shadows(root: string): Shadows
}

/** A computer whose helper does the work there: what ssh.ts gives. */
export type Helped = Machine & { helper<T>(method: string, params: Record<string, unknown>, ms?: number): Promise<T> }
const helped = (m: Machine): m is Helped => typeof (m as Partial<Helped>).helper === "function"

/** On this computer (or on the helper's, inside the helper): the work done here. */
export function localOps(m: Machine): RepoOps {
  const roots = new Map<string, Shadows>()
  return {
    vcs: (dir, max) => vcs(m, dir, max),
    shadows(root) {
      let made = roots.get(root)
      if (!made) roots.set(root, (made = createShadows(m, root)))
      return made
    },
  }
}

/** On another computer: one call to its helper each. A call has no time limit of its own (git's
 *  commands there have theirs); a connection that drops fails it. */
export function remoteOps(m: Helped): RepoOps {
  const call = <T>(method: string, params: Record<string, unknown>) =>
    m.helper<T>(`ops.${method}`, params, 0).catch((err: Error & { code?: string }) => {
      throw err.code === "EREFUSED" ? new Refused(err.message) : err
    })
  /** The helper answers null for nothing. */
  const maybe = <T>(v: T | null) => v ?? undefined
  return {
    vcs: (dir, max) => call<Repo | null>("vcs", { dir, ...(max !== undefined && Number.isFinite(max) ? { max } : {}) }).then(maybe),
    shadows: (root) => ({
      snapshot: (dir) => call<string | null>("snapshot", { root, dir }).then(maybe),
      diff: (dir, from, to) => call("diff", { root, dir, from, to }),
      reverse: (dir, turns, dry = false, was) =>
        call<Reversal | null>("reverse", { root, dir, turns: turns.map((t) => ({ before: t.before, after: t.after, ...(t.start !== undefined ? { start: t.start } : {}) })), dry, ...(was ? { was } : {}) }).then(maybe),
      apply: (dir, from, to) => call("apply", { root, dir, from, to }),
      readLog: (dir) => call<string | null>("readLog", { root, dir }).then(maybe),
      writeLog: (dir, text) => call("writeLog", { root, dir, text }),
      keep: (dir, trees) => call("keep", { root, dir, trees }),
    }),
  }
}

const made = new WeakMap<Machine, RepoOps>()
/** The work on `m`, done where its files are. */
export function opsOf(m: Machine): RepoOps {
  let ops = made.get(m)
  if (!ops) made.set(m, (ops = helped(m) ? remoteOps(m) : localOps(m)))
  return ops
}

// ── what the helper serves ─────────────────────────────────────────────────────────────────────

/** A param's kind, as host.ts checks it ("?": it may be left out). */
export type OpParam = "string" | "uint" | "number" | "strings" | "boolean" | "object" | "turns"
type Served = { params: Record<string, OpParam | `${OpParam}?`>; run(ops: RepoOps, q: Record<string, unknown>): Promise<unknown> }

const s = (v: unknown) => v as string
const shadowsAt = (ops: RepoOps, q: Record<string, unknown>) => ops.shadows(s(q.root))

/** The calls `remoteOps` makes, as the helper serves them over its own computer's `localOps`: each
 *  one's params, checked before it runs, and what it does. */
export const OPS: Record<string, Served> = {
  vcs: { params: { dir: "string", max: "uint?" }, run: (ops, q) => ops.vcs(s(q.dir), (q.max as number | undefined) ?? undefined) },
  snapshot: { params: { root: "string", dir: "string" }, run: (ops, q) => shadowsAt(ops, q).snapshot(s(q.dir)) },
  diff: { params: { root: "string", dir: "string", from: "string", to: "string" }, run: (ops, q) => shadowsAt(ops, q).diff(s(q.dir), s(q.from), s(q.to)) },
  reverse: {
    params: { root: "string", dir: "string", turns: "turns", dry: "boolean?", was: "object?" },
    run(ops, q) {
      const was = q.was as Partial<Reversal> | undefined
      const ok = !was || (typeof was.from === "string" && typeof was.to === "string" && Array.isArray(was.files) && was.files.every((f) => typeof f === "string"))
      if (!ok) throw Object.assign(new Error("reverse: was must be {from, to, files}"), { code: "EINVAL" })
      return shadowsAt(ops, q).reverse(s(q.dir), q.turns as Array<{ before: string; after: string; start?: number }>, q.dry === true, was as Reversal | undefined)
    },
  },
  apply: { params: { root: "string", dir: "string", from: "string", to: "string" }, run: (ops, q) => shadowsAt(ops, q).apply(s(q.dir), s(q.from), s(q.to)) },
  readLog: { params: { root: "string", dir: "string" }, run: (ops, q) => shadowsAt(ops, q).readLog(s(q.dir)) },
  writeLog: { params: { root: "string", dir: "string", text: "string" }, run: (ops, q) => shadowsAt(ops, q).writeLog(s(q.dir), s(q.text)) },
  keep: { params: { root: "string", dir: "string", trees: "strings" }, run: (ops, q) => shadowsAt(ops, q).keep(s(q.dir), q.trees as string[]) },
}

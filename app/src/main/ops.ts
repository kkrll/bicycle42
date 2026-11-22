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
import { createShadows, Refused, type LogEdit, type Restore, type RestoreRecord, type Reversal, type Shadows } from "./snapshots"
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
  /** A take-back's turns, as the helper takes them: their trees and when each began. */
  const plain = (turns: Array<{ before: string; after: string; start?: number }>) => turns.map((t) => ({ before: t.before, after: t.after, ...(t.start !== undefined ? { start: t.start } : {}) }))
  /** The helper answers null for nothing. */
  const maybe = <T>(v: T | null) => v ?? undefined
  return {
    vcs: (dir, max) => call<Repo | null>("vcs", { dir, ...(max !== undefined && Number.isFinite(max) ? { max } : {}) }).then(maybe),
    shadows: (root) => ({
      snapshot: (dir) => call<string | null>("snapshot", { root, dir }).then(maybe),
      diff: (dir, from, to) => call("diff", { root, dir, from, to }),
      reverse: (dir, turns, dry = false, was) => call<Reversal | null>("reverse", { root, dir, turns: plain(turns), dry, ...(was ? { was } : {}) }).then(maybe),
      apply: (dir, from, to) => call("apply", { root, dir, from, to }),
      readLog: (dir) => call<string | null>("readLog", { root, dir }).then(maybe),
      editLog: (dir, edit) => call("editLog", { root, dir, edit }),
      takeBack: (dir, turns, restore, was) => call("takeBack", { root, dir, turns: plain(turns), restore, ...(was ? { was } : {}) }),
      bringBack: (dir, restore) => call("bringBack", { root, dir, restore: { id: restore.id, from: restore.from, to: restore.to } }),
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
const einval = (message: string) => Object.assign(new Error(message), { code: "EINVAL" })
const str = (v: unknown): v is string => typeof v === "string"
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(str)
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** A dry run's answer, as the app sends it back. */
function reversal(v: unknown): Reversal | undefined {
  if (v === undefined || v === null) return undefined
  const w = v as Partial<Reversal>
  if (!obj(v) || !str(w.from) || !str(w.to) || !strs(w.files)) throw einval("was must be {from, to, files}")
  return { from: w.from, to: w.to, files: w.files }
}

/** A restore to be kept: its id, conversation, time, turns and notes, and maybe `told`. */
function restoreRecord(v: unknown, what: string): RestoreRecord {
  const r = v as Partial<Restore>
  if (!obj(v) || !str(r.id) || !str(r.session) || !num(r.time) || !strs(r.turns) || !strs(r.notes) || (r.told !== undefined && r.told !== true)) throw einval(`${what} must be {id, session, time, turns, notes, told?}`)
  return { id: r.id, session: r.session, time: r.time, turns: r.turns, notes: r.notes, ...(r.told ? { told: true as const } : {}) }
}

/** One change of a folder's log, checked whole: anything else is refused, never written. */
function logEdit(v: unknown): LogEdit {
  const e = v as { op?: unknown; [k: string]: unknown }
  if (e.op === "addTurn") {
    const t = e.turn as Record<string, unknown>
    if (!obj(t) || !str(t.id) || !str(t.session) || !num(t.start) || !str(t.before) || !str(t.after) || !strs(t.messages) || (t.shared !== undefined && t.shared !== true) || (t.untrusted !== undefined && t.untrusted !== true))
      throw einval("editLog: addTurn's turn must be {id, session, start, before, after, messages, shared?, untrusted?}")
    return { op: "addTurn", turn: t as never }
  }
  if (e.op === "addRestore") {
    const r = e.restore as Partial<Restore>
    if (!obj(r) || !str(r.from) || !str(r.to)) throw einval("editLog: addRestore's restore must have its from and to")
    return { op: "addRestore", restore: { ...restoreRecord(r, "editLog: addRestore's restore"), from: r.from, to: r.to } }
  }
  if (e.op === "updateRestore") {
    if (!str(e.id) || !(e.change === null || obj(e.change))) throw einval("editLog: updateRestore must be {id, change: {…} or null}")
    const c = e.change as Partial<Restore> | null
    // What a restore's change may be: told, now (the rest of a restore is never changed).
    if (c && Object.keys(c).some((k) => k !== "told") ) throw einval("editLog: updateRestore's change may say only told")
    if (c && c.told !== undefined && c.told !== true) throw einval("editLog: told must be true")
    return { op: "updateRestore", id: e.id, change: c }
  }
  if (e.op === "prune") {
    if (!num(e.now)) throw einval("editLog: prune's now must be a number")
    return { op: "prune", now: e.now }
  }
  throw einval("editLog: edit must be addTurn, addRestore, updateRestore or prune")
}

/** The calls `remoteOps` makes, as the helper serves them over its own computer's `localOps`: each
 *  one's params, checked before it runs, and what it does. */
export const OPS: Record<string, Served> = {
  vcs: { params: { dir: "string", max: "uint?" }, run: (ops, q) => ops.vcs(s(q.dir), (q.max as number | undefined) ?? undefined) },
  snapshot: { params: { root: "string", dir: "string" }, run: (ops, q) => shadowsAt(ops, q).snapshot(s(q.dir)) },
  diff: { params: { root: "string", dir: "string", from: "string", to: "string" }, run: (ops, q) => shadowsAt(ops, q).diff(s(q.dir), s(q.from), s(q.to)) },
  reverse: {
    params: { root: "string", dir: "string", turns: "turns", dry: "boolean?", was: "object?" },
    run: (ops, q) => shadowsAt(ops, q).reverse(s(q.dir), q.turns as Array<{ before: string; after: string; start?: number }>, q.dry === true, reversal(q.was)),
  },
  apply: { params: { root: "string", dir: "string", from: "string", to: "string" }, run: (ops, q) => shadowsAt(ops, q).apply(s(q.dir), s(q.from), s(q.to)) },
  readLog: { params: { root: "string", dir: "string" }, run: (ops, q) => shadowsAt(ops, q).readLog(s(q.dir)) },
  editLog: { params: { root: "string", dir: "string", edit: "object" }, run: (ops, q) => shadowsAt(ops, q).editLog(s(q.dir), logEdit(q.edit)) },
  takeBack: {
    params: { root: "string", dir: "string", turns: "turns", restore: "object", was: "object?" },
    run: (ops, q) => shadowsAt(ops, q).takeBack(s(q.dir), q.turns as Array<{ before: string; after: string; start?: number }>, restoreRecord(q.restore, "takeBack: restore"), reversal(q.was)),
  },
  bringBack: {
    params: { root: "string", dir: "string", restore: "object" },
    run(ops, q) {
      const r = q.restore as Partial<Restore>
      if (!str(r.id) || !str(r.from) || !str(r.to)) throw einval("bringBack: restore must be {id, from, to}")
      return shadowsAt(ops, q).bringBack(s(q.dir), { id: r.id!, from: r.from!, to: r.to! })
    },
  },
  keep: { params: { root: "string", dir: "string", trees: "strings" }, run: (ops, q) => shadowsAt(ops, q).keep(s(q.dir), q.trees as string[]) },
}

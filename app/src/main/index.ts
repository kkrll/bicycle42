// bicycle 42, main process: the controller.
//
// It owns the one piece of state the rest of the app looks at (AppState) and connects four parts
// that know nothing of each other:
//
//   page.ts      the site under review, a native view with the overlay injected
//   review.ts    the notes of a site and their status
//   opencode.ts  the agent backend (sessions, queue, event stream)
//   store.ts     settings and notes on disk
//
// Flow of a note:  overlay → "note" → screenshot → prompt → backend queue → inbox/run events →
// note status → pins on the page and rows in the window.
//
// One site (a page origin) maps to one folder on the server, picked once, and to one open
// conversation there, plus a second "background" one for alt+Enter notes. A note remembers the
// conversation it was sent to, so switching conversations never moves an older note's status.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell, type NativeImage } from "electron"
import fs from "node:fs"
import path from "node:path"
import { notePrompt, noteWords, TEMPLATES } from "../../../overlay/prompt.js"
import type {
  AgentInfo,
  AppState,
  Backend,
  BackendEvent,
  CommandResult,
  ChatEvent,
  Commands,
  CommandName,
  ConnectionState,
  Lane,
  Mention,
  MentionOption,
  ModelInfo,
  ModelRef,
  PermissionAsk,
  PromptFile,
  Question,
  SendOptions,
  SessionSummary,
  Shortcut,
  SlashCommand,
} from "../shared/types"
import { noteImages } from "./images"
import { readLocal } from "./local"
import { createOpenCode, type OpenCode } from "./opencode"
import { createPage, type Page, type PageMessage } from "./page"
import { createReview, imageUri, pageNote, type PageNote, type Review } from "./review"
import { createStore } from "./store"

type Level = "info" | "warn" | "error"
const log = (level: Level, msg: string, data?: unknown) =>
  console[level === "info" ? "log" : level](`[bicycle42] ${msg}`, data === undefined ? "" : data)

/** Errors meant for the person at the screen; anything else gets a generic prefix. */
const say = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Tests point the app at a scratch profile. Otherwise the folder is named here, so the packaged
// app ("bicycle 42") and a run from source keep their settings and notes in the same place.
app.setPath("userData", process.env.BICYCLE42_DATA || path.join(app.getPath("appData"), "bicycle42"))

const store = createStore(app.getPath("userData"), { log })

// ── secrets ─────────────────────────────────────────────────────────────────────────────────────
// The server password is stored through the OS keychain when there is one. Without (a Linux box
// with no keyring), it is stored as is, in a settings file only the user can read.
function seal(secret: string) {
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(secret).toString("base64")}`
  return `plain:${secret}`
}
function unseal(sealed: string): string | undefined {
  try {
    if (sealed.startsWith("plain:")) return sealed.slice(6)
    if (sealed.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(sealed.slice(4), "base64"))
  } catch (err) {
    log("warn", "the saved password can't be read; connect again", say(err))
  }
  return undefined
}

// ── state ───────────────────────────────────────────────────────────────────────────────────────

type Site = { origin: string; review: Review }

let window: BrowserWindow | undefined
let page: Page | undefined
let backend: OpenCode | undefined
let unlisten: (() => void) | undefined
let connection: ConnectionState = { status: "unconfigured" }
let models: ModelInfo[] = []
let agents: AgentInfo[] = []

/** Every site visited since launch stays loaded, so notes still in flight on a site the reviewer
 *  navigated away from keep their status. */
const sites = new Map<string, Site>()
/** A server's name is a label, not a description. */
const SERVER_NAME_MAX = 60
let site: Site | undefined
/** What the overlay on the page last said about itself: in canvas ("edit") or motion mode, the
 *  brush on. Not saved: the page remembers its own mode across a reload and says it again. */
let pageMode = { canvas: false, motion: false, brush: false }
/** Which site's notes an event for a conversation belongs to. Entries are never removed: a
 *  conversation the reviewer switched away from may still be finishing notes. */
const owners = new Map<string, string>()

let session: SessionSummary | null = null
let sessions: SessionSummary[] = []
const permissions = new Map<string, PermissionAsk>()
const questions = new Map<string, Question>()

/** The conversation the window shows. While its transcript loads, live events wait in `held`;
 *  `again` asks for one more read after this one (something was missed meanwhile). */
let chat: { session: string; held: ChatEvent[] | null; again: boolean } | undefined

/** What each unfinished note was sent with, so it can be sent again. `id` is the message id the
 *  server knows it by: sending the same id twice queues it once, which makes a retry after a
 *  lost reply safe. Entries go when their note is done or removed. */
const outbox = new Map<string, { text: string; files: PromptFile[]; id?: string }>()

const siteSettings = (origin: string) => store.settings().sites[origin]

/** Where the app is before any page is open, once a repo is: a site of its own in every way
 *  but the address, so the agent can be talked to (and asked to start the site) from there. */
const HOME = "b42:repo"
/** The repo open in the app. Saved since it is chosen first; before that, the last site's folder. */
function repoFolder(): string | undefined {
  const s = store.settings()
  if (s.folder) return s.folder
  const last = s.lastUrl ? originOf(s.lastUrl) : undefined
  return last ? s.sites[last]?.directory : undefined
}
/** The site a page address belongs to: its origin, or the repo's own place while there is no page. */
function placeOf(url: string): string | undefined {
  return originOf(url) ?? (repoFolder() ? HOME : undefined)
}
/** The conversation asked to get the site running. It stays asked while no page works, so an
 *  address given after a question and its answer is opened too; `starting` until it first answers. */
let siteAsked: string | undefined
let starting = false

function snapshot(): AppState {
  const p = page?.state()
  const review = site?.review
  const saved = site && siteSettings(site.origin)
  const model = defaultModel()
  return {
    connection,
    ...(store.settings().server?.name ? { serverName: store.settings().server!.name } : {}),
    page: p ?? { url: "", loading: false, canGoBack: false, canGoForward: false, hmr: false },
    review: {
      enabled: review?.enabled ?? true,
      mode: !(review?.enabled ?? true) ? "preview" : pageMode.canvas ? "edit" : pageMode.motion ? "motion" : "notes",
      brush: (review?.enabled ?? true) && pageMode.brush,
      autoReload: review?.autoReload ?? true,
      notes: review?.rows() ?? [],
      unplaced: review?.unplaced ?? 0,
    },
    site: site ? { origin: site.origin === HOME ? "" : site.origin, ...(saved ? { directory: saved.directory } : {}) } : null,
    ...(starting && siteAsked === session?.id ? { startingSite: true as const } : {}),
    session,
    sessions,
    models,
    agents,
    ...(model ? { defaultModel: model } : {}),
    ...(modelChoice && model ? { modelChoice: { suggested: model, ...(modelChoice.previous ? { previous: modelChoice.previous } : {}) } } : {}),
    permissions: [...permissions.values()],
    questions: [...questions.values()],
  }
}

// Many things change at once (a note finishing moves a row, a pin and the busy flag); the window
// gets one snapshot per turn of the event loop, not one per change.
let pushing = false
function push() {
  if (pushing) return
  pushing = true
  setImmediate(() => {
    pushing = false
    if (window && !window.isDestroyed()) window.webContents.send("b42:state", snapshot())
  })
}

function toChat(event: ChatEvent) {
  if (window && !window.isDestroyed()) window.webContents.send("b42:chat", event)
}

/** A review changed: save it, redraw its pins if it is the one on screen, refresh the window. */
function changed(s: Site) {
  for (const id of outbox.keys()) {
    const status = noteSite(id)?.review.note(id)?.status
    if (status === undefined || status === "done") outbox.delete(id)
  }
  store.saveReview(s.origin, s.review.toJSON())
  if (s === site) page?.send({ type: "pins", pins: pinsOf(s.review) })
  push()
}

/** The loaded site whose list holds this note. */
function noteSite(id: string) {
  for (const s of sites.values()) if (s.review.note(id)) return s
  return undefined
}

// ── models ──────────────────────────────────────────────────────────────────────────────────────

const sameModel = (a: ModelRef, b: { providerID: string; id: string }) => a.providerID === b.providerID && a.id === b.id

/** The model new conversations start with: the last one picked, else the first that takes
 *  screenshots. The server's own default may be text-only, which would blind every note. */
function defaultModel(): ModelRef | undefined {
  const saved = store.settings().defaultModel
  if (saved && models.some((m) => sameModel(saved, m))) return saved
  const pick = models.find((m) => m.images) ?? models[0]
  return pick ? { providerID: pick.providerID, id: pick.id } : undefined
}

/** Set while the person is being asked which model to start conversations with (see
 *  `AppState.modelChoice`). `previous` is a saved choice this server no longer lists. */
let modelChoice: { previous?: ModelRef } | undefined

/** Run when a server's model list has arrived. Asks once: not when a saved choice is still on
 *  the list, not when there is nothing to choose between (one model is simply saved), and not
 *  when the list is empty or could not be read. */
function settleDefaultModel() {
  const saved = store.settings().defaultModel
  modelChoice = undefined
  if (!models.length || (saved && models.some((m) => sameModel(saved, m)))) return
  if (models.length === 1) {
    const only = models[0]!
    return store.update((s) => void (s.defaultModel = { providerID: only.providerID, id: only.id }))
  }
  modelChoice = saved ? { previous: saved } : {}
}

// ── connection ──────────────────────────────────────────────────────────────────────────────────

/** `box:49374` → `http://box:49374`. Public hosts get https; bare names, IPs and localhost http. */
function serverUrl(input: string) {
  let url = input.trim().replace(/\/+$/, "")
  if (!url) throw new Error("Enter the server address.")
  if (!/^https?:\/\//i.test(url)) {
    const host = url.split(/[/:]/)[0] ?? ""
    const local = host === "localhost" || /^[\d.]+$/.test(host) || !host.includes(".")
    url = `${local ? "http" : "https"}://${url}`
  }
  try {
    return new URL(url).origin
  } catch {
    throw new Error(`"${input}" is not a server address. It looks like https://name.example or http://127.0.0.1:49374.`)
  }
}

function drop() {
  clearTimeout(retryTimer)
  unlisten?.()
  unlisten = undefined
  backend = undefined
  models = []
  agents = []
  modelChoice = undefined
  session = null
  sessions = []
  permissions.clear()
  questions.clear()
  chat = undefined
}

/** Checks the server, then keeps listening to it. Rejects, leaving things as they were, when the
 *  address or password is wrong. */
async function connect(url: string, password: string, opts: { save?: "remote" | "local" }) {
  const next = createOpenCode({ url, password, log })
  const info = await next.info()
  drop()
  backend = next
  connection = { status: "online", url, version: info.version }
  // A local server is saved as "the one on this computer", not by address: its port and
  // password are OpenCode's to change, and are read again from its own file each time.
  // A name stays with its server: connecting to the same one again keeps it, another drops it.
  const before = store.settings().server
  const name = before?.name && (opts.save === "local" ? "local" in before : "url" in before && before.url === url) ? { name: before.name } : {}
  if (opts.save === "remote") store.update((s) => void (s.server = { url, password: seal(password), ...name }))
  if (opts.save === "local") store.update((s) => void (s.server = { local: true, ...name }))
  unlisten = next.listen(onBackend)
  push()
  const [m, a] = await Promise.all([next.models(), next.agents()]).catch((err) => {
    log("warn", "can't list models", say(err))
    return [[], []] as [ModelInfo[], AgentInfo[]]
  })
  if (backend !== next) return
  models = m
  agents = a
  settleDefaultModel()
  push()
  await openSite()
}

async function reconnectSaved() {
  const saved = store.settings().server
  if (!saved) return
  clearTimeout(retryTimer)
  const local = "local" in saved
  const found = local ? readLocal() : undefined
  const url = local ? (found?.url ?? LOCAL_NAME) : saved.url
  const password = local ? found?.password : unseal(saved.password)
  if (!local && password === undefined) {
    connection = { status: "offline", url, error: "The saved password can't be read. Enter it again." }
    return push()
  }
  // Quiet retries keep saying "offline" with the reason; only the first try shows "connecting".
  if (connection.status !== "offline") connection = { status: "connecting", url }
  push()
  try {
    if (password === undefined) throw new Error(NO_LOCAL)
    await connect(url, password, {})
    retryDelay = RETRY_FIRST_MS
  } catch (err) {
    if (backend || !store.settings().server) return // connected or disconnected by hand meanwhile
    connection = { status: "offline", url, error: say(err) }
    push()
    // The machine may simply not be up yet. Once connected, the event stream reconnects by
    // itself; before the first success this timer is the only thing that tries again.
    retryTimer = setTimeout(() => void reconnectSaved(), retryDelay)
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
  }
}
/** Shown as the address while no local server is registered. */
const LOCAL_NAME = "http://localhost"
const NO_LOCAL = "No OpenCode server is running on this computer. Start one with: opencode service start"
const RETRY_FIRST_MS = 3_000
const RETRY_MAX_MS = 30_000
let retryDelay = RETRY_FIRST_MS
let retryTimer: ReturnType<typeof setTimeout> | undefined

// ── sites and conversations ─────────────────────────────────────────────────────────────────────

function originOf(url: string) {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined
  } catch {
    return undefined
  }
}

/** The page moved to another site (or the first one): bring up that site's notes. */
function switchSite(origin: string | undefined, again = false) {
  if (origin === site?.origin && !again) return
  if (!origin) {
    site = undefined
  } else {
    let s = sites.get(origin)
    if (!s) sites.set(origin, (s = { origin, review: createReview(store.loadReview(origin)) }))
    site = s
    adopt(origin)
    const saved = siteSettings(origin)
    if (saved?.session) owners.set(saved.session, origin)
    if (saved?.bg) owners.set(saved.bg, origin)
    for (const id of s.review.sessions()) owners.set(id, origin)
  }
  session = null
  sessions = []
  chat = undefined
  toChat({ type: "reset", session: "", items: [] })
  push()
  void openSite()
}

/** A place seen for the first time works in the repo that is open. The first site opened also
 *  takes over the conversation held before any page was (where the agent may just have been
 *  asked to start it), so that it goes on beside the page. */
function adopt(origin: string) {
  const folder = repoFolder()
  if (!folder) return
  // The place without a page is always the open repo's: after another repo was opened, it starts anew.
  if (origin === HOME && siteSettings(HOME) && siteSettings(HOME)!.directory !== folder) store.update((x) => void (x.sites[HOME] = { directory: folder }))
  if (siteSettings(origin)) return
  const home = origin === HOME ? undefined : siteSettings(HOME)
  const moved = home?.session && home.directory === folder ? home.session : undefined
  store.update((x) => {
    x.sites[origin] = { directory: folder, ...(moved ? { session: moved } : {}) }
    if (moved) delete x.sites[HOME]?.session, delete x.sites[HOME]?.bg
  })
}

/** "storefront" from "/home/dev/code/storefront". */
const folderName = (directory: string) => directory.replace(/\/+$/, "").split("/").pop() || directory

/** Opens the current site's conversation, creating one the first time. Needs a connection and a
 *  folder; without either it waits for whichever command supplies it. Opens run one after
 *  another: a second caller arriving mid-open finds the conversation the first one made, instead
 *  of making its own. */
function openSite(): Promise<void> {
  const run = opening.then(openSiteNow)
  opening = run.catch(() => undefined)
  return run
}
let opening: Promise<void> = Promise.resolve()

async function openSiteNow() {
  const b = backend
  const s = site
  const saved = s && siteSettings(s.origin)
  if (!b || !s || !saved) return
  try {
    let current = saved.session ? await b.session(saved.session) : null
    // A new conversation starts on the model the person chose: while that is being asked,
    // none is made. setDefaultModel comes back here.
    if (!current && modelChoice) return
    if (!current) {
      current = await b.createSession({
        directory: saved.directory,
        title: `Review · ${s.origin === HOME ? folderName(saved.directory) : new URL(s.origin).host}`,
        ...(defaultModel() ? { model: defaultModel() } : {}),
      })
      store.update((x) => {
        const entry = x.sites[s.origin]
        // A new conversation gets a new background one on demand; the old one belonged to the old.
        if (entry) (entry.session = current!.id), delete entry.bg
      })
    }
    // The app has one mode, Build. A conversation left in another one (by an older version, or by
    // OpenCode itself) is put back, or notes would be planned and never made.
    if (current.agent && current.agent !== "build" && agents.some((x) => x.id === "build")) {
      await b.setAgent(current.id, "build").then(() => void (current = { ...current!, agent: "build" }), (err) => log("warn", "can't switch to build", say(err)))
    }
    if (backend !== b || site !== s) return
    owners.set(current.id, s.origin)
    session = current
    push()
    void refreshSessions()
    void openChat(current.id)
    void settle(s)
  } catch (err) {
    log("warn", "can't open the conversation", say(err))
    if (backend !== b || site !== s) return // the failure belongs to a site no longer on screen
    toChat({
      type: "reset",
      session: "",
      items: [{ kind: "marker", id: "open-error", time: Date.now(), tone: "error", text: `Can't open a conversation: ${say(err)}` }],
    })
  }
}

async function refreshSessions() {
  const b = backend
  const s = site
  const directory = s && siteSettings(s.origin)?.directory
  if (!b || !s || !directory) return
  try {
    const list = await b.sessions(directory)
    if (backend === b && site === s) (sessions = list), push()
  } catch (err) {
    log("warn", "can't list conversations", say(err))
  }
}

async function openChat(id: string) {
  const b = backend
  if (!b) return
  // A read of this conversation is already under way: one more after it is enough, however
  // many times that is asked. (A transcript with screenshots is megabytes.)
  if (chat?.session === id && chat.held) return void (chat.again = true)
  const mine = (chat = { session: id, held: [] as ChatEvent[] | null, again: false })
  try {
    const t = await b.transcript(id)
    if (chat !== mine) return
    for (const [k, p] of permissions) if (p.session === id) permissions.delete(k)
    for (const [k, q] of questions) if (q.session === id) questions.delete(k)
    for (const p of t.permissions) permissions.set(p.id, p)
    for (const q of t.questions) questions.set(q.id, q)
    toChat({ type: "reset", session: id, items: t.items })
    // Events that arrived during the read. Upserts repeat harmlessly; a text delta already in the
    // transcript shows twice until its block ends, which replaces the text.
    for (const e of mine.held ?? []) toChat(e)
  } catch (err) {
    if (chat !== mine) return
    toChat({
      type: "reset",
      session: id,
      items: [{ kind: "marker", id: "load-error", time: Date.now(), tone: "error", text: `Can't load the conversation: ${say(err)}` }],
    })
  } finally {
    mine.held = null
    push()
  }
  if (chat === mine && mine.again) void openChat(id)
}

/** After a restart or a dropped connection, notes may show "queued" or "working" for work that
 *  ended while nobody listened. For each conversation that still owes notes: if it is gone they
 *  fail; if it is idle, everything it accepted is finished except what still waits in its queue. */
async function settle(s: Site) {
  const b = backend
  if (!b) return
  let touched = false
  for (const id of s.review.sessions()) {
    try {
      const info = await b.session(id)
      if (info === null) touched = s.review.gone(id) || touched
      else if (!info.busy) touched = s.review.settled(id, await b.waiting(id)) || touched
    } catch (err) {
      // Unreachable right now: leave the notes as they are; the next reconnect asks again.
      log("warn", "can't check a conversation's notes", say(err))
    }
  }
  if (touched) changed(s)
}

/** A conversation was deleted on the server. Its notes fail (with a way forward), and if it was
 *  the one on screen, the site gets a fresh one so the next note has somewhere to go. */
function sessionGone(id: string) {
  const origin = owners.get(id)
  const s = origin ? sites.get(origin) : undefined
  if (!origin || !s) return
  if (s.review.gone(id)) changed(s)
  const saved = siteSettings(origin)
  if (saved?.bg === id) store.update((x) => void delete x.sites[origin]?.bg)
  if (saved?.session !== id) return
  store.update((x) => {
    const entry = x.sites[origin]
    if (entry) delete entry.session, delete entry.bg
  })
  if (s !== site) return
  session = null
  push()
  void openSite()
}

// ── backend events ──────────────────────────────────────────────────────────────────────────────

function onBackend(e: BackendEvent) {
  switch (e.type) {
    case "connection":
      // The first "online" came from connect(); later ones follow a dropped stream.
      connection = e.state
      // Pins follow the connection too: working ones read as paused while it is down.
      if (site) page?.send({ type: "pins", pins: pinsOf(site.review) })
      return push()
    case "resync":
      // One conversation has a gap: only the one on screen is worth re-reading.
      if (e.session) return void (chat?.session === e.session && openChat(e.session))
      if (session) void openChat(session.id)
      void refreshSessions()
      for (const s of sites.values()) void settle(s)
      return
    case "session-gone":
      return sessionGone(e.session)
    case "inbox":
    case "run": {
      if (e.type === "run" && session?.id === e.session) (session = { ...session, busy: e.status === "started" }), push()
      if (e.type === "run" && siteAsked === e.session) {
        if (e.status === "started") (starting = true), push()
        else void started(e.session, e.status === "succeeded")
      }
      const origin = owners.get(e.session)
      const s = origin ? sites.get(origin) : undefined
      if (!s) return
      const done = doneCount(s.review)
      const touched =
        e.type === "inbox" ? s.review.inbox(e.session, e.id, e.status) : s.review.run(e.session, e.status, e.error)
      if (!touched) return
      changed(s)
      // Show the agent's change: a page without hot reload still has the old pixels.
      if (s === site && s.review.autoReload && doneCount(s.review) > done) page?.reloadWhenIdle()
      return
    }
    case "session": {
      if (session?.id === e.session.id) session = e.session
      const i = sessions.findIndex((x) => x.id === e.session.id)
      if (i >= 0) sessions = sessions.with(i, e.session)
      // Events arrive for every folder on the server; only a new top-level conversation in this
      // site's folder belongs in the switcher.
      else if (!e.session.parent && site && e.session.directory === siteSettings(site.origin)?.directory)
        sessions = [e.session, ...sessions]
      else if (session?.id !== e.session.id) return
      return push()
    }
    case "chat":
      if (!chat || e.event.session !== chat.session) return
      if (chat.held) chat.held.push(e.event)
      else toChat(e.event)
      return
    case "permission":
      if (!owners.has(e.ask.session)) return
      permissions.set(e.ask.id, e.ask)
      return push()
    case "permission-done":
      if (permissions.delete(e.id)) push()
      return
    case "question":
      if (!owners.has(e.question.session)) return
      questions.set(e.question.id, e.question)
      return push()
    case "question-done":
      if (questions.delete(e.id)) push()
      return
  }
}

// ── starting the site ───────────────────────────────────────────────────────────────────────────

/** The app and the server are on one computer, so an address on localhost opens here too. */
function sameComputer() {
  const saved = store.settings().server
  if (saved && "local" in saved) return true
  try {
    return /^(localhost|127(\.\d+){3}|\[::1\]|::1)$/.test(new URL("url" in connection ? connection.url : "").hostname)
  } catch {
    return false
  }
}

/** What the agent is asked when the reviewer has a repo and no running site. It ends with a
 *  line the app can read (SITE_LINE). `failed` is an address that did not answer. */
function startPrompt(failed: string) {
  return [
    "Get this project's site running so I can review it in bicycle 42.",
    ...(failed ? [`I expected it at ${failed}, which did not answer.`] : []),
    "",
    "- If its dev server is already running, use that. Otherwise start it in the background, so it keeps running after you reply.",
    "- If it is plain HTML with nothing to run, serve the folder with a small static server.",
    sameComputer()
      ? "- bicycle 42 runs on the same computer as you, so a localhost address works."
      : "- bicycle 42 runs on a different computer from you, so localhost on your side will not open here. Give an address this computer can reach: bind the server to the network, or use a tunnel if one is set up, and tell me if that makes the site public.",
    "- If you need something from me (which app of several, a missing setting, a port), ask before guessing.",
    "",
    "When it is up, check that it answers, then end your reply with one line: SITE: <address>",
  ].join("\n")
}
const SITE_LINE = /^\s*`?SITE:\s*<?(https?:\/\/[^\s<>`"']{1,2000})>?`?\s*$/gim

/** The agent has answered the request to start the site: the address it ended with is opened,
 *  unless the reviewer has opened a page that works meanwhile. */
async function started(id: string, ok: boolean) {
  starting = false
  push()
  const works = () => !!page?.state().url && !page.state().error
  if (works()) siteAsked = undefined
  const b = backend
  if (!ok || !b || siteAsked !== id) return
  try {
    const items = (await b.transcript(id)).items
    const last = items.findLast((i) => i.kind === "assistant" && !i.summary && i.parts.some((p) => p.kind === "text" && p.text.trim()))
    const said = last?.kind === "assistant" ? last.parts.map((p) => (p.kind === "text" ? p.text : "")).join("\n") : ""
    const url = [...said.matchAll(SITE_LINE)].pop()?.[1]
    if (!url || !originOf(url) || backend !== b || siteAsked !== id || works()) return
    siteAsked = undefined
    page?.load(url)
  } catch (err) {
    log("warn", "can't read where the agent started the site", say(err))
  }
}

const doneCount = (r: Review) => r.rows().reduce((n, row) => n + (row.status === "done" ? 1 : 0), 0)

// ── the page ────────────────────────────────────────────────────────────────────────────────────

/** The pins the page draws. While the server can't be reached nothing is being worked on,
 *  whatever the last word from it was: those pins show as paused, like their rows. */
function pinsOf(review: Review) {
  const pins = review.pins()
  return connection.status === "offline" ? pins.map((p) => (p.status === "working" ? { ...p, status: "paused" as const } : p)) : pins
}

/** What the note card offers after "/": names and one-line hints. The prompts stay in main. */
const NOTE_TEMPLATES = (TEMPLATES as Array<{ name: string; hint: string }>).map(({ name, hint }) => ({ name, hint }))

/** Tells the overlay its note was not taken, so it does not show "Sent" for something that went
 *  nowhere: the card (or the canvas batch) comes back with the reason. */
function refuseNote(raw: unknown, why: string) {
  const id = typeof raw === "object" && raw !== null ? (raw as { id?: unknown }).id : undefined
  if (typeof id === "string" && id.length <= 64) page?.send({ type: "captured", id, ok: false, why })
}

function onPage(msg: PageMessage) {
  const s = site
  if (!s) return void (msg.type === "note" && refuseNote(msg.note, "no site is open"))
  const review = s.review
  switch (msg.type) {
    case "ready":
      // A new document starts in notes mode with the brush off; if it comes back in edit mode
      // (a reload while editing), the overlay says so right after this.
      pageMode = { canvas: false, motion: false, brush: false }
      page?.send({ type: "state", enabled: review.enabled, draft: review.draft, pins: pinsOf(review), templates: NOTE_TEMPLATES })
      return push()
    case "mode":
      // The overlay's own keys change it too (mod+U/P/O/I, Esc, a note sent): the top bar follows.
      pageMode = { canvas: msg.mode === "canvas", motion: msg.mode === "motion", brush: msg.brush === true }
      return push()
    case "toggle":
      review.enabled = typeof msg.enabled === "boolean" ? msg.enabled : !review.enabled
      page?.send({ type: "enabled", enabled: review.enabled })
      return changed(s)
    case "draft":
      review.draft = msg.draft ?? null
      store.saveReview(s.origin, review.toJSON())
      return
    case "pin":
      // A pin was clicked on the page: the window shows that note. Only an id we know goes on.
      if (typeof msg.id === "string" && review.note(msg.id) && window && !window.isDestroyed())
        window.webContents.send("b42:note", { id: msg.id })
      return
    case "pins-placement":
      review.setUnplaced(Array.isArray(msg.unplaced) ? (msg.unplaced as string[]) : [])
      return push()
    case "edits-shown": {
      // The overlay switched a canvas note's edits off or on, as asked (see beforePicture).
      const key = `${String(msg.id)}:${msg.show === true}`
      editsShown.get(key)?.()
      editsShown.delete(key)
      return
    }
    case "note": {
      // The page can call the binding with anything; only a well-formed note goes further.
      const note = pageNote(msg.note)
      if (note) void onNote(s, note)
      else {
        log("warn", "the page sent a malformed note; ignored")
        refuseNote(msg.note, "the app could not read the note")
      }
      return
    }
  }
}

async function onNote(s: Site, pn: PageNote) {
  // Where the note was made is for main to say, not the page: the URL goes into the prompt.
  const url = page?.state().url
  if (url) pn = { ...pn, url }
  // A template with no words is still a note ("/grade"), and so are canvas edits or new CSS
  // rules with no words; words with none of those need words.
  if (!noteWords(pn).trim()) {
    log("warn", "the page sent an empty note; ignored", pn.id)
    return refuseNote(pn, "there is nothing in it the app can send")
  }
  const note = s.review.add({ ...pn, text: noteWords(pn) })
  // (No answer to the second: it has the id of the first, whose own answer is on its way.)
  if (!note) return log("warn", "the page sent a note twice; the second is ignored", pn.id)
  changed(s)
  let files: PromptFile[] = []
  let before: NativeImage | undefined
  const pasted = pn.images ?? []
  try {
    // The overlay hid its note card and pins two frames ago; outlines and strokes stay drawn.
    const shot = page ? await page.capture() : undefined
    // A canvas note's picture shows the page after the edits; take one from before them too.
    if (shot && (pn.edits || pn.css)) before = await beforePicture(pn.id)
    // The pictures are taken: the overlay may take the next selection while the JPEGs are made.
    page?.send({ type: "captured", id: pn.id })
    if (shot) files = noteImages(shot, pn, note.n, before)
  } catch (err) {
    before = undefined
    page?.send({ type: "captured", id: pn.id })
    log("warn", "screenshot failed; the note goes without one", say(err))
  }
  const shots = (before ? files.length - 1 : files.length) as 0 | 1 | 2
  const text = notePrompt(pn, note.n, { images: shots, references: pasted.length, before: !!before })
  outbox.set(note.id, { text, files: [...files, ...pasted] })
  s.review.sending(note.id)
  changed(s)
  await deliver(s, note.id, note.lane)
}

/** How long the overlay gets to switch a canvas note's edits off or on. It answers two frames
 *  after it did; a page that is reloading, or an overlay that doesn't know the message, never does. */
const EDITS_SHOWN_MS = 1000
/** Who waits for which "edits-shown", by `${note id}:${show}`. */
const editsShown = new Map<string, () => void>()

/** Asks the overlay to show or hide a canvas note's edits. Resolves true once it says it has,
 *  false when it did not answer in time. */
function showEdits(id: string, show: boolean): Promise<boolean> {
  const key = `${id}:${show}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      editsShown.delete(key)
      resolve(false)
    }, EDITS_SHOWN_MS)
    editsShown.set(key, () => {
      clearTimeout(timer)
      resolve(true)
    })
    page?.send({ type: "edits", id, show })
  })
}

/** The page as it was before a canvas note's edits: they are switched off for one picture, then
 *  on again, whatever happens in between. Undefined when the overlay did not answer or the
 *  capture failed: the note then goes with the picture from after the edits only. */
async function beforePicture(id: string): Promise<NativeImage | undefined> {
  const from = page
  if (!from) return
  let shot: NativeImage | undefined
  const hidden = await showEdits(id, false)
  try {
    if (hidden) shot = await from.capture()
    else log("warn", "the page did not hide the canvas edits in time; the note goes without a before picture", id)
  } catch (err) {
    log("warn", "the before picture failed; the note goes with the after picture only", say(err))
  }
  // Back on, always: after a timeout too, since the overlay may have hidden them and only its
  // answer was lost. An overlay that answered is waited for, so the reviewer gets the page back
  // as they left it; one that did not is only told.
  if (hidden) await showEdits(id, true)
  else from.send({ type: "edits", id, show: true })
  return shot
}

async function deliver(s: Site, id: string, lane: Lane) {
  const payload = outbox.get(id)
  try {
    if (!payload) throw new Error("The app was restarted, so this note's screenshot is gone. Write the note again.")
    const target = await laneSession(s, lane)
    payload.id ??= backend!.messageId()
    const sent = await backend!.prompt(target, { id: payload.id, text: payload.text, files: payload.files })
    s.review.sent(id, sent.id, target)
  } catch (err) {
    s.review.failed(id, say(err))
  }
  changed(s)
}

/** The conversation a lane's notes go to. The background one is made on its first note: a child
 *  of the main one, on the same model and folder, so its queue runs beside the main queue. */
async function laneSession(s: Site, lane: Lane): Promise<string> {
  if (!backend) throw new Error(connection.status === "unconfigured" ? "Connect to a server first." : "The server is offline.")
  const saved = siteSettings(s.origin)
  if (!saved) throw new Error("Pick this site's folder first.")
  if (s === site && !session) await openSite()
  const main = siteSettings(s.origin)?.session
  if (!main) throw new Error("No conversation is open for this site.")
  if (lane === "main") return main
  const known = siteSettings(s.origin)?.bg
  if (known && (await backend.session(known))) return known
  let pending = backgrounds.get(s.origin)
  if (!pending) {
    const b = backend
    pending = (async () => {
      const parent = await b.session(main)
      const made = await b.createSession({
        directory: saved.directory,
        parent: main,
        title: "Background notes",
        ...(parent?.model ? { model: parent.model } : {}),
      })
      owners.set(made.id, s.origin)
      store.update((x) => void (x.sites[s.origin] && (x.sites[s.origin]!.bg = made.id)))
      return made.id
    })()
    backgrounds.set(s.origin, pending)
    void pending.catch(() => undefined).finally(() => backgrounds.delete(s.origin))
  }
  return pending
}
/** Two alt+Enter notes in a row must not make two background conversations. */
const backgrounds = new Map<string, Promise<string>>()

// ── commands from the window ────────────────────────────────────────────────────────────────────

/** The app's own slash commands, as "/" lists them, above the server's. */
const BUILTINS: SlashCommand[] = [
  { name: "compact", description: "Summarise the conversation to free up context", builtin: true },
  { name: "new", description: "Start a new conversation", builtin: true },
  { name: "undo", description: "Take back your last message and what the agent did after it", builtin: true },
  { name: "redo", description: "Bring back what /undo took away", builtin: true },
  { name: "rename", description: "Name this conversation: /rename new name", builtin: true },
  { name: "fork", description: "Go on in a copy of this conversation", builtin: true },
]

/** What "/undo yes" is: the word that confirms. */
const UNDO_CONFIRM = "yes"
const quoted = (text: string) => JSON.stringify(text.length > 60 ? `${text.slice(0, 59)}…` : text)

/** Makes `id` the site's conversation and opens it. */
async function switchTo(id: string) {
  const s = site
  if (!s || !siteSettings(s.origin)) return
  store.update((x) => {
    const entry = x.sites[s.origin]
    if (entry && entry.session !== id) (entry.session = id), delete entry.bg
  })
  session = null
  await openSite()
}

type Builtin = (b: Backend, current: SessionSummary, args: string, options?: SendOptions) => Promise<CommandResult | void>

const builtins: Record<string, Builtin> = {
  // The summary arrives as chat events; so does "nothing to compact yet". Notes are not
  // touched: they follow their own messages, and what is queued still runs.
  async compact(b, current, _args, options) {
    const delivery = options?.delivery === "queue" || options?.delivery === "steer" ? options.delivery : undefined
    await b.compact(current.id, delivery ? { delivery } : undefined)
  },
  async new() {
    await commands.newSession()
  },
  // Two steps, because it cannot be done by halves: the server takes back everything from that
  // message on, the agent's file changes included. The first "/undo" only says what would go.
  async undo(b, current, args) {
    if (session?.id === current.id && session.busy) throw new Error("The agent is working. Stop it first, then /undo.")
    const turn = await b.lastTurn(current.id)
    if (!turn) throw new Error("Nothing to undo.")
    const what = turn.note ? `note ${turn.note.n} (${quoted(turn.note.text)})` : `your message ${quoted(turn.text)}`
    if (args !== UNDO_CONFIRM)
      return {
        say: `This takes back ${what} and everything after it: the agent's replies, and the changes it made to files since then. Press Enter to undo.`,
        draft: `/undo ${UNDO_CONFIRM}`,
      }
    await b.undo(current.id, turn.id)
    // A note cannot be sent again from the message box; a typed message can, so it comes back.
    return { say: `Took back ${what}. /redo brings it back; your next message makes it final.`, ...(turn.note ? {} : { draft: turn.text }) }
  },
  async redo(b, current) {
    const now = await b.session(current.id)
    if (!now?.undone) throw new Error("Nothing to redo.")
    await b.redo(current.id)
    return { say: "Brought back what was undone." }
  },
  async rename(b, current, args) {
    if (!args) throw new Error("Type the new name after /rename.")
    await b.rename(current.id, args)
    if (session?.id === current.id) (session = { ...session, title: args }), push()
    void refreshSessions()
    return { say: `Renamed to ${quoted(args)}.` }
  },
  async fork(b, current) {
    const copy = await b.fork(current.id)
    await switchTo(copy.id)
    return { say: "This is a copy. The original is still in the list of conversations." }
  },
}

const need = () => {
  if (!backend) throw new Error("Not connected to a server.")
  return backend
}
const needSession = () => {
  if (!session) throw new Error("No conversation is open yet.")
  return session
}
/** The request (permission or question) with this id, and the conversation it belongs to. */
const pendingSession = (map: Map<string, { session: string }>, id: string) => {
  const found = map.get(id)
  if (!found) throw new Error("That request is no longer waiting.")
  return found.session
}

/** Pictures pasted into the message box, checked and named for the server. At most four. */
function pictures(images: PromptFile[] | undefined): PromptFile[] {
  const files: PromptFile[] = []
  for (const im of (images ?? []).slice(0, 4)) {
    const uri = imageUri(im.uri)
    if (!uri) throw new Error("One of the pictures could not be read. Remove it and send again.")
    files.push({ name: `image-${files.length + 1}.${uri.slice(11, uri.indexOf(";"))}`, uri })
  }
  return files
}

const MENTION_KINDS = new Set<unknown>(["file", "folder", "skill", "agent"])

/** What a message sends besides its text: the delivery, and its mentions with each file or
 *  folder resolved against the conversation's folder (the window only knows relative paths).
 *  The window's input is checked here; a malformed mention is dropped, not sent. */
function sendOptions(options: SendOptions | undefined, directory: string): { mentions?: Mention[]; delivery?: SendOptions["delivery"] } {
  const o = (options ?? {}) as Record<string, unknown>
  const mentions: Mention[] = []
  for (const raw of Array.isArray(o.mentions) ? o.mentions : []) {
    const m = (raw ?? {}) as Record<string, unknown>
    if (!MENTION_KINDS.has(m.kind) || typeof m.id !== "string" || !m.id || typeof m.start !== "number" || typeof m.end !== "number") continue
    const kind = m.kind as Mention["kind"]
    const id = kind === "file" || kind === "folder" ? path.posix.resolve(directory, m.id) : m.id
    mentions.push({ kind, id, start: m.start, end: m.end })
  }
  return {
    ...(mentions.length ? { mentions } : {}),
    ...(o.delivery === "steer" || o.delivery === "queue" ? { delivery: o.delivery } : {}),
  }
}

/** The folder of the conversation messages go to. */
const chatDirectory = (s: SessionSummary) => (site && siteSettings(site.origin)?.directory) || s.directory

/** Per connection, so a new server (or the same one reconnected) is asked again. Failed reads
 *  are not kept. */
const lookups = new WeakMap<OpenCode, Map<string, Promise<unknown>>>()
function cached<T>(b: OpenCode, key: string, read: () => Promise<T>): Promise<T> {
  let map = lookups.get(b)
  if (!map) lookups.set(b, (map = new Map()))
  let hit = map.get(key) as Promise<T> | undefined
  if (!hit) {
    const p = read()
    map.set(key, p)
    p.catch(() => map!.get(key) === p && map!.delete(key))
    hit = p
  }
  return hit
}

const MENTIONS_MAX = 20

const commands: { [K in CommandName]: (...args: Parameters<Commands[K]>) => ReturnType<Commands[K]> | Promise<ReturnType<Commands[K]>> } = {
  navigate(url) {
    page?.load(url)
  },
  reload() {
    page?.reload()
  },
  back() {
    page?.back()
  },
  forward() {
    page?.forward()
  },
  setPageBounds(bounds) {
    page?.setBounds(bounds)
  },

  toggleReview() {
    if (!site) return
    site.review.enabled = !site.review.enabled
    page?.send({ type: "enabled", enabled: site.review.enabled })
    if (site.review.enabled) page?.focus()
    changed(site)
  },
  setMode(mode) {
    if (!site) return
    const on = mode !== "preview"
    if (site.review.enabled !== on) {
      site.review.enabled = on
      page?.send({ type: "enabled", enabled: on })
    }
    if (on) {
      // Shown at once; the overlay answers with the mode it is in, and that is what stays.
      pageMode = { canvas: mode === "edit", motion: mode === "motion", brush: mode === "notes" ? pageMode.brush : false }
      page?.send({ type: "mode", mode: pageMode.canvas ? "canvas" : pageMode.motion ? "motion" : "notes" })
      page?.focus()
    }
    changed(site)
  },
  toggleBrush() {
    if (!site) return
    const on = !(site.review.enabled && pageMode.brush)
    if (on && !site.review.enabled) {
      site.review.enabled = true
      page?.send({ type: "enabled", enabled: true })
    }
    pageMode = { canvas: on ? false : pageMode.canvas, motion: on ? false : pageMode.motion, brush: on }
    page?.send({ type: "mode", brush: on })
    if (on) page?.focus()
    changed(site)
  },
  toggleAutoReload() {
    if (!site) return
    site.review.autoReload = !site.review.autoReload
    changed(site)
  },
  clearNotes() {
    if (!site) return
    site.review.clearFinished()
    changed(site)
  },
  async retryNote(id) {
    const s = site
    if (!s) return
    // A note the server had accepted (then stopped, or lost with its conversation) goes again as
    // a new message. One that may never have arrived keeps its id, so it can't be queued twice.
    const accepted = !!s.review.note(id)?.message
    const note = s.review.retry(id)
    if (!note) return
    const payload = outbox.get(id)
    if (payload && accepted) delete payload.id
    changed(s)
    await deliver(s, note.id, note.lane)
  },
  removeNote(id) {
    if (!site) return
    site.review.remove(id)
    changed(site)
  },
  showNote(id) {
    const at = site?.review.note(id)?.anchor.at
    if (at) void page?.evaluate(`window.scrollTo({ top: Math.max(0, ${Number(at[1])} - innerHeight / 3), behavior: "smooth" })`)
  },

  async connect(server) {
    if (!server.password) throw new Error("Enter the server password.")
    await connect(serverUrl(server.url), server.password, { save: "remote" })
  },
  localServer() {
    const found = readLocal()
    return found ? { url: found.url } : null
  },
  async connectLocal() {
    const found = readLocal()
    if (!found) throw new Error(NO_LOCAL)
    await connect(found.url, found.password, { save: "local" })
  },
  async reconnect() {
    await reconnectSaved()
  },
  disconnect() {
    drop()
    store.update((s) => void delete s.server)
    connection = { status: "unconfigured" }
    toChat({ type: "reset", session: "", items: [] })
    push()
  },
  projects: () => need().projects(),
  listFolders: (dir) => need().listFolders(dir),
  async setDirectory(directory) {
    if (typeof directory !== "string" || !directory.startsWith("/")) throw new Error("Choose a folder.")
    const origin = site?.origin
    store.update((s) => {
      s.folder = directory
      if (origin) s.sites[origin] = { directory }
    })
    session = null
    // No page and no repo until now: the repo's own place opens, and its conversation with it.
    if (!site) return void (switchSite(placeOf(page?.state().url ?? "")), await openSite())
    push()
    await openSite()
  },
  async openProject(directory) {
    if (typeof directory !== "string" || !directory.startsWith("/")) throw new Error("Choose a folder.")
    need()
    // Its site, as it was last open: the one visited most recently among those that work in it.
    const known = Object.entries(store.settings().sites)
      .filter(([origin, entry]) => origin !== HOME && entry.directory === directory)
      .sort((a, b) => (b[1].seen ?? 0) - (a[1].seen ?? 0))[0]
    const here = site && site.origin !== HOME && siteSettings(site.origin)?.directory === directory
    store.update((s) => {
      s.folder = directory
      // No site of its own yet: the next launch starts in the repo too, not on the last project's page.
      if (!known && !here) delete s.lastUrl
    })
    siteAsked = undefined
    starting = false
    if (here) return push() // already on one of its sites
    const to = known ? (known[1].url ?? known[0]) : ""
    if (page?.state().url === to) switchSite(placeOf(to), true)
    else page?.load(to)
    await openSite()
  },
  async startSite() {
    const b = need()
    const current = needSession()
    const p = page?.state()
    siteAsked = current.id
    starting = true
    push()
    try {
      await b.prompt(current.id, { text: startPrompt(p?.error ? p.url : "") })
    } catch (err) {
      siteAsked = undefined
      starting = false
      push()
      throw err
    }
  },

  async send(text, images, options) {
    if (!text.trim()) return
    const b = need()
    const current = needSession()
    const files = pictures(images)
    await b.prompt(current.id, { text, ...(files.length ? { files } : {}), ...sendOptions(options, chatDirectory(current)) })
  },
  async commands() {
    const b = need()
    const directory = site && siteSettings(site.origin)?.directory
    if (!directory) return [] as SlashCommand[]
    // The app's own first. The server's list is extra: without it "/" still works.
    const theirs = await cached(b, `commands:${directory}`, () => b.commands(directory)).catch((err) => {
      log("warn", "can't list the server's commands", say(err))
      return [] as SlashCommand[]
    })
    return [...BUILTINS, ...theirs.filter((c) => !(c.name in builtins))]
  },
  async runCommand(name, args, images, options) {
    const b = need()
    const current = needSession()
    if (typeof name !== "string" || !name.trim()) throw new Error("Which command? Type its name after the slash.")
    const builtin = builtins[name.trim()]
    if (builtin) return builtin(b, current, typeof args === "string" ? args.trim() : "", options)
    const files = pictures(images)
    await b.command(current.id, {
      name: name.trim(),
      text: typeof args === "string" ? args : "",
      ...(files.length ? { files } : {}),
      ...sendOptions(options, chatDirectory(current)),
    })
  },
  async mentions(query) {
    const b = need()
    const directory = site && siteSettings(site.origin)?.directory
    if (!directory) return [] as MentionOption[]
    const [skills, helpers] = await Promise.all([
      cached(b, `skills:${directory}`, () => b.skills(directory)),
      cached(b, "agents", () => b.mentionAgents()),
    ])
    const typed = (typeof query === "string" ? query : "").trim()
    const q = typed.toLowerCase()
    if (!q) return [...skills, ...helpers].slice(0, MENTIONS_MAX)
    const named = [...skills, ...helpers].filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q))
    // Files first: they are what a message names most. Room is kept for a few named matches.
    const files = (await b.findFiles(directory, typed)).slice(0, MENTIONS_MAX - Math.min(named.length, MENTIONS_MAX / 2))
    return [...files, ...named].slice(0, MENTIONS_MAX)
  },
  async cancelQueued(item) {
    if (typeof item !== "string" || !item) return
    await need().cancelQueued(needSession().id, item)
  },
  async stop() {
    await need().stop(needSession().id)
  },
  async newSession() {
    const s = site
    if (!s || !siteSettings(s.origin)) throw new Error("Pick this site's folder first.")
    need()
    store.update((x) => {
      const entry = x.sites[s.origin]
      if (entry) delete entry.session, delete entry.bg
    })
    session = null
    await openSite()
  },
  async openSession(id) {
    const s = site
    if (!s || !siteSettings(s.origin)) return
    if (!(await need().session(id))) throw new Error("That conversation no longer exists.")
    await switchTo(id)
  },
  async setModel(model) {
    const current = needSession()
    await need().setModel(current.id, model)
    store.update((s) => void (s.defaultModel = { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) }))
    if (session?.id === current.id) session = { ...session, model }
    push()
  },
  setServerName(name) {
    const server = store.settings().server
    if (!server) throw new Error("Connect to a server first.")
    const clean = name.replace(/\s+/g, " ").trim().slice(0, SERVER_NAME_MAX)
    store.update((s) => {
      if (!s.server) return
      if (clean) s.server.name = clean
      else delete s.server.name
    })
    push()
  },
  async setDefaultModel(model) {
    const known = models.find((m) => typeof model?.providerID === "string" && typeof model.id === "string" && sameModel(model, m))
    if (!known) throw new Error("This server does not offer that model. Choose another one.")
    const variant = typeof model.variant === "string" && known.variants.includes(model.variant) ? model.variant : undefined
    store.update((s) => void (s.defaultModel = { providerID: known.providerID, id: known.id, ...(variant ? { variant } : {}) }))
    modelChoice = undefined
    push()
    // The conversation that waited for this answer can be made now.
    if (!session) await openSite()
  },
  async setAgent(id) {
    const current = needSession()
    await need().setAgent(current.id, id)
    if (session?.id === current.id) session = { ...session, agent: id }
    push()
  },
  async replyPermission(id, decision) {
    await need().replyPermission(pendingSession(permissions, id), id, decision)
    // The server confirms with an event; don't leave the card up if that event is missed.
    if (permissions.delete(id)) push()
  },
  async answerQuestion(id, answer) {
    await need().answerQuestion(pendingSession(questions, id), id, answer)
    if (questions.delete(id)) push()
  },
  async dismissQuestion(id) {
    await need().dismissQuestion(pendingSession(questions, id), id)
    if (questions.delete(id)) push()
  },
}

// ── window ──────────────────────────────────────────────────────────────────────────────────────

function menu() {
  const mac = process.platform === "darwin"
  // No "Reload" item: ⌘R belongs to the page under review, not to the app window.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac ? [{ role: "appMenu" as const }] : []),
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "togglefullscreen" },
          { type: "separator" },
          { label: "Developer Tools: App", accelerator: "Alt+CmdOrCtrl+I", click: () => window?.webContents.openDevTools({ mode: "detach" }) },
          { label: "Developer Tools: Page", accelerator: "Alt+CmdOrCtrl+J", click: () => page?.view.webContents.openDevTools({ mode: "detach" }) },
        ],
      },
      { role: "windowMenu" },
    ]),
  )
}

/** The app icon, copied beside the bundle by scripts/build.mjs. Absent in a build without assets. */
const iconFile = path.join(__dirname, "icon.png")
const appIcon = fs.existsSync(iconFile) ? iconFile : undefined

async function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  const win = (window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "bicycle 42",
    ...(appIcon ? { icon: appIcon } : {}),
    // The design system's paper and near-black, so the window doesn't flash before the UI paints.
    backgroundColor: dark ? "#0a0a0a" : "#f1eadf",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  }))
  // The app window shows only the app. Links go to the system browser.
  win.webContents.on("will-navigate", (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  win.once("ready-to-show", () => win.show())
  win.on("closed", () => {
    page?.dispose()
    page = undefined
    window = undefined
  })

  page = await createPage(win, {
    overlay: fs.readFileSync(path.join(__dirname, "overlay.js"), "utf8"),
    lookup: fs.readFileSync(path.join(__dirname, "overlay-lookup.js"), "utf8"),
    onMessage: onPage,
    onChange() {
      const url = page?.state().url ?? ""
      if (url && url !== store.settings().lastUrl) store.update((s) => void (s.lastUrl = url))
      switchSite(placeOf(url))
      // Where a project's site was last open, for coming back to it (openProject).
      const at = originOf(url)
      if (at && siteSettings(at) && siteSettings(at)!.url !== url) store.update((s) => void (s.sites[at] && Object.assign(s.sites[at], { url, seen: Date.now() })))
      push()
    },
    onShortcut(key) {
      if (key === "toggle-review") return void commands.toggleReview()
      const shortcut: Shortcut = key
      win.webContents.send("b42:shortcut", shortcut)
      // The keys were pressed in the page; the field they lead to is in the window.
      win.webContents.focus()
    },
    log,
  })
  await win.loadFile(path.join(__dirname, "renderer/index.html"))
  page.load(store.settings().lastUrl ?? "")
}

ipcMain.handle("b42:state", () => snapshot())
ipcMain.handle("b42:chat", () => {
  if (session) void openChat(session.id)
  else toChat({ type: "reset", session: "", items: [] })
})
ipcMain.handle("b42:command", async (_event, name: CommandName, args: unknown[]) => {
  const run = commands[name] as ((...a: unknown[]) => unknown) | undefined
  if (!run) throw new Error(`Unknown command: ${String(name)}`)
  try {
    return await run(...(Array.isArray(args) ? args : []))
  } catch (err) {
    // Electron wraps a thrown Error in "Error invoking remote method …"; send only the sentence.
    log("warn", `${name} failed`, say(err))
    throw new Error(say(err))
  }
})

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on("window-all-closed", () => app.quit())
  app.on("before-quit", () => {
    unlisten?.()
    store.flush()
  })
  void app.whenReady().then(async () => {
    menu()
    // From source on macOS the dock would show Electron's own icon.
    if (appIcon && process.platform === "darwin") app.dock?.setIcon(appIcon)
    await createWindow()
    void reconnectSaved()
    if (store.readOnly && window)
      void dialog.showMessageBox(window, {
        type: "warning",
        message: "Settings were written by a newer bicycle 42",
        detail: "This version leaves them untouched, so nothing you change now will be remembered. Update bicycle 42 to keep your changes.",
      })
  })
}

/** For the end-to-end test only: a way to look inside without a second IPC surface. */
if (process.env.BICYCLE42_TEST) {
  ;(globalThis as Record<string, unknown>).__b42Test = {
    window: () => window,
    page: () => page,
    snapshot,
  }
}

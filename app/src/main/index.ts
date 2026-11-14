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
  ChatItem,
  ChatMarker,
  Checkpoint,
  Commands,
  CommandName,
  ConnectionState,
  ContextUse,
  FileChange,
  Lane,
  Mention,
  MentionOption,
  ModelInfo,
  ModelRef,
  PermissionAsk,
  PromptFile,
  Question,
  SendOptions,
  ProjectInfo,
  RepoChange,
  RunningCommand,
  ServerInfo,
  SessionSummary,
  Shortcut,
  SlashCommand,
} from "../shared/types"
import { noteImages } from "./images"
import { readLocal } from "./local"
import { isPlaceholder, placeholderTitle, titleFrom } from "./naming"
import { createOpenCode, type OpenCode } from "./opencode"
import { createPage, type Page, type PageMessage } from "./page"
import { createReview, imageUri, pageNote, type PageNote, type Review } from "./review"
import { createShots } from "./shots"
import { createStore, type SavedServer } from "./store"

type Level = "info" | "warn" | "error"
const log = (level: Level, msg: string, data?: unknown) =>
  console[level === "info" ? "log" : level](`[bicycle42] ${msg}`, data === undefined ? "" : data)

/** Errors meant for the person at the screen; anything else gets a generic prefix. */
const say = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Tests point the app at a scratch profile. Otherwise the folder is named here, so the packaged
// app ("bicycle 42") and a run from source keep their settings and notes in the same place.
app.setPath("userData", process.env.BICYCLE42_DATA || path.join(app.getPath("appData"), "bicycle42"))

const store = createStore(app.getPath("userData"), { log })
const noteShots = createShots(app.getPath("userData"), log)

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
const SESSION_TITLE_MAX = 120
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
 *  `again` asks for one more read after this one (something was missed meanwhile), and
 *  `counted` is the context's count that arrived meanwhile. */
let chat: { session: string; held: ChatEvent[] | null; again: boolean; counted?: { context?: ContextUse } } | undefined

/** What the context of the conversation on screen held at the agent's last finished step.
 *  Undefined when nothing has measured it. */
let measured: { session: string; use: ContextUse } | undefined

/** The open conversation's context for the window: the measurement, beside the window of the
 *  model the conversation is on. The server sets aside a count made by another provider's
 *  model when it decides whether the context is full, so it is not shown either. */
function contextShown(): AppState["context"] {
  // A conversation the server names no model for runs on the default, as the pickers show it.
  const model = session?.model ?? defaultModel()
  if (!measured || !session || measured.session !== session.id) return undefined
  if (model && measured.use.providerID && measured.use.providerID !== model.providerID) return undefined
  const limit = model && models.find((m) => m.providerID === model.providerID && m.id === model.id)?.context
  return { used: measured.use.used, ...(limit ? { limit } : {}) }
}

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
/** A repo that turned out not to be on this server, until another is chosen. */
let missingFolder: string | undefined
let siteAsked: string | undefined
let starting = false

/** The name the server in use goes by: the reviewer's, else its computer's own. */
function serverName(): string | undefined {
  const s = store.settings()
  if (!s.server) return undefined
  return s.server.name ?? s.servers?.find((x) => x.id === s.current)?.computer
}

function snapshot(): AppState {
  const p = page?.state()
  const review = site?.review
  const saved = site && siteSettings(site.origin)
  const model = defaultModel()
  return {
    connection,
    ...(serverName() ? { serverName: serverName() } : {}),
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
    ...(missingFolder && !saved ? { missingFolder } : {}),
    running: runningShown(),
    ...(repo ? { repo } : {}),
    session,
    sessions: listed(),
    models,
    agents,
    ...(model ? { defaultModel: model } : {}),
    ...(modelChoice && model ? { modelChoice: { suggested: model, ...(modelChoice.previous ? { previous: modelChoice.previous } : {}) } } : {}),
    permissions: [...permissions.values()],
    questions: [...questions.values()],
    ...(contextShown() ? { context: contextShown() } : {}),
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
  store.saveReview(reviewKey(s.origin), s.review.toJSON())
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
  running = []
  clearTimeout(runningTimer)
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

// ── the servers connected to ────────────────────────────────────────────────────────────────────

/** A site's notes are kept per server: the same address (localhost:3000) on two machines is two sites. */
const reviewKey = (origin: string) => (store.settings().prefix ?? "") + origin

/** The saved entry for a server, made the first time it is connected to; a remote one's password is kept up to date. */
function remember(kind: "remote" | "local", url: string, password: string, computer?: string): SavedServer {
  const all = store.settings().servers ?? []
  let found = all.find((x) => (kind === "local" ? "local" in x : "url" in x && x.url === url))
  store.update((s) => {
    s.servers ??= []
    if (!found) {
      const id = `srv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      // A server saved before servers were kept: the name it had then stays with it.
      const name = !s.current && s.server?.name ? { name: s.server.name } : {}
      found = kind === "local" ? { id, local: true, ...name } : { id, url, password: seal(password), ...name }
      s.servers.push(found)
    } else if ("url" in found) found.password = seal(password)
    if (computer) found.computer = computer
  })
  return found!
}

/** Makes `id` the server in use: what belongs to the one before (its repo, pages, conversations,
 *  model) is put away with it, and this one's is brought out, with the page it was on. */
function enter(id: string) {
  const s = store.settings()
  if (s.current === id) return
  // The first server ever, or the one saved before servers were kept: what is here is its own.
  if (!s.current) return store.update((x) => void ((x.current = id), (x.prefix ??= "")))
  store.update((x) => {
    const out = x.servers?.find((v) => v.id === x.current)
    if (out) out.space = { ...(x.folder ? { folder: x.folder } : {}), ...(x.lastUrl ? { lastUrl: x.lastUrl } : {}), ...(x.defaultModel ? { defaultModel: x.defaultModel } : {}), sites: x.sites, prefix: x.prefix ?? "" }
    const into = x.servers?.find((v) => v.id === id)
    const space = into?.space ?? { sites: {}, prefix: `${id}~` }
    delete into?.space
    delete x.folder, delete x.lastUrl, delete x.defaultModel
    if (space.folder) x.folder = space.folder
    if (space.lastUrl) x.lastUrl = space.lastUrl
    if (space.defaultModel) x.defaultModel = space.defaultModel
    x.sites = space.sites
    x.prefix = space.prefix
    x.current = id
  })
  // Nothing loaded belongs here: notes still in flight on the other server are read again when it is gone back to.
  sites.clear()
  owners.clear()
  outbox.clear()
  site = undefined
  siteAsked = undefined
  starting = false
  missingFolder = undefined
  modelChoice = undefined
  toChat({ type: "reset", session: "", items: [] })
  page?.load(store.settings().lastUrl ?? "")
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
  // It is also kept among the servers connected to, with the name it was given there.
  const kind = opts.save ?? (store.settings().server && "local" in store.settings().server! ? "local" : "remote")
  const kept = remember(kind, url, password, info.computer)
  const name = kept.name ? { name: kept.name } : {}
  if (opts.save === "remote") store.update((s) => void (s.server = { url, password: seal(password), ...name }))
  if (opts.save === "local") store.update((s) => void (s.server = { local: true, ...name }))
  enter(kept.id)
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
  void refreshRunning(true)
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
    if (!s) sites.set(origin, (s = { origin, review: createReview(store.loadReview(reviewKey(origin))) }))
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
  // A folder of another computer (kept from before servers had their own, or typed by hand)
  // would open conversations that cannot work: the repo is asked for again instead.
  if (!(await folderExists(b, saved.directory))) {
    if (backend !== b || site !== s) return
    missingFolder = saved.directory
    store.update((x) => {
      delete x.sites[s.origin]
      if (x.folder === saved.directory) delete x.folder
    })
    session = null
    return push()
  }
  try {
    let current = saved.session ? await b.session(saved.session) : null
    // A new conversation starts on the model the person chose: while that is being asked,
    // none is made. setDefaultModel comes back here.
    if (!current && modelChoice) return
    if (!current) {
      current = await b.createSession({
        directory: saved.directory,
        title: placeholderTitle(s.origin === HOME ? folderName(saved.directory) : new URL(s.origin).host),
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
    void refreshRunning()
    void refreshRepo()
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

/** Whether `directory` is a folder on the server. Only a clear no counts: when the server
 *  can't be asked, the folder is taken to be there, as before. */
const folders = new WeakMap<OpenCode, Set<string>>()
async function folderExists(b: OpenCode, directory: string): Promise<boolean> {
  const seen = folders.get(b) ?? folders.set(b, new Set()).get(b)!
  if (seen.has(directory) || directory === "/") return true
  try {
    await b.listFolders(directory)
    seen.add(directory)
    return true
  } catch (err) {
    // The server's own word for it: 404, FileNotFoundError "Directory not found".
    return !((err as { status?: number }).status === 404 && /FileNotFound|Directory not found/i.test(say(err)))
  }
}

/** What a saved server is called: the reviewer's name, its computer's own, or its address. */
const serverCalled = (x: SavedServer) => x.name ?? x.computer ?? ("url" in x ? x.url.replace(/^https?:\/\//, "") : "this computer")

/** The site's conversations as the list shows them: the ones not put away, the pinned first,
 *  each with the count and the words of the notes it was sent (the background conversation's
 *  count with the conversation it runs beside). */
function listed(): SessionSummary[] {
  const saved = site && siteSettings(site.origin)
  const pinned = new Set(saved?.pinned ?? [])
  const said = new Map<string, string[]>()
  for (const n of site?.review.said() ?? []) {
    const id = n.session === saved?.bg && saved.session ? saved.session : n.session
    said.set(id, [...(said.get(id) ?? []), n.text])
  }
  const all = sessions
    .filter((x) => !x.archived)
    .map((x) => {
      const words = said.get(x.id)
      return {
        ...x,
        ...(pinned.has(x.id) ? { pinned: true as const } : {}),
        ...(words ? { notes: words.length, said: words.join("\n").toLowerCase().slice(0, 2000) } : {}),
      }
    })
  return [...all.filter((x) => x.pinned), ...all.filter((x) => !x.pinned)]
}

/** A conversation has a new name: here at once, without waiting for the server to say so. */
function retitle(id: string, title: string) {
  if (session?.id === id) session = { ...session, title }
  sessions = sessions.map((x) => (x.id === id ? { ...x, title } : x))
  push()
}

/** Names a conversation after what was just said in it, while it still has its placeholder.
 *  A name a person gave is left alone. */
const naming = new Set<string>()
async function autoName(id: string, text: string) {
  const b = backend
  const known = session?.id === id ? session : sessions.find((x) => x.id === id)
  const title = known && isPlaceholder(known.title) ? titleFrom(text) : undefined
  if (!b || !title || naming.has(id)) return
  naming.add(id)
  try {
    await b.rename(id, title)
    retitle(id, title)
  } catch (err) {
    log("warn", "can't name the conversation", say(err))
  } finally {
    naming.delete(id)
  }
}

/** The conversation on screen is going (put away, or deleted): the site moves to the most
 *  recent other one, or gets a new one. */
async function leave(id: string) {
  const s = site
  if (!s) return
  const next = sessions.find((x) => x.id !== id && !x.archived)
  store.update((x) => {
    const entry = x.sites[s.origin]
    if (!entry || entry.session !== id) return
    if (next) entry.session = next.id
    else delete entry.session
    delete entry.bg
  })
  session = null
  await openSite()
}

function unpin(id: string) {
  store.update((x) => {
    for (const entry of Object.values(x.sites)) {
      if (!entry.pinned?.includes(id)) continue
      entry.pinned = entry.pinned.filter((p) => p !== id)
      if (!entry.pinned.length) delete entry.pinned
    }
  })
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
  const mine: NonNullable<typeof chat> = (chat = { session: id, held: [], again: false })
  try {
    const t = await b.transcript(id)
    if (chat !== mine) return
    for (const [k, p] of permissions) if (p.session === id) permissions.delete(k)
    for (const [k, q] of questions) if (q.session === id) questions.delete(k)
    for (const p of t.permissions) permissions.set(p.id, p)
    for (const q of t.questions) questions.set(q.id, q)
    measured = t.context && { session: id, use: t.context }
    toChat({ type: "reset", session: id, items: withCheckpoints(id, t.items) })
    // A conversation from before conversations were named, or named nowhere else: by what was
    // first said in it. (Asking for the site to be started is the app's words, not a subject.)
    const first = t.items.find((i) => i.kind === "user" && !i.text.startsWith(START_PROMPT))
    if (first?.kind === "user") void autoName(id, first.note?.text || first.text)
    // Events that arrived during the read. Upserts repeat harmlessly; a text delta already in the
    // transcript shows twice until its block ends, which replaces the text.
    for (const e of mine.held ?? []) toChat(e)
    // …and what was counted during it, which is newer than what the read saw.
    if (mine.counted) measured = mine.counted.context && { session: id, use: mine.counted.context }
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
      // A run that ends may have left something running, or stopped it.
      if (e.type === "run" && e.status !== "started") void refreshRunning()
      if (e.type === "run" && siteAsked === e.session) {
        if (e.status === "started") (starting = true), push()
        else void started(e.session, e.status === "succeeded")
      }
      const origin = owners.get(e.session)
      const s = origin ? sites.get(origin) : undefined
      if (!s) return
      const done = doneCount(s.review)
      const was = new Set(doneIds(s.review))
      const touched =
        e.type === "inbox" ? s.review.inbox(e.session, e.id, e.status) : s.review.run(e.session, e.status, e.error)
      if (e.type === "run" && e.status !== "started" && s === site) void refreshRepo()
      if (e.type === "run" && e.status !== "started" && reversing.delete(e.session)) showFiles(s)
      if (!touched) return
      changed(s)
      // Show the agent's change: a page without hot reload still has the old pixels.
      if (s === site && s.review.autoReload && doneCount(s.review) > done) page?.reloadWhenIdle()
      // …and keep a picture of it, beside the one from when the note was made.
      for (const id of doneIds(s.review)) if (!was.has(id)) afterPictures = afterPictures.then(() => afterPicture(s, id))
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
    case "context":
      if (!chat || e.session !== chat.session) return
      // During a read of the conversation the count waits, like the chat's events: the read
      // may have seen less.
      if (chat.held) return void (chat.counted = { context: e.context })
      measured = e.context && { session: e.session, use: e.context }
      return push()
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

// ── what is left running ────────────────────────────────────────────────────────────────────────
// A dev server the agent started goes on after its reply, and after the app has moved to
// another project. The server knows what it is still running in each folder; the app shows
// it in the address line, where it can be stopped.

let running: RunningCommand[] = []
/** A command this young is most likely one of the step the agent is on, not something left behind. */
const RUNNING_SETTLED_MS = 15_000
const RUNNING_EVERY_MS = 20_000
let runningTimer: ReturnType<typeof setTimeout> | undefined

function runningShown(): RunningCommand[] {
  const here = site && siteSettings(site.origin)?.directory
  const now = Date.now()
  return running
    .filter((r) => now - r.started >= RUNNING_SETTLED_MS)
    .sort((a, b) => Number(b.directory === here) - Number(a.directory === here) || a.directory.localeCompare(b.directory) || a.started - b.started)
}

/** Reads what is running: in the open repo, or with `everywhere` in every project the server
 *  knows (asked on connecting, on changing project, and when the list is opened). */
async function refreshRunning(everywhere = false) {
  const b = backend
  clearTimeout(runningTimer)
  if (!b) return
  const here = site && siteSettings(site.origin)?.directory
  try {
    const where = everywhere ? [...new Set([...(here ? [here] : []), ...(await Promise.resolve(commands.projects()).catch(() => [] as string[]))])] : here ? [here] : []
    const found = await Promise.all(where.map((d) => b.running(d).catch(() => undefined)))
    if (backend !== b) return
    // A folder that could not be asked keeps what was known of it; one not asked this time too.
    const asked = new Set(where.filter((_, i) => found[i]))
    const before = JSON.stringify(runningShown())
    running = [...running.filter((r) => !asked.has(r.directory)), ...found.flatMap((f) => f ?? [])]
    if (JSON.stringify(runningShown()) !== before) push()
  } finally {
    if (backend === b) (runningTimer = setTimeout(() => void refreshRunning(), RUNNING_EVERY_MS)).unref()
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
const START_PROMPT = "Get this project's site running so I can review it in bicycle 42."
function startPrompt(failed: string) {
  return [
    START_PROMPT,
    ...(failed ? [`I expected it at ${failed}, which did not answer.`] : []),
    "",
    "- If its dev server is already running, use that. Otherwise start it as a background command of your shell tool, so it keeps running after you reply and I can stop it from bicycle 42. Do not detach it with nohup, & or a terminal multiplexer.",
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
const doneIds = (r: Review) => r.rows().flatMap((row) => (row.status === "done" ? [row.id] : []))
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The site's files changed with no note finished (something was taken back, or brought back):
 *  a page without hot reload still has the old pixels, like after a note. */
const showFiles = (s: Site | null | undefined) => {
  if (s && s === site && s.review.autoReload) page?.reloadWhenIdle()
}
/** Conversations whose agent was asked to take a note back: its files change when that run ends. */
const reversing = new Set<string>()

// ── a note's picture once the agent is done ─────────────────────────────────────────────────────
// The note was sent with a picture of its area. When the agent has finished it, the same area is
// pictured again: the page is put where it was scrolled then, the layer is hidden for the two
// frames it takes, and the page goes back to where the reviewer has it. Only on the page the
// note was made on, at the width it was made at, and never while a note is being written.

/** After a note is done: the dev server's rebuild and the reload that follows (page.ts waits 400 ms). */
const AFTER_WAIT = 1200
/** After the page has loaded: fonts, pictures, an entrance animation. */
const AFTER_SETTLE = 700
const AFTER_TRIES = 40
/** One at a time: each scrolls the page. */
let afterPictures: Promise<void> = Promise.resolve()

const samePage = (a: string, b: string) => {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname === y.pathname
  } catch {
    return false
  }
}

async function afterPicture(s: Site, id: string) {
  const p = page
  const shot = s.review.note(id)?.shot
  if (!p || !shot) return
  // A note taken back meanwhile has nothing to show: the area is as it was before it.
  const here = () => page === p && site === s && s.review.note(id)?.status === "done" && !s.review.note(id)?.takenBack && samePage(p.state().url, shot.url)
  try {
    await sleep(AFTER_WAIT)
    for (let i = 0; i < AFTER_TRIES && here() && (p.state().loading || (await p.overlay("window.__b42 ? window.__b42.busy() : false"))); i++) await sleep(500)
    if (!here() || p.state().loading) return
    await sleep(AFTER_SETTLE)
    const v = shot.viewport
    if (!here() || (await p.evaluate("innerWidth")) !== v.w) return
    const was = await p.evaluate(
      `(() => { const s = document.createElement("style"); s.id = "b42-after"; s.textContent = "b42-review{visibility:hidden!important}"; document.documentElement.append(s);` +
        ` const was = [scrollX, scrollY]; scrollTo({ left: ${Number(v.scrollX)}, top: ${Number(v.scrollY)}, behavior: "instant" });` +
        ` return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(was)))) })()`,
    )
    try {
      const n = s.review.note(id)?.n ?? 0
      const file = noteImages(await p.capture(), { bounds: shot.bounds, viewport: v } as PageNote, n)[0]
      if (file && noteShots.save(id, "after", file.uri) && s.review.mark(id, { pictures: "both" })) changed(s)
    } finally {
      const back = Array.isArray(was) ? `scrollTo({ left: ${Number(was[0])}, top: ${Number(was[1])}, behavior: "instant" });` : ""
      await p.evaluate(`(() => { document.getElementById("b42-after")?.remove(); ${back} })()`)
    }
  } catch (err) {
    log("warn", "no picture of the note's area after the agent was done", say(err))
  }
}

// ── the repo: its branch, and what is not committed ─────────────────────────────────────────────

let repo: { branch?: string; changes: RepoChange[] } | undefined
const REPO_CHANGES_MAX = 200

async function refreshRepo() {
  const b = backend
  const s = site
  const directory = s && siteSettings(s.origin)?.directory
  if (!b || !s || !directory) return void ((repo = undefined), push())
  try {
    const found = await b.vcs(directory)
    if (backend !== b || site !== s) return
    repo = found && { ...found, changes: found.changes.slice(0, REPO_CHANGES_MAX) }
  } catch (err) {
    // A server without these routes, or a folder it cannot read: no line about the repo.
    if (backend !== b || site !== s) return
    repo = undefined
    log("warn", "can't read the repo's state", say(err))
  }
  push()
}

/** What the agent is asked for a commit. The message is the reviewer's, word for word. */
function commitPrompt(message: string) {
  return [
    "Commit the work in this folder with git.",
    "",
    "- Stage every change in the working tree, new files included (git add -A).",
    "- Use exactly this commit message, as it is written between the lines:",
    "----",
    message,
    "----",
    "- Do not push, and do not change any file.",
    "",
    "Reply with the commit's short hash and its subject, or with what stopped you.",
  ].join("\n")
}

const DIFF_IN_PROMPT_MAX = 20_000

/** What the agent is asked when a note that is not the newest message is taken back. */
function takeBackPrompt(n: number, text: string, diff: FileChange[]) {
  const patch = diff.map((f) => f.patch).join("\n")
  return [
    `Take back what you changed for UI review note ${n}: ${JSON.stringify(text)}.`,
    "",
    "- Put the code back to how it was before that note, and only that: leave every other change, earlier or later, as it is.",
    "- If something done since depends on it, say so instead of breaking it.",
    ...(patch
      ? [
          "",
          "For reference, the diff of the turn that note was part of. Notes that waited together share a turn, so it may hold other notes' changes too:",
          "```diff",
          patch.length > DIFF_IN_PROMPT_MAX ? `${patch.slice(0, DIFF_IN_PROMPT_MAX)}\n… (cut)` : patch,
          "```",
        ]
      : []),
  ].join("\n")
}

// ── checkpoints ─────────────────────────────────────────────────────────────────────────────────
// A named point in a conversation. It is a line in the transcript, kept by the app; going back
// to it is the server's undo, to the first message said after it.

const CHECKPOINT_NAME_MAX = 60
const checkpointsOf = (id: string): Checkpoint[] =>
  Object.values(store.settings().sites)
    .flatMap((entry) => entry.checkpoints ?? [])
    .filter((c) => c.session === id)
const checkpointMarker = (c: Checkpoint): ChatMarker => ({ kind: "marker", id: `checkpoint:${c.id}`, time: c.time, tone: "info", text: c.name, checkpoint: c.id })

/** The transcript with the conversation's checkpoints in it, each before the first thing that
 *  happened after it. */
function withCheckpoints(id: string, items: ChatItem[]): ChatItem[] {
  const out = [...items]
  for (const c of checkpointsOf(id).sort((a, b) => a.time - b.time)) {
    const at = out.findIndex((i) => i.time > c.time)
    out.splice(at < 0 ? out.length : at, 0, checkpointMarker(c))
  }
  return out
}

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
    // The first picture is the area as it is now (for a canvas note, as it was before the
    // reviewer's edits): what the agent's result will be looked at beside.
    if (files[0] && noteShots.save(note.id, "before", files[0].uri)) s.review.mark(note.id, { pictures: "before" })
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
    void autoName(target, s.review.rows().find((r) => r.id === id)?.text ?? "")
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
/** A finished note that can be taken back, and how that would go now. The newest message of an
 *  idle conversation can be undone exactly, files and all ("undone"). An older one has later
 *  work on top of it, and a busy conversation cannot be undone: there only the agent can take
 *  it out ("asked"). */
async function takeBack(id: unknown) {
  const s = site
  const note = typeof id === "string" ? s?.review.note(id) : undefined
  if (!s || !note?.session || !note.message || note.status !== "done") throw new Error("Only a finished note can be taken back.")
  if (note.takenBack) throw new Error("This note was already taken back.")
  const b = need()
  const info = await b.session(note.session)
  if (!info) throw new Error("Its conversation no longer exists.")
  const last = info.busy ? null : await b.lastTurn(note.session)
  const how: "undone" | "asked" = last?.id === note.message ? "undone" : "asked"
  return { s, note: note as typeof note & { session: string; message: string }, how }
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
  { name: "checkpoint", description: "Mark this point to come back to: /checkpoint name", builtin: true },
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
    showFiles(site)
    // The note it was says so in the list, until /redo.
    for (const s of sites.values()) {
      const row = s.review.rows().find((r) => s.review.note(r.id)?.message === turn.id && s.review.note(r.id)?.session === current.id && r.status === "done")
      if (row && s.review.mark(row.id, { takenBack: "undone", accepted: undefined })) changed(s)
    }
    // A note cannot be sent again from the message box; a typed message can, so it comes back.
    return { say: `Took back ${what}. /redo brings it back; your next message makes it final.`, ...(turn.note ? {} : { draft: turn.text }) }
  },
  async redo(b, current) {
    const now = await b.session(current.id)
    if (!now?.undone) throw new Error("Nothing to redo.")
    await b.redo(current.id)
    showFiles(site)
    for (const s of sites.values()) {
      let touched = false
      for (const r of s.review.rows()) if (r.takenBack === "undone" && s.review.note(r.id)?.session === current.id) touched = s.review.mark(r.id, { takenBack: undefined }) || touched
      if (touched) changed(s)
    }
    return { say: "Brought back what was undone." }
  },
  async rename(b, current, args) {
    if (!args) throw new Error("Type the new name after /rename.")
    await b.rename(current.id, args)
    if (session?.id === current.id) (session = { ...session, title: args }), push()
    void refreshSessions()
    return { say: `Renamed to ${quoted(args)}.` }
  },
  async checkpoint(_b, _current, args) {
    commands.addCheckpoint(args)
    return { say: "Marked. The line in the conversation takes you back here." }
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
    const before = site.review.rows().map((r) => r.id)
    site.review.clearDone()
    const left = new Set(site.review.rows().map((r) => r.id))
    for (const id of before) if (!left.has(id)) noteShots.drop(id)
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
    noteShots.drop(id)
    changed(site)
  },
  notePictures(id) {
    return typeof id === "string" && site?.review.note(id)?.pictures ? noteShots.read(id) : {}
  },
  async noteDiff(id) {
    const note = typeof id === "string" ? site?.review.note(id) : undefined
    if (!note?.session || !note.message) throw new Error("This note has not reached the agent.")
    return need().diff(note.session, note.message)
  },
  acceptNote(id, accepted) {
    const s = site
    if (typeof id !== "string" || !s || s.review.note(id)?.status !== "done") return
    if (s.review.mark(id, { accepted: accepted ? true : undefined })) changed(s)
  },
  async takeBackWay(id) {
    return (await takeBack(id)).how
  },
  async takeBackNote(id, expect) {
    const { s, note, how } = await takeBack(id)
    // The question named one way; the conversation has moved since, and this is not that way.
    if ((expect === "undone" || expect === "asked") && expect !== how) throw new Error("Its conversation changed meanwhile. Press Take back again to see what it would do now.")
    const b = need()
    if (how === "undone") {
      await b.undo(note.session, note.message)
      showFiles(s)
    } else {
      const diff = await b.diff(note.session, note.message).catch(() => [] as FileChange[])
      await b.prompt(note.session, { text: takeBackPrompt(note.n, note.text, diff) })
      reversing.add(note.session)
    }
    s.review.mark(note.id, { takenBack: how, accepted: undefined })
    changed(s)
    return how
  },
  addCheckpoint(name) {
    const s = site
    const current = needSession()
    if (!s || !siteSettings(s.origin)) return
    const clean = (typeof name === "string" ? name : "").replace(/\s+/g, " ").trim().slice(0, CHECKPOINT_NAME_MAX)
    const made: Checkpoint = { id: `cp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, session: current.id, name: clean || `Checkpoint ${checkpointsOf(current.id).length + 1}`, time: Date.now() }
    store.update((x) => void (x.sites[s.origin] && (x.sites[s.origin]!.checkpoints = [...(x.sites[s.origin]!.checkpoints ?? []), made])))
    if (chat?.session === current.id) toChat({ type: "item", session: current.id, item: checkpointMarker(made) })
  },
  removeCheckpoint(id) {
    if (typeof id !== "string") return
    let from: string | undefined
    store.update((x) => {
      for (const entry of Object.values(x.sites)) {
        const found = entry.checkpoints?.find((c) => c.id === id)
        if (!found) continue
        from = found.session
        entry.checkpoints = entry.checkpoints!.filter((c) => c.id !== id)
        if (!entry.checkpoints.length) delete entry.checkpoints
      }
    })
    if (from && chat?.session === from) toChat({ type: "remove", session: from, item: `checkpoint:${id}` })
  },
  async returnToCheckpoint(id) {
    const cp = Object.values(store.settings().sites)
      .flatMap((entry) => entry.checkpoints ?? [])
      .find((c) => c.id === id)
    if (!cp) throw new Error("That checkpoint is gone.")
    const b = need()
    const info = await b.session(cp.session)
    if (!info) throw new Error("Its conversation no longer exists.")
    if (info.busy) throw new Error("The agent is working. Stop it first.")
    // Everything said after it goes: the first such message is where the server cuts.
    const after = (await b.transcript(cp.session)).items.filter((i) => i.kind === "user" && !i.pending && i.time > cp.time)
    if (!after.length) throw new Error("Nothing has been said since this checkpoint.")
    await b.undo(cp.session, after[0]!.id)
    showFiles(site)
    const gone = new Set(after.map((i) => i.id))
    for (const s of sites.values()) {
      let touched = false
      for (const row of s.review.rows()) {
        const note = s.review.note(row.id)
        if (note?.session === cp.session && note.message && gone.has(note.message) && note.status === "done") touched = s.review.mark(row.id, { takenBack: "undone", accepted: undefined }) || touched
      }
      if (touched) changed(s)
    }
    return after.length
  },
  async refreshRepo() {
    await refreshRepo()
  },
  async commitChanges(message) {
    const clean = typeof message === "string" ? message.trim() : ""
    if (!clean) throw new Error("Write what the commit is.")
    await need().prompt(needSession().id, { text: commitPrompt(clean) })
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
  servers() {
    const s = store.settings()
    const here = readLocal()?.url ?? ""
    return (s.servers ?? [])
      .map((x): ServerInfo => ({ id: x.id, ...((x.name ?? x.computer) ? { name: x.name ?? x.computer } : {}), url: "local" in x ? here : x.url, local: "local" in x, current: !!s.server && x.id === s.current }))
      .sort((a, b) => Number(b.current) - Number(a.current))
  },
  async useServer(id) {
    const saved = store.settings().servers?.find((x) => x.id === id)
    if (!saved) throw new Error("That server is no longer saved.")
    if ("local" in saved) return void (await commands.connectLocal())
    const password = unseal(saved.password)
    if (password === undefined) throw new Error("Its saved password can't be read. Enter the address and password again.")
    await connect(saved.url, password, { save: "remote" })
  },
  forgetServer(id) {
    const s = store.settings()
    if (s.server && s.current === id) throw new Error("Disconnect from it first.")
    store.update((x) => {
      x.servers = (x.servers ?? []).filter((v) => v.id !== id)
      // Not connected, and it was the one last in use: what is here was its own.
      if (x.current === id) delete x.current, delete x.folder, delete x.lastUrl, delete x.defaultModel, (x.sites = {})
    })
    push()
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
  async projects() {
    const b = need()
    // The server lists every folder a conversation was ever started for, also one that is not
    // there (deleted since, or another computer's, named by mistake): those are left out.
    const known = (await b.projects()).slice(0, 40)
    const there = await Promise.all(known.map((d) => folderExists(b, d)))
    const list = known.filter((_, i) => there[i])
    // Kept with the server, so its projects can be offered while another one is in use.
    store.update((s) => {
      const mine = s.servers?.find((x) => x.id === s.current)
      if (mine) mine.projects = list
    })
    return list
  },
  async allProjects() {
    const s = store.settings()
    const mine = s.servers?.find((x) => x.id === s.current)
    const here = site && siteSettings(site.origin)?.directory
    const live = backend ? await Promise.resolve(commands.projects()).catch(() => [] as string[]) : []
    const on = mine ? serverCalled(mine) : ""
    const out: ProjectInfo[] = [...new Set([...(here ? [here] : []), ...live])].map((directory) => ({ directory, on, ...(directory === here ? { open: true as const } : {}) }))
    for (const x of s.servers ?? []) {
      if (x.id === s.current && backend) continue
      const theirs = x.id === s.current ? { folder: s.folder, sites: s.sites } : x.space
      const known = [...new Set([...(theirs?.folder ? [theirs.folder] : []), ...Object.values(theirs?.sites ?? {}).map((e) => e.directory), ...(x.projects ?? [])])]
      for (const directory of known) out.push({ directory, server: x.id, on: serverCalled(x) })
    }
    return out
  },
  listFolders: (dir) => need().listFolders(dir),
  async setDirectory(directory) {
    if (typeof directory !== "string" || !directory.startsWith("/")) throw new Error("Choose a folder.")
    missingFolder = undefined
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
  async openProject(directory, server) {
    if (typeof directory !== "string" || !directory.startsWith("/")) throw new Error("Choose a folder.")
    // A project of another server: that server first. Its own repo and page come up with it,
    // and then this project is opened there.
    if (typeof server === "string" && (server !== store.settings().current || !backend)) await commands.useServer(server)
    const b = need()
    if (!(await folderExists(b, directory))) throw new Error(`${directory} is not a folder on this server.`)
    missingFolder = undefined
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
  async refreshRunning() {
    need()
    await refreshRunning(true)
  },
  async stopRunning(directory, id) {
    const b = need()
    const which = runningShown().filter((r) => (directory === undefined || r.directory === directory) && (id === undefined || r.id === id))
    const failed: string[] = []
    await Promise.all(which.map((r) => b.kill(r.directory, r.id).catch((err) => void failed.push(say(err)))))
    await refreshRunning(true)
    if (failed.length) throw new Error(`Could not stop ${failed.length === 1 ? "it" : `${failed.length} of them`}: ${failed[0]}`)
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
    void autoName(current.id, text)
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
  async cancelNote(id) {
    const note = typeof id === "string" ? site?.review.note(id) : undefined
    if (!note?.session || !note.message || note.status !== "queued") throw new Error("This note is no longer waiting.")
    // The server's "cancelled" event is what moves the note; it arrives for any conversation.
    await need().cancelQueued(note.session, note.message)
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
  async refreshSessions() {
    await refreshSessions()
  },
  async archivedSessions() {
    const directory = site && siteSettings(site.origin)?.directory
    return directory ? await need().sessions(directory, true) : []
  },
  async renameSession(id, title) {
    if (typeof id !== "string" || !id || typeof title !== "string") return
    const clean = title.replace(/\s+/g, " ").trim().slice(0, SESSION_TITLE_MAX)
    if (!clean) throw new Error("Type a name for the conversation.")
    await need().rename(id, clean)
    retitle(id, clean)
  },
  pinSession(id, pinned) {
    const s = site
    if (typeof id !== "string" || !id || !s) return
    unpin(id)
    if (pinned) store.update((x) => void (x.sites[s.origin] && (x.sites[s.origin]!.pinned = [...(x.sites[s.origin]!.pinned ?? []), id])))
    push()
  },
  async archiveSession(id, archived) {
    if (typeof id !== "string" || !id) return
    await need().archive(id, !!archived)
    if (!archived) return void (await refreshSessions())
    unpin(id)
    const open = session?.id === id
    if (open) await leave(id)
    sessions = sessions.filter((x) => x.id !== id)
    push()
  },
  async deleteSession(id) {
    if (typeof id !== "string" || !id) return
    await need().remove(id)
    unpin(id)
    // The server says so too (sessionGone); by then the site has moved on, so that it goes to
    // the conversation before this one and not to a new one.
    const owner = sites.get(owners.get(id) ?? "")
    if (owner?.review.gone(id)) changed(owner)
    const open = session?.id === id
    if (open) await leave(id)
    sessions = sessions.filter((x) => x.id !== id)
    push()
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
      for (const x of [s.server, s.servers?.find((v) => v.id === s.current)]) {
        if (!x) continue
        if (clean) x.name = clean
        else delete x.name
      }
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

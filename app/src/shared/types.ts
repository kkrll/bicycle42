// Everything that crosses a boundary in the app lives here, and nothing else does.
//
//   app window (renderer) ⇄ main      AppState snapshots, ChatEvents, Commands      (via preload.ts)
//   main ⇄ agent backend              the Backend interface and its BackendEvents   (main/acp.ts)
//
// The UI speaks of sites, notes and changes. Backend words (session, inbox, provider) stop at
// main: the renderer never sees a raw agent payload.
import type { Dock, PanelAct, PanelPart, PanelView, Pane } from "../../../overlay/protocol"

// ── the page's docks, drawn by the window ───────────────────────────────────────────────────────
// Edit mode's inspector and motion mode's dock belong to the overlay, which draws them at the
// bottom of the page; a dock the window draws itself is "hosted" (Dock in overlay/protocol.ts).
// The overlay then says what the dock shows (PanelMessage, on the "panel" stream) and does what
// the window's dock asks (the `panel` command). Main only carries both: it reads neither.
// "facts" (This page on this phone, beside a phone's page in Preview and Annotate) is a pane of
// the window's that is no mode's dock, and rides the same way (Pane in overlay/protocol.ts).
export type { Dock, PanelAct, Pane }
/** overlay → window: a hosted pane's view, the fields of it that changed, or the answer to its "ping". */
export type PanelMessage = PanelView | PanelPart | { panel: Pane; pong: number }

/** The panes the window draws. A dock the overlay still draws itself is not in the list. */
export const HOSTED_PANES: readonly Pane[] = ["canvas", "motion", "facts"]

/** What the page is shown as. "phone": as wide as the chosen phone's screen and at most as tall
 *  (CSS px), laid out as a phone's browser lays it out (the page's viewport tag counts,
 *  scrollbars take no room); the pointer is still a mouse, so every mode works as on a desktop
 *  page. */
export type Device = "desktop" | "phone"

/** A phone the page can be shown as: its screen in CSS px, upright, and how round the screen's
 *  corners are (the radius, in the same px: an iPhone's is large, an iPhone SE's screen is square). */
export type Phone = { id: string; name: string; width: number; height: number; radius: number }
/** The phones on offer, small to large: this year's, and the two small sizes still in many
 *  pockets. Sizes are what the phone's browser reports as its screen: the iPhones' from Apple's
 *  own pixel counts over 3 (402 by 874 is also an iPhone 17's and a 17 Pro's); the Android ones
 *  are the usual figures for those screens, since Android publishes no one width per model.
 *  The iPhones' corners are the screens' own, the others' are near enough. */
export const PHONES: readonly Phone[] = [
  { id: "galaxy-s26", name: "Galaxy S26", width: 360, height: 780, radius: 24 },
  { id: "iphone-se", name: "iPhone SE", width: 375, height: 667, radius: 0 },
  { id: "iphone-16e", name: "iPhone 16e", width: 390, height: 844, radius: 47 },
  { id: "iphone-18-pro", name: "iPhone 18 Pro", width: 402, height: 874, radius: 62 },
  { id: "pixel-11", name: "Pixel 11", width: 412, height: 923, radius: 30 },
  { id: "iphone-air", name: "iPhone Air", width: 420, height: 912, radius: 62 },
  { id: "iphone-18-pro-max", name: "iPhone 18 Pro Max", width: 440, height: 956, radius: 62 },
]
/** The phone a page is shown as until another is chosen. */
export const PHONE: Phone = PHONES[2]!
/** The phone of that id, or the usual one for an id that is not on the list. */
export const phoneOf = (id: unknown): Phone => PHONES.find((p) => p.id === id) ?? PHONE

// ── models ──────────────────────────────────────────────────────────────────────────────────────

export type ModelRef = { providerID: string; id: string; variant?: string }

export type ModelInfo = {
  providerID: string
  id: string
  name: string
  /** Takes screenshots. Review notes need this. */
  images: boolean
  /** Effort levels, e.g. low | medium | high. Empty when the model has none. */
  variants: string[]
  /** How many tokens the model can be given at once: the window its context is measured
   *  against. Absent when the agent does not say. */
  context?: number
}

/** How full a conversation's context was at the agent's last finished step, in tokens, and
 *  which provider counted them: another provider's model counts differently. `limit` is the
 *  window it is measured against, when the agent says it with the count (an ACP agent does);
 *  without it the model's own `context` is. */
export type ContextUse = { used: number; providerID?: string; limit?: number }

export type AgentInfo = { id: string; name: string }

// ── chat ────────────────────────────────────────────────────────────────────────────────────────
// A conversation is a list of items, oldest first. An assistant item is one model step; a turn
// with tools is several of them in a row.

export type ChatImage = { name: string; src: string }

export type ChatUser = {
  kind: "user"
  id: string
  time: number
  text: string
  images: ChatImage[]
  /** Set when this message is a review note: the note's number and the reviewer's own words. */
  note?: { n: number; text: string }
  /** Set when the app wrote this message in the reviewer's name (get the site running, commit,
   *  take a note back; main/asks.ts): what it asks, in a line. The chat shows the line, and
   *  `text` folded under it. */
  ask?: { title: string }
  /** Sent but not yet picked up by the agent (it is busy with earlier work). */
  pending?: boolean
}

export type ToolStatus = "pending" | "running" | "done" | "error"

export type FileChange = { file: string; patch: string; additions: number; deletions: number }

export type ChatPart =
  | { kind: "text"; key: string; text: string }
  | { kind: "reasoning"; key: string; text: string }
  | {
      kind: "tool"
      key: string
      name: string
      status: ToolStatus
      /** One line saying what it does: "edit src/Button.tsx", "run npm test". */
      title: string
      /** Command output or result text, trimmed to a few KB. */
      detail?: string
      changes?: FileChange[]
      error?: string
    }

export type ChatAssistant = {
  kind: "assistant"
  id: string
  time: number
  parts: ChatPart[]
  /** False while the step is still running. */
  done: boolean
  /** When the step ended (ms), once it has and the agent said when. */
  ended?: number
  error?: string
}

/** A line between messages: "Stopped", "Failed: …", "Model changed to Sonnet". */
export type ChatMarker = {
  kind: "marker"
  id: string
  time: number
  text: string
  tone: "info" | "error"
  /** This line is a checkpoint: its id, for going back to it or removing it. */
  checkpoint?: string
  /** The agent's run failed by itself. (Stopped by the reviewer is also "error" in tone.) */
  failed?: true
}

export type ChatItem = ChatUser | ChatAssistant | ChatMarker

/** Incremental updates to the open conversation. `session` lets a late event for a conversation
 *  that is no longer shown be dropped. */
export type ChatEvent =
  | { type: "reset"; session: string; items: ChatItem[] }
  /** Append the item, or replace the one with the same id. */
  | { type: "item"; session: string; item: ChatItem }
  /** Append the part to the assistant item, or replace the one with the same key. */
  | { type: "part"; session: string; item: string; part: ChatPart }
  /** Append text to a text or reasoning part. */
  | { type: "delta"; session: string; item: string; key: string; text: string }
  | { type: "remove"; session: string; item: string }
  /** The agent picked up a waiting user message: it is no longer pending and moves to the end of
   *  the conversation. (Not a remove + item pair: its screenshots are already in the window.) */
  | { type: "delivered"; session: string; item: string; time: number }

// ── the message box: commands and mentions ──────────────────────────────────────────────────────

/** A command, run by typing `/name arguments`: one of the app's own (`builtin`: /compact, /new,
 *  /undo, …) or one the agent offers. A built-in wins over an agent's command of the same name. */
export type SlashCommand = { name: string; description?: string; builtin?: true }

/** What a command has to say once it has run: a line for under the message box, and text to
 *  put into the box (the message /undo took back, or the confirmation to send next). */
export type CommandResult = { say?: string; draft?: string }

/** Something that can be named with `@` in a message: a file or folder of the site's code, a
 *  skill, or a helper agent. `id` is the path (relative to the site's folder), the skill's id
 *  or the agent's name. */
export type MentionOption = { kind: "file" | "folder" | "skill" | "agent"; id: string; label: string; detail?: string }

/** A mention as it sits in a message: characters `start`..`end` of the text are `@label`. */
export type Mention = { kind: MentionOption["kind"]; id: string; start: number; end: number }

/** How a message is delivered while the agent is working: wait for its turn, or interrupt and
 *  steer what it is doing now. */
export type Delivery = "queue" | "steer"

export type SendOptions = { mentions?: Mention[]; delivery?: Delivery }

// ── things that need an answer ──────────────────────────────────────────────────────────────────

export type PermissionAsk = {
  id: string
  session: string
  /** "edit", "shell", "webfetch", … */
  action: string
  /** Paths, commands or URLs it wants to act on. */
  resources: string[]
  /** For edits: the proposed change, before it is applied. */
  changes?: FileChange[]
  message?: string
}

export type PermissionDecision = "once" | "always" | "reject"

export type QuestionField = {
  key: string
  type: "string" | "multiselect" | "boolean" | "number"
  title?: string
  description?: string
  placeholder?: string
  options?: { value: string; label: string; description?: string }[]
  /** Free text is allowed next to the options. */
  custom?: boolean
  required?: boolean
}

export type Question = { id: string; session: string; title: string; fields: QuestionField[] }

export type Answer = Record<string, string | number | boolean | string[]>

// ── review notes ────────────────────────────────────────────────────────────────────────────────

export type NoteStatus = "capturing" | "sending" | "queued" | "working" | "done" | "failed"

/** "bg" notes go to a second conversation that runs beside the main one (alt+Enter). */
export type Lane = "main" | "bg"

export type NoteRow = {
  id: string
  n: number
  /** The reviewer's words, or for a canvas note without words a summary of its edits. */
  text: string
  status: NoteStatus
  lane: Lane
  /** A canvas note: what the reviewer changed on the live page, one sentence per edit (and one
   *  for the new CSS rules that came with them, if any). */
  edits?: string[]
  /** A motion note: `edits` are then its animation in sentences. */
  motion?: true
  error?: string
  /** It did not fail: the reviewer stopped the agent or took the note out of the queue. Shown
   *  quietly, with Retry, and not counted as a failure. (`status` is still "failed".) */
  stopped?: true
  /** Its pin can't find its element on the page right now. */
  lost?: true
  /** A conversation took it: what the agent changed for it can be asked for (`noteDiff`). */
  sent?: true
  /** The conversation that took it. It need not be the open one: a note stays with the
   *  conversation it was sent in, and a background note has one of its own. */
  session?: string
  /** Which pictures of its area there are (`notePictures`): the one from when it was made, or
   *  that and the one taken when the agent was done. */
  pictures?: "before" | "both"
  /** What the agent did for it was taken back: "restored" by the app from its own file history
   *  (files only: the conversation keeps it, and the agent is told with the next message), which
   *  /redo can bring back until the next message; or the agent was "asked" to reverse it. */
  takenBack?: TakeBackWay
}

/** A file the working tree has changed since the last commit. */
export type RepoChange = { file: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }

/** How a note is taken back (`takeBackWay`): "restored" by the app from its own snapshots of the
 *  files (its changes reversed exactly, later ones kept), or the agent is "asked" to reverse it. */
export type TakeBackWay = "restored" | "asked"

/** A named point in a conversation to go back to. */
export type Checkpoint = { id: string; session: string; name: string; time: number }

// ── app state ───────────────────────────────────────────────────────────────────────────────────
// Main owns it and pushes the whole snapshot on every change. It stays small: the conversation
// travels separately as ChatEvents.

/** How long an agent on another computer goes on working there with no app attached (this one
 *  asleep, the network gone, the app quit without ending it): then its helper ends it. */
export const AWAY_HOURS = 12

export type ConnectionState =
  /** No agent set up yet: show the connect form. */
  | { status: "unconfigured" }
  | { status: "connecting"; url: string }
  | { status: "online"; url: string; version: string }
  /** `away`: the agent's computer can't be reached (an agent on another computer over ssh), and
   *  the agent works on there: nothing it was doing is lost, the app connects again by itself, and
   *  notes wait meanwhile. */
  | { status: "offline"; url: string; error: string; away?: true }

/** Which agent does the work, for the mark the window draws for it: one of the ACP agents the
 *  app knows (`localAgents`), or any other ACP command ("custom"). */
export type AgentKind = "claude" | "codex" | "gemini" | "opencode" | "custom"

/** An agent as the window names it. `name`: the reviewer's name for it, else the agent's own
 *  ("Claude Code", a custom command's program). `here`: it runs on this computer, so its folders
 *  are this computer's; else `host` is the computer it runs on over ssh, as the reviewer typed it. */
export type Harness = { kind: AgentKind; name: string; here: boolean; host?: string }

/** A folder an agent has worked in. `server` is absent for the agent in use, else the saved
 *  agent's id; `on` is what to call that agent ("Claude Code", "Studio Mac"), `kind` which agent
 *  that is, `here` that it is on this computer; `open` marks the project that is open. */
export type ProjectInfo = { directory: string; server?: string; on: string; kind?: AgentKind; here?: true; open?: true }

/** An agent the app has started before (`connectAgent`), remembered. `name` is the reviewer's for
 *  it, else its own. `agent`: which one (an id in `localAgents`, or "custom-…"), `command` the line
 *  that starts it; `host` the other computer it runs on over ssh, `here` when it is this one. */
export type ServerInfo = { id: string; name?: string; current: boolean; agent: string; command: string; kind: AgentKind; here: boolean; host?: string }

/** Another computer connected to over ssh (`connectSsh`): the host as typed, what it calls itself,
 *  its home folder, and the agents installed there, as `localAgents` says this computer's. */
export type RemoteInfo = { host: string; computer: string; home: string; agents: LocalAgent[] }

/** An agent this computer can run for the app over ACP (the Agent Client Protocol), as the
 *  connect screen offers it. `installed`: what it needs was found on this computer's PATH;
 *  `needs` says what to install when it was not, `install` is the one command that does.
 *  `signIn`: it is installed and no sign-in of it was found on this computer: the command to run
 *  in a terminal (it may still work: an API key in its own settings is not looked for). */
export type LocalAgent = { id: string; name: string; command: string; installed: boolean; needs?: string; install?: string; signIn?: string }

export type SessionSummary = {
  id: string
  /** The folder it works in. */
  directory: string
  /** Set on a child conversation (the background one); those stay out of the switcher. */
  parent?: string
  title: string
  updated: number
  busy: boolean
  model?: ModelRef
  agent?: string
  /** Put away: out of the list, kept by the agent, and can be brought back. */
  archived?: true
  /** Kept at the top of the list. The app's own: the agent does not know. */
  pinned?: true
  /** How many of this site's notes went to it, and their words (lower case), for the list's
   *  search. The app's own, of the notes still on the list. */
  notes?: number
  said?: string
}

/** The top bar's switch. "preview": the page as it is, review off. "notes": point at something
 *  and say what to change. "edit": change the page itself (the overlay's canvas mode). "motion":
 *  look at what moves on the page and change one animation at a time. */
export type ReviewMode = "preview" | "notes" | "edit" | "motion"

export type AppState = {
  connection: ConnectionState
  /** The reviewer's name for the agent in use, else its own. */
  serverName?: string
  /** OpenCode servers saved by an earlier version were put aside at start (the app no longer
   *  connects to one): the connect screen says so once, then `leaveSsh` forgets it. */
  serversRetired?: true
  /** The agent in use (or being connected to again, while offline or connecting): its mark,
   *  name and where it runs. Absent while none is set up. */
  harness?: Harness
  /** This computer's home folder: a path in it, on this computer, is shown as ~/…. */
  home?: string
  page: {
    /** What the URL bar shows. Empty before the first page. */
    url: string
    loading: boolean
    error?: string
    /** The page's renderer is gone (`error` says so): no overlay is there, so nothing it said of
     *  its panes holds. The window drops those views; loaded again, the overlay sends new ones. */
    crashed?: true
    canGoBack: boolean
    canGoForward: boolean
    /** The page hot-reloads by itself, so the app leaves reloading to it. */
    hmr: boolean
    /** Kept between starts; the window sizes the page's box by it. */
    device: Device
    /** Which phone a phone's page is (an id in PHONES); kept while the page is a desktop's. */
    phone: string
  }
  review: {
    /** Notes, edit or motion mode is on. Off is "preview". */
    enabled: boolean
    mode: ReviewMode
    /** The brush is on: a plain drag on the page draws. It belongs to notes mode. */
    brush: boolean
    autoReload: boolean
    notes: NoteRow[]
    /** Pins whose element can no longer be found on the page. */
    unplaced: number
    /** The panes the overlay was told the window draws (HOSTED_PANES, unless the shell says otherwise). */
    docks: Pane[]
  }
  /** The site under review and the folder (the repo) that holds its code. `null` until
   *  there is a repo or a page. The repo comes first: with one open and no page yet, `origin` is
   *  "" and the conversation is the repo's own, which the first site opened takes over.
   *  `directory` is absent only for a page opened while no repo is known. */
  site: { origin: string; directory?: string } | null
  /** The repo that was open is not a folder where the agent in use works (it was moved, or it is
   *  another computer's): another one has to be chosen. */
  missingFolder?: string
  /** The open repo under version control: its branch, and what is changed and not committed.
   *  Absent when the folder is not a repository. */
  repo?: { branch?: string; changes: RepoChange[] }
  /** The agent was asked to get the site running (`startSite`) and has not finished answering. */
  startingSite?: true
  /** The open conversation. `null` until there is a folder. */
  session: SessionSummary | null
  /** Other conversations in the same folder, newest first, for the switcher. */
  sessions: SessionSummary[]
  models: ModelInfo[]
  agents: AgentInfo[]
  /** The model new conversations start with. */
  defaultModel?: ModelRef
  /** Set while the person has to choose that model: the agent offers several and none is saved
   *  (first launch), or the saved one is no longer on its list (`previous`). The window
   *  shows the chooser with `suggested` preselected; `setDefaultModel` answers it. No new
   *  conversation is made meanwhile. */
  modelChoice?: { suggested: ModelRef; previous?: ModelRef }
  permissions: PermissionAsk[]
  questions: Question[]
  /** What the agent in use can do beyond the basics (`BackendCan`). The window leaves out what it
   *  cannot: Steer, Compact, Fork, Archive. Absent while nothing is connected. */
  can?: BackendCan
  /** How full the open conversation's context is: the tokens the agent last counted, and the
   *  window it counts against (absent when it gives none). Absent until a step has
   *  finished, right after a summary (nothing has measured what is left yet), and after a
   *  change to another provider's model. */
  context?: { used: number; limit?: number }
}

export type Rect = { x: number; y: number; width: number; height: number }

export type DirEntry = { name: string; path: string }

/** Renderer → main. Each returns a promise; a rejection carries a message fit to show the user. */
export type Commands = {
  // page
  navigate(url: string): void
  reload(): void
  back(): void
  forward(): void
  /** Where the page sits inside the window, in CSS pixels. `null` hides it (a dialog is open). */
  setPageBounds(bounds: Rect | null): void
  /** The page as a desktop's or as a phone's: how it is laid out, and how wide its box is. */
  setDevice(device: Device): void
  /** Which phone a phone's page is: an id in PHONES. */
  setPhone(id: string): void
  // review
  toggleReview(): void
  /** The top bar's switch. Notes and edit turn review on; the page takes the keyboard. */
  setMode(mode: ReviewMode): void
  /** The brush on or off. On, it turns review on and goes to notes mode. */
  toggleBrush(): void
  toggleAutoReload(): void
  /** From a hosted dock, to the overlay: what the reviewer did there. Nothing is answered here;
   *  what changed comes back as the dock's next view. */
  panel(act: PanelAct): void
  /** Takes the notes that are done off the list. A failed or stopped one stays, with its Retry. */
  clearNotes(): void
  retryNote(id: string): void
  /** Takes a note off the list, whatever its state. The agent is not told. */
  removeNote(id: string): void
  /** Scrolls the page to the note's pin. */
  showNote(id: string): void
  /** The note's area as it was when the note was made and, once the agent was done, as it is
   *  then: JPEG data URIs of the ones there are. */
  notePictures(id: string): { before?: string; after?: string }
  /** What the agent changed in the code for the note: the files of the turn the note was part
   *  of. Notes that waited together for the agent share a turn, and so a diff. null when it is not
   *  known (no record of the turn was kept), which is not "no file changed" ([]). */
  noteDiff(id: string): FileChange[] | null
  /** The result is right (or, with false, not looked at after all). */
  /** Takes back what the agent did for a finished note: the app reverses the files from its own
   *  snapshots when that applies cleanly ("restored", which /redo brings back until the next
   *  message); else the agent is asked to reverse its change ("asked"). */
  takeBackNote(id: string, expect?: TakeBackWay): TakeBackWay
  /** Which way `takeBackNote` would go now, so the question before it can say. With `expect`,
   *  `takeBackNote` does nothing and throws when it would by now go another. */
  takeBackWay(id: string): TakeBackWay
  /** `takeBackWay` and, when the app would put files back ("restored"), which ones: changes
   *  made to them during that turn, by anyone, go back too. */
  takeBackPlan(id: string): { how: TakeBackWay; files?: string[] }
  /** Marks this point of the open conversation, to come back to. */
  addCheckpoint(name: string): void
  removeCheckpoint(id: string): void
  /** Takes the files back to a checkpoint: the app reverses what the agent changed since from its
   *  own snapshots, and the conversation stays. /redo brings it all back until the next message.
   *  `taken`: how many turns of the agent were taken back. */
  returnToCheckpoint(id: string): { taken: number }
  /** Looks again at the repo's branch and uncommitted changes (`AppState.repo`). */
  refreshRepo(): void
  /** Asks the agent, in the open conversation, to commit everything changed with this message. */
  commitChanges(message: string): void
  // connection and site
  /** The ACP agents this computer can run (Claude Code, Codex, Gemini CLI, OpenCode), and
   *  whether each is installed. */
  localAgents(): LocalAgent[]
  /** Runs one of them (or `command`, for "custom") and uses it: its folders are this computer's,
   *  or with `host` that computer's (connected with `connectSsh`), where it runs. Remembered. */
  connectAgent(agent: { id: string; command?: string; host?: string }): void
  /** Connects to another computer over ssh (`user@host`, an alias of ~/.ssh/config) with the
   *  system's ssh and the reviewer's own keys, puts the app's helper there, and says which agents
   *  are installed there. Rejects with a sentence (a host key not known yet, no key accepted, no
   *  node there). */
  connectSsh(host: string): RemoteInfo
  /** The connect screen closed: a computer connected to only to list its agents (no agent in use
   *  is there, none is being started there) is let go, and the line about servers put aside
   *  (`serversRetired`) has been seen. */
  leaveSsh(): void
  /** Every agent started so far, the one in use first. */
  servers(): ServerInfo[]
  /** Starts one of them again. Its own repo, page and conversations come back with it. */
  useServer(id: string): void
  /** Forgets one that is not in use. Its notes stay on disk. */
  forgetServer(id: string): void
  /** Tries the saved agent again. The outcome shows in `connection`. */
  reconnect(): void
  disconnect(): void
  /** Names the agent in use; an empty name goes back to its own. */
  setServerName(name: string): void
  /** Folders the agent has worked in, most recently used first. */
  projects(): string[]
  /** Sub-folders of an absolute path on the agent's computer, for the folder picker. */
  listFolders(path: string): DirEntry[]
  /** Opens a repo: the folder the site on screen works in, and the one a site opened for the
   *  first time starts with. Works before any page is open. */
  setDirectory(directory: string): void
  /** Every project that can be opened: the folders the agent in use knows (the open one first),
   *  then those of the other agents used before, as they were last seen. */
  allProjects(): ProjectInfo[]
  /** Switches to another project: the repo in that folder. With `server`, with that saved agent:
   *  it is started first. Its site comes back as it was last
   *  open (page, notes, conversation); a project with no site yet opens with no page, at the
   *  step where a site is opened or the agent is asked to start one. */
  openProject(directory: string, server?: string): void
  /** Asks the agent, in the open conversation, to get the repo's site running and say where.
   *  Its answer shows in the chat; the address it ends with is opened when no page is. */
  startSite(): void
  // chat
  /** `images` are pictures pasted or dropped into the message box, as data URIs. */
  send(text: string, images?: PromptFile[], options?: SendOptions): void
  /** What `/` offers: the app's own commands first, then the agent's. */
  commands(): SlashCommand[]
  /** Runs `/name args` in the open conversation: a built-in here, anything else is the agent's. */
  runCommand(name: string, args: string, images?: PromptFile[], options?: SendOptions): CommandResult | void
  /** What `@query` could mean: files and folders of the site's code, skills, helper agents.
   *  At most 20, best first. An empty query lists skills and agents. */
  mentions(query: string): MentionOption[]
  /** Takes a message that is still waiting for its turn out of the queue. */
  cancelQueued(item: string): void
  /** Takes a note that is still waiting for its turn out of its conversation's queue, whichever
   *  conversation that is. The note stays on the list as stopped, with Retry. */
  cancelNote(id: string): void
  /** Stops the open conversation: the run under way, and everything waiting to go into it after
   *  that run (its notes stay on the list as stopped, with Retry). Nothing goes on by itself
   *  later, after a reconnect or a restart either. */
  stop(): void
  newSession(): void
  openSession(id: string): void
  /** Looks at the agent's list again: the list of conversations asks when it opens. */
  refreshSessions(): void
  /** The conversations put away, newest first. */
  archivedSessions(): SessionSummary[]
  /** Names a conversation. A name given here is kept: only a placeholder is ever replaced. */
  renameSession(id: string, title: string): void
  /** Keeps a conversation at the top of the list, or lets it go back among the others. */
  pinSession(id: string, pinned: boolean): void
  /** Puts a conversation away, or brings it back. The one on screen gives way to the most
   *  recent other one, or to a new one. Its notes still finish. */
  archiveSession(id: string, archived: boolean): void
  /** Deletes a conversation, for good. Unfinished notes sent to it fail. */
  deleteSession(id: string): void
  setModel(model: ModelRef): void
  /** Saves the model new conversations start with. Works before any conversation exists, and
   *  leaves the open one on the model it has. */
  setDefaultModel(model: ModelRef): void
  setAgent(id: string): void
  replyPermission(id: string, decision: PermissionDecision): void
  answerQuestion(id: string, answer: Answer): void
  dismissQuestion(id: string): void
}

export type CommandName = keyof Commands

/** App-level shortcuts caught while the page has focus, forwarded to the window. */
export type Shortcut = "focus-url" | "toggle-panel" | "focus-chat"

/** Main → window: the reviewer clicked a note's pin on the page. */
export type NoteFocus = { id: string }

/** What preload.ts exposes as `window.b42`. */
export type Bridge = {
  invoke<K extends CommandName>(name: K, ...args: Parameters<Commands[K]>): Promise<ReturnType<Commands[K]>>
  /** Calls back with the current state at once, then on every change. Returns an unsubscribe. */
  onState(fn: (state: AppState) => void): () => void
  onChat(fn: (event: ChatEvent) => void): () => void
  onShortcut(fn: (shortcut: Shortcut) => void): () => void
  onNoteFocus(fn: (focus: NoteFocus) => void): () => void
  /** What the overlay says of a hosted dock: its view whenever that changes, a ping's answer. */
  onPanel(fn: (msg: PanelMessage) => void): () => void
  platform: "darwin" | "linux" | "win32"
}

// ── backend ─────────────────────────────────────────────────────────────────────────────────────
// The seam to the agent: an ACP agent the app runs on this computer or on another one over ssh
// (main/acp.ts). Nothing outside the implementation knows the wire format.

/** What a backend can do beyond the basics. A missing field means it cannot. */
export type BackendCan = {
  /** Messages sent while a run is under way wait for it (prompt with delivery "queue"). */
  queue?: boolean
  /** delivery "steer": a message joins the run under way. */
  steer?: boolean
  /** compact(): summarise the conversation. */
  compact?: boolean
  /** fork(): copy a conversation. */
  fork?: boolean
  /** archive(): put a conversation away. */
  archive?: boolean
}

export type InboxStatus = "queued" | "working" | "cancelled"

export type BackendEvent =
  | { type: "connection"; state: ConnectionState }
  /** Events were missed. Without `session`: the stream reconnected, re-read whatever is on
   *  screen. With it: only that conversation has a gap. `gap`: what was missed is new messages
   *  only (a step whose start was not seen); without it the history itself may have changed. */
  | { type: "resync"; session?: string; gap?: true }
  /** A sent message moved through the queue. `id` is the id `prompt` returned. */
  | { type: "inbox"; session: string; id: string; status: InboxStatus }
  /** The agent started, or stopped for the given reason. `succeeded` means its queue ran dry. */
  | { type: "run"; session: string; status: "started" | "succeeded" | "failed" | "interrupted"; error?: string }
  | { type: "session"; session: SessionSummary }
  /** The conversation is gone (deleted). Nothing sent to it will finish. */
  | { type: "session-gone"; session: string }
  | { type: "chat"; event: ChatEvent }
  /** A step ended and its tokens were counted, or (without `context`) the conversation was
   *  summarised and what it holds now is not known until the next step. */
  | { type: "context"; session: string; context?: ContextUse }
  | { type: "permission"; ask: PermissionAsk }
  | { type: "permission-done"; session: string; id: string }
  | { type: "question"; question: Question }
  | { type: "question-done"; session: string; id: string }
  /** What the agent offers changed: its models, modes, commands, or `can` (an ACP agent says
   *  them per conversation, so they can come after connecting). Read them again. */
  | { type: "agent" }

export type PromptFile = { uri: string; name: string }

export type Transcript = {
  items: ChatItem[]
  permissions: PermissionAsk[]
  questions: Question[]
  /** Absent when no step has finished since the conversation began or was last summarised. */
  context?: ContextUse
}

export type Backend = {
  /** What it can do beyond the basics. It may change once the backend has said (an ACP agent,
   *  after it starts): a `{ type: "agent" }` event follows. */
  readonly can: BackendCan
  /** Starts the agent and says its version; rejects with a message fit to show the user.
   *  `computer` is what the agent calls itself. */
  info(): Promise<{ version: string; computer?: string }>
  projects(): Promise<string[]>
  listFolders(path: string): Promise<DirEntry[]>
  models(): Promise<ModelInfo[]>
  agents(): Promise<AgentInfo[]>

  /** The folder's conversations, newest first; with `archived`, the ones put away instead. */
  sessions(directory: string, archived?: boolean): Promise<SessionSummary[]>
  /** Resolves `null` when the session no longer exists. */
  session(id: string): Promise<SessionSummary | null>
  createSession(input: { directory: string; model?: ModelRef; title?: string; parent?: string }): Promise<SessionSummary>
  setModel(session: string, model: ModelRef): Promise<void>
  setAgent(session: string, agent: string): Promise<void>

  /** A fresh id for a message this client is about to send. */
  messageId(): string
  /** Queues a message as its own turn and returns its id at once, without waiting for the agent.
   *  With an `id` (from `messageId`), sending is safe to repeat: if the backend already has that
   *  message, nothing is queued twice and the call resolves with the same id. */
  prompt(
    session: string,
    input: { id?: string; text: string; files?: PromptFile[]; mentions?: Mention[]; delivery?: Delivery },
  ): Promise<{ id: string }>
  /** The agent's slash commands for a folder. */
  commands(directory: string): Promise<SlashCommand[]>
  /** Runs a slash command in a session. Resolves once it is queued. */
  command(
    session: string,
    input: { name: string; text: string; files?: PromptFile[]; mentions?: Mention[]; delivery?: Delivery },
  ): Promise<void>
  /** Skills available in a folder, as mention options (kind "skill"). */
  skills(directory: string): Promise<MentionOption[]>
  /** Files and folders under a folder whose path matches `query`, as mention options with `id`
   *  relative to the folder. */
  findFiles(directory: string, query: string): Promise<MentionOption[]>
  /** Asks for the conversation to be summarised, to free up context (the agent's own /compact).
   *  Resolves once it is queued. */
  compact(session: string, input?: { delivery?: Delivery }): Promise<void>
  rename(session: string, title: string): Promise<void>
  /** The folder's branch and uncommitted changes; undefined when it is not under version control. */
  vcs(directory: string): Promise<{ branch?: string; changes: RepoChange[] } | undefined>
  /** Puts the conversation away (out of `sessions()`), or brings it back. */
  archive(session: string, archived: boolean): Promise<void>
  /** Deletes the conversation for good. */
  remove(session: string): Promise<void>
  /** A new conversation that starts as a copy of this one. */
  fork(session: string): Promise<SessionSummary>
  /** Removes a queued message the agent has not picked up. */
  cancelQueued(session: string, id: string): Promise<void>
  /** Ids of sent messages the agent has not picked up yet, oldest first. */
  waiting(session: string): Promise<string[]>
  /** Ends the run under way. False when there was none running (the app's "busy" was out of
   *  date). What is queued stays queued and goes with the next message sent. */
  stop(session: string): Promise<boolean>
  /** The whole conversation as it stands, including messages still waiting in the queue. With
   *  `gap`, only what came after the last messages read before may have changed (a gap in the
   *  events, not an undo or a summary): a backend may then read only those. */
  transcript(session: string, opts?: { gap?: boolean }): Promise<Transcript>

  replyPermission(session: string, id: string, decision: PermissionDecision): Promise<void>
  answerQuestion(session: string, id: string, answer: Answer): Promise<void>
  dismissQuestion(session: string, id: string): Promise<void>

  /** Opens the event stream and keeps it open (reconnecting) until the returned function is
   *  called. Events for every session arrive here; callers filter by `session`. */
  listen(on: (event: BackendEvent) => void): () => void
}

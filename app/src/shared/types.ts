// Everything that crosses a boundary in the app lives here, and nothing else does.
//
//   app window (renderer) ⇄ main      AppState snapshots, ChatEvents, Commands      (via preload.ts)
//   main ⇄ agent backend              the Backend interface and its BackendEvents   (main/opencode.ts)
//
// The UI speaks of sites, notes and changes. Backend words (session, inbox, provider) stop at
// main: the renderer never sees a raw server payload.

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
   *  against. Absent when the server does not say. */
  context?: number
}

/** How full a conversation's context was at the agent's last finished step, in tokens, and
 *  which provider counted them: another provider's model counts differently. */
export type ContextUse = { used: number; providerID?: string }

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
  error?: string
  /** Not a reply: the server's summary of the conversation so far, written to free up context
   *  ("manual" when asked for with /compact, "auto" when the context filled up). Its one text
   *  part is the summary. */
  summary?: "manual" | "auto"
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
 *  /undo, …) or one the server offers for the site's folder. A built-in wins over a server
 *  command of the same name. */
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
  /** Which pictures of its area there are (`notePictures`): the one from when it was made, or
   *  that and the one taken when the agent was done. */
  pictures?: "before" | "both"
  /** The reviewer looked at the result and it is right. */
  accepted?: true
  /** What the agent did for it was taken back: "undone" with the conversation (it can still be
   *  brought back), or the agent was "asked" to reverse it. */
  takenBack?: "undone" | "asked"
}

/** A file the working tree has changed since the last commit. */
export type RepoChange = { file: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }

/** A named point in a conversation to go back to. */
export type Checkpoint = { id: string; session: string; name: string; time: number }

// ── app state ───────────────────────────────────────────────────────────────────────────────────
// Main owns it and pushes the whole snapshot on every change. It stays small: the conversation
// travels separately as ChatEvents.

export type ConnectionState =
  /** No server configured yet: show the connect form. */
  | { status: "unconfigured" }
  | { status: "connecting"; url: string }
  | { status: "online"; url: string; version: string }
  | { status: "offline"; url: string; error: string }

/** A server the app remembers. `url` is empty for this computer's while none is running here. */
/** A shell command the server is still running in a project's folder. `started` is a time in ms. */
export type RunningCommand = { id: string; directory: string; command: string; started: number }

/** A folder on a server. `server` is absent for the server in use; `on` is what to call the
 *  server ("k", "Studio Mac", or its address), `open` marks the project that is open. */
export type ProjectInfo = { directory: string; server?: string; on: string; open?: true }

/** `name` is the reviewer's for it, else its computer's own. */
export type ServerInfo = { id: string; name?: string; url: string; local: boolean; current: boolean }

export type SessionSummary = {
  id: string
  /** The server folder it works in. */
  directory: string
  /** Set on a child conversation (the background one); those stay out of the switcher. */
  parent?: string
  title: string
  updated: number
  busy: boolean
  model?: ModelRef
  agent?: string
  /** Set while part of the conversation is undone and can still be brought back: the id of the
   *  first message taken away. */
  undone?: string
  /** Put away: out of the list, kept on the server, and can be brought back. */
  archived?: true
  /** Kept at the top of the list. The app's own: the server does not know. */
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
  /** The reviewer's name for the server in use, else its computer's own name; with neither it
   *  goes by its address. */
  serverName?: string
  page: {
    /** What the URL bar shows. Empty before the first page. */
    url: string
    loading: boolean
    error?: string
    canGoBack: boolean
    canGoForward: boolean
    /** The page hot-reloads by itself, so the app leaves reloading to it. */
    hmr: boolean
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
  }
  /** The site under review and the server folder (the repo) that holds its code. `null` until
   *  there is a repo or a page. The repo comes first: with one open and no page yet, `origin` is
   *  "" and the conversation is the repo's own, which the first site opened takes over.
   *  `directory` is absent only for a page opened while no repo is known. */
  site: { origin: string; directory?: string } | null
  /** The repo that was open is not a folder on the server in use (it belonged to another
   *  computer): another one has to be chosen. */
  missingFolder?: string
  /** What the server in use has been running for a while, in the open repo first and then in
   *  its other projects: dev servers the agent started and nobody stopped. Something that
   *  has only just started (a command of the step the agent is on) is not here yet. */
  running: RunningCommand[]
  /** The open repo under version control: its branch, and what is changed and not committed.
   *  Absent when the folder is not a repository, or the server does not say. */
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
  /** Set while the person has to choose that model: the server lists several and none is saved
   *  (first launch), or the saved one is no longer on the server's list (`previous`). The window
   *  shows the chooser with `suggested` preselected; `setDefaultModel` answers it. No new
   *  conversation is made meanwhile. */
  modelChoice?: { suggested: ModelRef; previous?: ModelRef }
  permissions: PermissionAsk[]
  questions: Question[]
  /** How full the open conversation's context is: the tokens the agent's last finished step
   *  held, and the model's window (absent when the server gives none). Absent until a step has
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
  // review
  toggleReview(): void
  /** The top bar's switch. Notes and edit turn review on; the page takes the keyboard. */
  setMode(mode: ReviewMode): void
  /** The brush on or off. On, it turns review on and goes to notes mode. */
  toggleBrush(): void
  toggleAutoReload(): void
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
   *  of. Notes that waited together for the agent share a turn, and so a diff. */
  noteDiff(id: string): FileChange[]
  /** The result is right (or, with false, not looked at after all). */
  acceptNote(id: string, accepted: boolean): void
  /** Takes back what the agent did for a finished note. The newest message of its conversation
   *  is undone exactly, files included ("undone": /redo brings it back); for an older one the
   *  agent is asked to reverse its change ("asked"). */
  takeBackNote(id: string): "undone" | "asked"
  /** Marks this point of the open conversation, to come back to. */
  addCheckpoint(name: string): void
  removeCheckpoint(id: string): void
  /** Takes the conversation back to a checkpoint: every message after it leaves, and the files
   *  the agent changed since go back (in a git repository). /redo brings it all back until the
   *  next message. Returns how many messages were taken back. */
  returnToCheckpoint(id: string): number
  /** Looks again at the repo's branch and uncommitted changes (`AppState.repo`). */
  refreshRepo(): void
  /** Asks the agent, in the open conversation, to commit everything changed with this message. */
  commitChanges(message: string): void
  // connection and site
  connect(server: { url: string; password: string }): void
  /** The OpenCode server running on this computer, if there is one. Only its address: the
   *  password stays in main. */
  localServer(): { url: string } | null
  /** Connects to that server, and remembers to use whichever one runs here from now on. */
  connectLocal(): void
  /** Every server connected to so far, the one in use first. Passwords stay in main. */
  servers(): ServerInfo[]
  /** Connects to one of them. Its own repo, page and conversations come back with it. */
  useServer(id: string): void
  /** Forgets one that is not in use, with its password. Its notes stay on disk. */
  forgetServer(id: string): void
  /** Tries the saved server again. The outcome shows in `connection`. */
  reconnect(): void
  disconnect(): void
  /** Names the saved server; an empty name goes back to its address. */
  setServerName(name: string): void
  /** Folders the server already knows, most recently used first. */
  projects(): string[]
  /** Sub-folders of an absolute path on the server, for the folder picker. */
  listFolders(path: string): DirEntry[]
  /** Opens a repo: the folder the site on screen works in, and the one a site opened for the
   *  first time starts with. Works before any page is open. */
  setDirectory(directory: string): void
  /** Every project that can be opened: the folders the server in use knows (the open one
   *  first), then those of the other servers connected to before, as they were last seen. */
  allProjects(): ProjectInfo[]
  /** Switches to another project: the repo in that folder. With `server`, on that server:
   *  it is connected to first. Its site comes back as it was last
   *  open (page, notes, conversation); a project with no site yet opens with no page, at the
   *  step where a site is opened or the agent is asked to start one. */
  openProject(directory: string, server?: string): void
  /** Looks again at what is running (`AppState.running`), in every project of the server. */
  refreshRunning(): void
  /** Ends one running command; without an id, every one listed. */
  stopRunning(directory?: string, id?: string): void
  /** Asks the agent, in the open conversation, to get the repo's site running and say where.
   *  Its answer shows in the chat; the address it ends with is opened when no page is. */
  startSite(): void
  // chat
  /** `images` are pictures pasted or dropped into the message box, as data URIs. */
  send(text: string, images?: PromptFile[], options?: SendOptions): void
  /** What `/` offers: the app's own commands first, then the server's for the open site. */
  commands(): SlashCommand[]
  /** Runs `/name args` in the open conversation: a built-in here, anything else on the server. */
  runCommand(name: string, args: string, images?: PromptFile[], options?: SendOptions): CommandResult | void
  /** What `@query` could mean: files and folders of the site's code, skills, helper agents.
   *  At most 20, best first. An empty query lists skills and agents. */
  mentions(query: string): MentionOption[]
  /** Takes a message that is still waiting for its turn out of the queue. */
  cancelQueued(item: string): void
  stop(): void
  newSession(): void
  openSession(id: string): void
  /** Looks at the server's list again: the list of conversations asks when it opens. */
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
  /** Deletes a conversation on the server, for good. Unfinished notes sent to it fail. */
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
  platform: "darwin" | "linux" | "win32"
}

// ── backend ─────────────────────────────────────────────────────────────────────────────────────
// The seam to whatever runs the agent. OpenCode implements it today (main/opencode.ts); an ACP
// backend could later. Nothing outside the implementation knows the server's wire format.

export type InboxStatus = "queued" | "working" | "cancelled"

export type BackendEvent =
  | { type: "connection"; state: ConnectionState }
  /** Events were missed. Without `session`: the stream reconnected, re-read whatever is on
   *  screen. With it: only that conversation has a gap. */
  | { type: "resync"; session?: string }
  /** A sent message moved through the queue. `id` is the id `prompt` returned. */
  | { type: "inbox"; session: string; id: string; status: InboxStatus }
  /** The agent started, or stopped for the given reason. `succeeded` means its queue ran dry. */
  | { type: "run"; session: string; status: "started" | "succeeded" | "failed" | "interrupted"; error?: string }
  | { type: "session"; session: SessionSummary }
  /** The conversation was deleted on the server. Nothing sent to it will finish. */
  | { type: "session-gone"; session: string }
  | { type: "chat"; event: ChatEvent }
  /** A step ended and its tokens were counted, or (without `context`) the conversation was
   *  summarised and what it holds now is not known until the next step. */
  | { type: "context"; session: string; context?: ContextUse }
  | { type: "permission"; ask: PermissionAsk }
  | { type: "permission-done"; session: string; id: string }
  | { type: "question"; question: Question }
  | { type: "question-done"; session: string; id: string }

export type PromptFile = { uri: string; name: string }

export type Transcript = {
  items: ChatItem[]
  permissions: PermissionAsk[]
  questions: Question[]
  /** Absent when no step has finished since the conversation began or was last summarised. */
  context?: ContextUse
}

export type Backend = {
  /** Checks the URL and password. Rejects with a message fit to show the user. */
  /** `computer` is the name of the machine the server runs on, when it says. */
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
   *  With an `id` (from `messageId`), sending is safe to repeat: if the server already has that
   *  message, nothing is queued twice and the call resolves with the same id. That is what makes
   *  a retry after a lost reply safe. */
  prompt(
    session: string,
    input: { id?: string; text: string; files?: PromptFile[]; mentions?: Mention[]; delivery?: Delivery },
  ): Promise<{ id: string }>
  /** The server's slash commands for a folder. */
  commands(directory: string): Promise<SlashCommand[]>
  /** Runs a slash command in a session. Resolves once the server has accepted it. */
  command(
    session: string,
    input: { name: string; text: string; files?: PromptFile[]; mentions?: Mention[]; delivery?: Delivery },
  ): Promise<void>
  /** Skills available in a folder, as mention options (kind "skill"). */
  skills(directory: string): Promise<MentionOption[]>
  /** Files and folders under a folder whose path matches `query`, as mention options with `id`
   *  relative to the folder. */
  findFiles(directory: string, query: string): Promise<MentionOption[]>
  /** Asks for the conversation to be summarised, to free up context. Resolves once the server
   *  has taken the request; the summary arrives as chat events (an assistant item with
   *  `summary`). Without `delivery` it runs at the next step boundary. */
  compact(session: string, input?: { delivery?: Delivery }): Promise<void>
  /** The newest message of the user's that is still part of the conversation: what undo()
   *  would take back. `null` when there is none. */
  lastTurn(session: string): Promise<{ id: string; text: string; note?: { n: number; text: string } } | null>
  /** Takes the conversation back to just before `message`: that message and everything after
   *  it leave the conversation, and the files the agent changed since go back to how they were
   *  (where the folder is a git repository). It can be brought back with redo() until the next
   *  message is sent. Rejects while the agent is working. */
  undo(session: string, message: string): Promise<void>
  /** Brings back everything undo() took away. */
  redo(session: string): Promise<void>
  rename(session: string, title: string): Promise<void>
  /** The files changed by the turn that the user message `message` was part of, as patches. */
  diff(session: string, message: string): Promise<FileChange[]>
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
  stop(session: string): Promise<void>
  /** The shell commands still running in a folder: a dev server the agent started, a watcher,
   *  a long test run. Those that have ended are not among them. */
  running(directory: string): Promise<RunningCommand[]>
  /** Ends one of them. */
  kill(directory: string, id: string): Promise<void>
  /** The whole conversation as it stands, including messages still waiting in the queue. */
  transcript(session: string): Promise<Transcript>

  replyPermission(session: string, id: string, decision: PermissionDecision): Promise<void>
  answerQuestion(session: string, id: string, answer: Answer): Promise<void>
  dismissQuestion(session: string, id: string): Promise<void>

  /** Opens the event stream and keeps it open (reconnecting) until the returned function is
   *  called. Events for every session arrive here; callers filter by `session`. */
  listen(on: (event: BackendEvent) => void): () => void
}

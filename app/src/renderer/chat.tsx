// The conversation with the agent: switcher, transcript, things that need an answer, composer.
import { For, Match, Show, Switch, createEffect, createMemo, createRoot, createSignal, on, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type {
  Answer,
  ChatAssistant,
  ChatPart,
  ChatUser,
  Commands,
  FileChange,
  NoteStatus,
  PermissionAsk,
  PermissionDecision,
  Question,
  QuestionField,
  SessionSummary,
} from "../shared/types"
import { Composer } from "./composer"
import { CopyButton } from "./copy"
import { Icon, Kbd, toolIcon } from "./icons"
import { ServerButton } from "./connect"
import { openLightbox } from "./lightbox"
import { Markdown } from "./markdown"
import { RepoBar } from "./repo"
import { act, chat, focusedNote, keys, mac, message, b42, setNotice, setSwitcherOpen, state } from "./store"

// ── diffs ───────────────────────────────────────────────────────────────────────────────────────

const DIFF_LIMIT = 400

/** Long output, code and diffs are folded to their first lines; the rest is one click away. */
const FOLD = 20

type DiffLine = { kind: "add" | "del" | "hunk" | "ctx"; text: string }

/** A unified patch as display lines: file headers dropped, hunks kept. A patch with no hunk
 *  markers is shown as it came. */
function diffLines(patch: string): DiffLine[] {
  const out: DiffLine[] = []
  let inHunk = false
  for (const text of patch.split("\n")) {
    if (text.startsWith("@@")) {
      inHunk = true
      out.push({ kind: "hunk", text })
    } else if (inHunk) {
      const c = text[0]
      out.push({ kind: c === "+" ? "add" : c === "-" ? "del" : "ctx", text })
    }
  }
  if (!inHunk) for (const text of patch.split("\n")) out.push({ kind: "ctx", text })
  while (out.length && out[out.length - 1]!.text === "") out.pop()
  return out
}

export function Counts(props: { additions: number; deletions: number }) {
  return (
    <span class="counts">
      <span class="plus">+{props.additions}</span>
      <span class="minus">−{props.deletions}</span>
    </span>
  )
}

/** A path that keeps its file name when it has to shorten: the folder part gives way first. */
function Path(props: { path: string }) {
  const cut = () => props.path.lastIndexOf("/") + 1
  return (
    <span class="path" title={props.path}>
      <span class="path-dir">{props.path.slice(0, cut())}</span>
      <span class="path-name">{props.path.slice(cut())}</span>
    </span>
  )
}

/** One diff line: the +/− in a column of its own, then the text. A line that wraps continues
 *  under its own indentation, so code keeps its shape at any width. */
function DiffRow(props: { line: DiffLine }) {
  const hunk = () => props.line.kind === "hunk"
  const body = () => (hunk() ? props.line.text : props.line.text.slice(1))
  const indent = () => Math.min(24, (/^[ \t]*/.exec(body())?.[0] ?? "").replace(/\t/g, "  ").length)
  return (
    <span class={`dl ${props.line.kind}`}>
      <span class="dl-sign" aria-hidden={!hunk() && props.line.text[0] === " "}>
        {hunk() ? "" : props.line.kind === "del" ? "−" : props.line.kind === "add" ? "+" : ""}
      </span>
      <span class="dl-text" style={{ "--indent": String(indent()) }}>
        {body() || " "}
      </span>
    </span>
  )
}

export function Changes(props: { changes: FileChange[] }) {
  return (
    <For each={props.changes}>
      {(change) => {
        const lines = createMemo(() => diffLines(change.patch))
        // Folded like long output: the transcript is the one place that scrolls.
        const [all, setAll] = createSignal(false)
        const shown = () => (all() ? lines().slice(0, DIFF_LIMIT) : lines().slice(0, FOLD))
        return (
          <div class="change">
            <div class="change-head">
              <Path path={change.file} />
              <Counts additions={change.additions} deletions={change.deletions} />
            </div>
            <Show when={lines().length}>
              <pre class="diff">
                <For each={shown()}>{(line) => <DiffRow line={line} />}</For>
                <Show when={all() && lines().length > DIFF_LIMIT}>
                  <span class="dl hunk">
                    <span />
                    <span class="dl-text">{lines().length - DIFF_LIMIT} more lines</span>
                  </span>
                </Show>
              </pre>
              <Show when={lines().length > FOLD}>
                <button class="more-btn diff-more" aria-expanded={all()} onClick={() => setAll(!all())}>
                  <Icon name={all() ? "up" : "down"} />
                  {all() ? "Show fewer lines" : `Show all ${lines().length} lines`}
                </button>
              </Show>
            </Show>
          </div>
        )
      }}
    </For>
  )
}

// ── transcript items ────────────────────────────────────────────────────────────────────────────

type ToolPart = Extract<ChatPart, { kind: "tool" }>

/** `quiet`: the turn went on fine, so a step that failed along the way is a remark, not an alarm. */
function Tool(props: { part: ToolPart; quiet: boolean }) {
  const [open, setOpen] = createSignal(false)
  const totals = createMemo(() => {
    let additions = 0
    let deletions = 0
    for (const c of props.part.changes ?? []) (additions += c.additions), (deletions += c.deletions)
    return { additions, deletions, files: props.part.changes?.length ?? 0 }
  })
  const expandable = () => !!props.part.detail || totals().files > 0 || (props.quiet && !!props.part.error)
  // "read src/app.tsx" reads as what it did (strong) and to what (quiet).
  const cut = () => props.part.title.indexOf(" ")
  const verb = () => (cut() < 0 ? props.part.title : props.part.title.slice(0, cut()))
  const rest = () => (cut() < 0 ? "" : props.part.title.slice(cut() + 1))
  const row = () => (
    <>
      <Icon name={toolIcon(props.part.name)} />
      <span class="tool-title" title={props.part.title}>
        <span class="tool-verb">{verb()}</span>
        <Show when={rest()}>
          <span class="tool-arg">{rest()}</span>
        </Show>
      </span>
      <Show when={totals().files}>
        <Counts additions={totals().additions} deletions={totals().deletions} />
      </Show>
      <Switch>
        <Match when={props.part.status === "running"}>
          <Icon name="spinner" class="tool-state" />
        </Match>
        <Match when={props.part.status === "pending"}>
          <span class="tool-state">waiting</span>
        </Match>
        <Match when={props.part.status === "error" && props.quiet}>
          <span class="tool-state">failed</span>
        </Match>
        <Match when={props.part.status === "error"}>
          <span class="tool-state bad">
            <Icon name="alert" />
            failed
          </span>
        </Match>
      </Switch>
    </>
  )
  return (
    <div class="tool">
      <Show when={expandable()} fallback={<div class="tool-row">{row()}</div>}>
        <details onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary class="tool-row">
            {row()}
            <Icon name="right" class="caret" />
          </summary>
          {/* Built only when opened: a transcript can hold hundreds of diffs. */}
          <Show when={open()}>
            <div class="tool-body">
              <Show when={props.part.changes?.length}>
                <Changes changes={props.part.changes!} />
              </Show>
              <Show when={props.quiet && props.part.error}>
                <p class="tool-note">{props.part.error}</p>
              </Show>
              <Show when={props.part.detail}>
                <Output text={props.part.detail!} />
              </Show>
            </div>
          </Show>
        </details>
      </Show>
      <Show when={!props.quiet && props.part.error}>
        <div class="tool-error">{props.part.error}</div>
      </Show>
    </div>
  )
}


function Output(props: { text: string }) {
  const [all, setAll] = createSignal(false)
  const lines = createMemo(() => props.text.replace(/\n+$/, "").split("\n"))
  return (
    <div class="output-wrap">
      <pre class="output">{all() || lines().length <= FOLD ? props.text : lines().slice(0, FOLD).join("\n")}</pre>
      <Show when={lines().length > FOLD}>
        <button class="more-btn" aria-expanded={all()} onClick={() => setAll(!all())}>
          <Icon name={all() ? "up" : "down"} />
          {all() ? "Show fewer lines" : `Show all ${lines().length} lines`}
        </button>
      </Show>
    </div>
  )
}

function Thinking(props: { text: string; live: boolean }) {
  const [open, setOpen] = createSignal(false)
  // One line of what it is thinking about, cut early so a long thought costs nothing per delta.
  const preview = () => props.text.slice(0, 160).trimStart().split("\n", 1)[0]
  return (
    <details class="thinking" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Icon name="thought" spin={props.live} />
        <span>Thinking</span>
        <span class="thinking-preview">{preview()}</span>
        <Icon name="right" class="caret" />
      </summary>
      {/* Closed, a thought that streams in costs one preview line, not a DOM write per delta. */}
      <Show when={open()}>
        <div class="thinking-body">{props.text}</div>
      </Show>
    </details>
  )
}

/** The server's summary of the conversation so far (/compact, or the context filled up). Not a
 *  reply, so it is folded like a thought: one line says what happened, the summary is inside. */
function Summary(props: { item: ChatAssistant }) {
  const [open, setOpen] = createSignal(false)
  const text = () => {
    const part = props.item.parts.find((p) => p.kind === "text")
    return part && part.kind === "text" ? part.text : ""
  }
  const title = () =>
    !props.item.done ? "Summarising the conversation" : props.item.summary === "auto" ? "Conversation summarised: the context was full" : "Conversation summarised"
  return (
    <details class="thinking" data-summary={props.item.done ? "done" : "running"} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Icon name={props.item.done ? "list" : "spinner"} />
        <span>{title()}</span>
        <span class="thinking-preview">{props.item.done ? "The agent goes on from this summary" : text().slice(-80)}</span>
        <Icon name="right" class="caret" />
      </summary>
      <Show when={open()}>
        <div class="thinking-body">{text()}</div>
      </Show>
    </details>
  )
}

/** Note number → its live status, so a note in the conversation wears the same colour as its
 *  row in the list and its pin on the page. */
const noteStatus = createRoot(() =>
  createMemo(() => {
    const map = new Map<number, NoteStatus>()
    for (const n of state.review.notes) map.set(n.n, n.status)
    return map
  }),
)

function User(props: { item: ChatUser }) {
  return (
    <div class="msg user" classList={{ pending: props.item.pending }} data-item={props.item.id}>
      <div class="user-line">
        <Show when={props.item.note}>
          {(note) => (
            <span class="badge" data-status={noteStatus().get(note().n) ?? "gone"}>
              {note().n}
            </span>
          )}
        </Show>
        <div class="user-text">{props.item.note?.text ?? props.item.text}</div>
      </div>
      <Show when={props.item.images.length}>
        <div class="thumbs">
          <For each={props.item.images}>
            {(img, i) => (
              <button class="thumb" title={`Open ${img.name}`} aria-label={`Open picture ${i() + 1} of ${props.item.images.length}`} onClick={() => openLightbox(props.item.images, i())}>
                <img src={img.src} alt="" />
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.item.pending}>
        <div class="user-wait">
          <span>Waiting for its turn</span>
          <button
            class="wait-cancel"
            title="Take this message out of the queue"
            onClick={() =>
              b42
                .invoke("cancelQueued", props.item.id)
                .then(() => mark(props.item.note ? `Note ${props.item.note.n} is out of the queue` : "Your message is out of the queue"))
                .catch((err) => setNotice(message(err)))
            }
          >
            Cancel
          </button>
        </div>
      </Show>
    </div>
  )
}

function Assistant(props: { item: ChatAssistant }) {
  const words = () =>
    props.item.parts
      .filter((p) => p.kind === "text")
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join("\n\n")
  return (
    <div class="msg assistant">
      <Show when={props.item.summary}>
        <Summary item={props.item} />
      </Show>
      <For each={props.item.summary ? [] : props.item.parts}>
        {(part, i) => (
          <Switch>
            <Match when={part.kind === "text" && part}>
              {(p) => <Markdown text={p().text} streaming={!props.item.done} />}
            </Match>
            {/* A part has no end of its own: a thought is still going while nothing has come after it. */}
            <Match when={part.kind === "reasoning" && part}>
              {(p) => <Thinking text={p().text} live={!props.item.done && i() === props.item.parts.length - 1} />}
            </Match>
            <Match when={part.kind === "tool" && part}>{(p) => <Tool part={p()} quiet={!props.item.error} />}</Match>
          </Switch>
        )}
      </For>
      <Show when={props.item.error}>
        <div class="msg-error">
          <Icon name="alert" />
          <span>{props.item.error}</span>
        </div>
      </Show>
      <Show when={props.item.done && !props.item.summary && props.item.parts.at(-1)?.kind === "text" && words()}>
        <div class="msg-tools">
          <CopyButton text={words} label="Copy this reply" />
        </div>
      </Show>
    </div>
  )
}

/** What a new conversation offers to start with: one click sends it. Which ones depends on
 *  whether a page is open and working. Starting the site is the app's own request (`startSite`):
 *  the agent is told where the app runs, and the address it answers with is opened. */
type Suggestion = { label: string; text?: string; start?: true }
function suggestions(): Suggestion[] {
  const url = state.page.url
  const works = !!url && !state.page.error
  return [
    ...(works ? [] : [{ label: "Start the dev server here", start: true as const }]),
    ...(works ? [{ label: "Find the code for this page", text: `Which files make up the page at ${url}? List the route, its components and its styles, in a few lines.` }] : []),
    { label: "Show me around this repo", text: "Give me a short tour of this repo: what the site is built with, where pages, components and styles live, and how to run it." },
    { label: "Where are the colours, type and spacing defined?", text: "Where does this project define its design tokens (colours, type, spacing, radii)? Name the files and how components use them." },
  ]
}

function Suggestions() {
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const run = (s: Suggestion) => {
    setError("")
    setBusy(true)
    const sent = s.start ? b42.invoke("startSite") : b42.invoke("send", s.text ?? s.label)
    void sent.catch((err) => setError(message(err))).finally(() => setBusy(false))
  }
  return (
    <div class="suggestions" role="group" aria-label="Ways to start">
      <For each={suggestions()}>
        {(s) => (
          <button class="btn suggestion" disabled={busy() || state.connection.status !== "online" || (s.start && state.startingSite)} title={s.start ? "The agent starts it and the app opens it" : s.text} onClick={() => run(s)}>
            {s.label}
          </button>
        )}
      </For>
      <Show when={error()}>
        <p class="form-error">{error()}</p>
      </Show>
    </div>
  )
}

function Empty() {
  const page = () => !!state.page.url && !state.page.error
  return (
    <div class="chat-empty">
      <Show
        when={page()}
        fallback={
          <>
            <p class="chat-empty-lead">The agent is in the repo. Ask it anything.</p>
            <p>Once your site is open, you review it by clicking on it; each note goes to the agent on its own.</p>
          </>
        }
      >
        <p class="chat-empty-lead">Click anything on the page, write a note, press Enter.</p>
        <p>Each note goes to the agent on its own. Keep going; changes land while you review.</p>
      </Show>
      <Suggestions />
      <dl class="shortcuts" hidden={!page()}>
        <dt>
          <Kbd keys={keys("enter")} />
        </dt>
        <dd>Send the note</dd>
        <dt>
          <Kbd keys={keys("alt", "enter")} />
        </dt>
        <dd>Send it to work in the background</dd>
        <dt>
          <Kbd keys={keys("mod", "U")} />
        </dt>
        <dd>Preview the page, or back to reviewing</dd>
        <dt>
          <Kbd keys={keys("mod", "K")} />
        </dt>
        <dd>Write to the agent here</dd>
        <dt>
          <Kbd keys={keys("mod", "\\")} />
        </dt>
        <dd>Show or hide this panel</dd>
      </dl>
    </div>
  )
}

// ── permissions and questions ───────────────────────────────────────────────────────────────────

const VERBS: Record<string, string> = {
  edit: "Edit",
  write: "Write",
  patch: "Edit",
  shell: "Run",
  bash: "Run",
  read: "Read",
  webfetch: "Fetch",
  websearch: "Search the web for",
}

/** Actions whose resources are file paths (shortened from the left) rather than commands. */
const FILE_ACTIONS = new Set(["edit", "write", "patch", "read"])

/** An answered card goes away and takes the focus with it. Hand the focus to the next request
 *  that is waiting, or to the composer: the reviewer was working here with the keyboard. */
function focusAfterAsk(): void {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    const next = document.querySelector<HTMLElement>(".asks .ask") ?? document.querySelector<HTMLElement>(".composer textarea")
    next?.focus()
  })
}

const modKey = (e: KeyboardEvent) => (mac() ? e.metaKey : e.ctrlKey)

/** The conversation column's width, for cards that lay out differently when it is narrow. */
const [chatSize, setChatSize] = createSignal({ width: 400, height: 800 })

/** "1 of 3" when more than one request waits. Only the first is shown, so they never crowd out
 *  the conversation; the next one takes its place once this one is answered. */
function Count(props: { count: number; note?: number }) {
  const more = () => props.count - 1
  return (
    <Show when={props.count > 1 || props.note}>
      <p class="ask-count">
        <Show when={props.note}>
          <span>For note {props.note}</span>
        </Show>
        <Show when={props.count > 1}>
          <span class="ask-of">1 of {props.count}</span>
          <span>{more() === 1 ? "one more after this" : `${more()} more after this`}</span>
        </Show>
      </p>
    </Show>
  )
}

/** Lines of the window's own news in the transcript ("Note 5 is out of the queue"). They are not
 *  part of the conversation, so another conversation starts without them. */
const [marks, setMarks] = createSignal<string[]>([])
const mark = (text: string) => setMarks([...marks(), text])

/** The main-lane note the agent is working on: what a request from the main conversation is for. */
const noteAtWork = () => state.review.notes.find((n) => n.lane === "main" && n.status === "working")

function Permission(props: { ask: PermissionAsk; count: number }) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  // Main drops an answered ask from state, which unmounts this card.
  onCleanup(() => busy() && focusAfterAsk())
  const reply = (decision: PermissionDecision) => {
    setBusy(true)
    setError("")
    // On success main drops the ask from state and this card goes away with it.
    b42.invoke("replyPermission", props.ask.id, decision).catch((err) => {
      setError(message(err))
      setBusy(false)
    })
  }
  const verb = () => VERBS[props.ask.action] ?? props.ask.action.replace(/^./, (c) => c.toUpperCase())
  // In a narrow or short panel the request is a compact bar: what, and the buttons. The change
  // opens on demand, so the conversation keeps its room.
  const roomy = () => chatSize().width >= 380 && chatSize().height >= 640
  const [opened, setOpened] = createSignal<boolean | null>(null)
  const showDiff = () => opened() ?? roomy()
  const setShowDiff = (on: boolean) => setOpened(on)
  const totals = createMemo(() => {
    let additions = 0
    let deletions = 0
    for (const c of props.ask.changes ?? []) (additions += c.additions), (deletions += c.deletions)
    return { additions, deletions }
  })
  // A path the diff below already names is not repeated in the title.
  const listed = () => props.ask.resources
  return (
    <section
      class="ask"
      classList={{ compact: !roomy() }}
      tabIndex={-1}
      aria-label="The agent asks for permission"
      onKeyDown={(e) => {
        if (busy() || e.isComposing) return
        if (e.key === "Escape") reply("reject")
        else if (e.key === "Enter" && modKey(e)) reply("always")
        // On a button, Enter presses that button.
        else if (e.key === "Enter" && !e.shiftKey && !(e.target instanceof HTMLButtonElement)) reply("once")
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <Count count={props.count} note={props.ask.session === state.session?.id ? noteAtWork()?.n : undefined} />
      {/* A question the buttons answer: "Let the agent edit Hero.tsx?" */}
      {/* A question the buttons answer, in one run of text: "Let the agent edit Hero.tsx?" */}
      <p class="ask-question">
        Let the agent {verb().toLowerCase()}{" "}
        <For each={listed().slice(0, 3)}>
          {(r, i) => (
            <>
              {i() ? ", " : ""}
              <Show when={FILE_ACTIONS.has(props.ask.action)} fallback={<code title={r}>{r}</code>}>
                {/* The name; the full path is in its tooltip and in the change's header. */}
                <strong title={r}>{r.slice(r.lastIndexOf("/") + 1)}</strong>
              </Show>
            </>
          )}
        </For>
        <Show when={listed().length > 3}>
          <span title={listed().slice(3).join("\n")}> and {listed().length - 3} more</span>
        </Show>
        ?
        <Show when={props.ask.session !== state.session?.id}>
          <span class="ask-more"> (background note)</span>
        </Show>
      </p>
      <Show when={props.ask.message}>
        <p class="ask-text">{props.ask.message}</p>
      </Show>
      <Show when={props.ask.changes?.length}>
        <Show when={showDiff()}>
          <div class="ask-diff">
            <Changes changes={props.ask.changes!} />
          </div>
        </Show>
        <button class="more-btn" aria-expanded={showDiff()} onClick={() => setShowDiff(!showDiff())}>
          <Icon name={showDiff() ? "up" : "down"} />
          {showDiff() ? "Hide the change" : "Show the change"}
          <Show when={!showDiff()}>
            <Counts additions={totals().additions} deletions={totals().deletions} />
          </Show>
        </button>
      </Show>
      <Show when={error()}>
        <p class="form-error">{error()}</p>
      </Show>
      <div class="ask-actions">
        <button class="btn primary" disabled={busy()} title={`Allow once (${keys("enter")})`} onClick={() => reply("once")}>
          Allow once
        </button>
        <button class="btn" disabled={busy()} title={`Always allow (${keys("mod", "enter")})`} onClick={() => reply("always")}>
          Always allow
        </button>
        <button class="btn" disabled={busy()} title="Deny (Esc)" onClick={() => reply("reject")}>
          Deny
        </button>
      </div>
    </section>
  )
}

function Field(props: {
  id: string
  field: QuestionField
  picked: string[]
  typed: string
  pick: (value: string, on: boolean) => void
  type: (text: string) => void
}) {
  const f = () => props.field
  const many = () => f().type === "multiselect"
  const options = () => (f().type === "boolean" && !f().options?.length ? YES_NO : (f().options ?? []))
  return (
    <fieldset class="field">
      <legend>
        {f().title ?? f().key}
        <Show when={!f().required}>
          <span class="field-optional"> optional</span>
        </Show>
      </legend>
      <Show when={f().description}>
        <p class="field-desc">{f().description}</p>
      </Show>
      <For each={options()}>
        {(o) => (
          <label class="option">
            <input
              type={many() ? "checkbox" : "radio"}
              name={`${props.id}:${f().key}`}
              checked={props.picked.includes(o.value)}
              onChange={(e) => props.pick(o.value, e.currentTarget.checked)}
            />
            <span>
              {o.label}
              <Show when={o.description}>
                <span class="option-desc">{o.description}</span>
              </Show>
            </span>
          </label>
        )}
      </For>
      <Show when={!options().length || f().custom}>
        <input
          class="input"
          type={f().type === "number" ? "number" : "text"}
          aria-label={options().length ? "Something else" : (f().title ?? f().key)}
          placeholder={f().placeholder ?? (options().length ? "Something else" : "")}
          value={props.typed}
          onInput={(e) => props.type(e.currentTarget.value)}
        />
      </Show>
    </fieldset>
  )
}

const YES_NO: NonNullable<QuestionField["options"]> = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
]

/** One field's answer, or undefined while it has none. */
function fieldAnswer(f: QuestionField, picked: string[], typed: string): Answer[string] | undefined {
  const text = typed.trim()
  if (f.type === "multiselect") {
    const all = text ? [...picked, text] : picked
    return all.length ? all : undefined
  }
  if (f.type === "boolean") return picked.length ? picked[0] === "yes" : undefined
  if (f.type === "number") {
    const value = text || picked[0]
    return value && Number.isFinite(Number(value)) ? Number(value) : undefined
  }
  return text || picked[0] || undefined
}

function Ask(props: { question: Question; count: number }) {
  const [picked, setPicked] = createStore<Record<string, string[]>>({})
  const [typed, setTyped] = createStore<Record<string, string>>({})
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  onCleanup(() => busy() && focusAfterAsk())

  const answer = createMemo(() => {
    const out: Answer = {}
    let complete = true
    for (const f of props.question.fields) {
      const value = fieldAnswer(f, picked[f.key] ?? [], typed[f.key] ?? "")
      if (value !== undefined) out[f.key] = value
      else if (f.required) complete = false
    }
    return { out, complete }
  })

  const pick = (f: QuestionField, value: string, on: boolean) => {
    if (f.type === "multiselect") {
      const now = picked[f.key] ?? []
      setPicked(f.key, on ? [...now, value] : now.filter((v) => v !== value))
    } else {
      // One answer only: choosing an option clears what was typed, and the other way round.
      setPicked(f.key, [value])
      setTyped(f.key, "")
    }
  }
  const type = (f: QuestionField, text: string) => {
    setTyped(f.key, text)
    if (f.type !== "multiselect" && text) setPicked(f.key, [])
  }
  const settle = (call: Promise<void>) => {
    setBusy(true)
    setError("")
    call.catch((err) => {
      setError(message(err))
      setBusy(false)
    })
  }
  return (
    <form
      class="ask"
      tabIndex={-1}
      aria-label="The agent asks a question"
      onSubmit={(e) => {
        e.preventDefault()
        if (answer().complete && !busy()) settle(b42.invoke("answerQuestion", props.question.id, answer().out))
      }}
      onKeyDown={(e) => {
        if (busy() || e.isComposing) return
        if (e.key === "Escape") settle(b42.invoke("dismissQuestion", props.question.id))
        // Enter answers from anywhere in the form (a text field already does so by itself).
        else if (e.key === "Enter" && !e.shiftKey && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLInputElement && e.target.type !== "checkbox" && e.target.type !== "radio"))
          e.currentTarget.requestSubmit()
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <Count count={props.count} />
      <div class="ask-title">
        <span class="ask-verb">{props.question.title}</span>
      </div>
      <For each={props.question.fields}>
        {(f) => (
          <Field
            id={props.question.id}
            field={f}
            picked={picked[f.key] ?? []}
            typed={typed[f.key] ?? ""}
            pick={(value, on) => pick(f, value, on)}
            type={(text) => type(f, text)}
          />
        )}
      </For>
      <Show when={error()}>
        <p class="form-error">{error()}</p>
      </Show>
      <div class="ask-actions">
        {/* Always the primary action; until something is chosen it waits, and says why. */}
        <button
          class="btn answer-btn"
          classList={{ ready: answer().complete }}
          type="submit"
          disabled={busy()}
          aria-disabled={!answer().complete}
          title={answer().complete ? `Answer (${keys("enter")})` : "Choose an answer first"}
        >
          Answer
        </button>
        <button
          class="btn ghost"
          type="button"
          disabled={busy()}
          title="Esc"
          onClick={() => settle(b42.invoke("dismissQuestion", props.question.id))}
        >
          Dismiss
        </button>
      </div>
    </form>
  )
}

// ── conversation switcher ───────────────────────────────────────────────────────────────────────

function ago(time: number): string {
  const minutes = Math.floor((Date.now() - time) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / 60 / 24)}d`
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

// ── a checkpoint in the transcript ──────────────────────────────────────────────────────────────

function CheckpointLine(props: { id: string; name: string }) {
  /** "Return here" was pressed once: the second press does it. */
  const [sure, setSure] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const back = () => {
    setBusy(true)
    b42
      .invoke("returnToCheckpoint", props.id)
      .then(
        (n) => setNotice(`Took back ${n === 1 ? "1 message" : `${n} messages`} and what the agent changed since. /redo brings it back until you say something new.`),
        (err) => setNotice(message(err)),
      )
      .finally(() => (setBusy(false), setSure(false)))
  }
  return (
    <div class="marker checkpoint" data-checkpoint={props.id}>
      <Icon name="flag" />
      <span class="checkpoint-name" title={props.name}>
        {props.name}
      </span>
      <Show
        when={sure()}
        fallback={
          <>
            <button class="text-btn" title="Take the conversation, and the files, back to this point" onClick={() => setSure(true)}>
              Return here
            </button>
            <button class="icon-btn small" title="Remove this checkpoint" aria-label="Remove this checkpoint" onClick={() => act("removeCheckpoint", props.id)}>
              <Icon name="close" />
            </button>
          </>
        }
      >
        <span>Everything after it goes.</span>
        <button class="text-btn danger" disabled={busy()} onClick={back}>
          Return
        </button>
        <button class="text-btn" disabled={busy()} onClick={() => setSure(false)}>
          Stay
        </button>
      </Show>
    </div>
  )
}

/** The search field shows once the list is long enough to need it. */
const SEARCH_FROM = 6

function Conversations(props: { openSettings: () => void }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  /** The row being renamed, and the one asked about before it is deleted. */
  const [renaming, setRenaming] = createSignal("")
  const [confirming, setConfirming] = createSignal("")
  /** The archived conversations: asked for when their section is opened. */
  const [archived, setArchived] = createSignal<SessionSummary[] | undefined>()
  const [error, setError] = createSignal("")
  let root!: HTMLDivElement
  let button!: HTMLButtonElement
  let menu: HTMLDivElement | undefined
  /** A row's control is about to be replaced by another (a name by its field): focus leaving
   *  for a moment is not the reader leaving the menu. */
  let swapping = false

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) button.focus()
  }
  // The menu drops down inside the panel, never over the page: the page is a native view that
  // paints above everything in this window.
  const outside = (e: PointerEvent) => {
    if (open() && !root.contains(e.target as Node)) close(false)
  }
  onMount(() => document.addEventListener("pointerdown", outside))
  onCleanup(() => document.removeEventListener("pointerdown", outside))

  const stops = () => [...(menu?.querySelectorAll<HTMLElement>(".menu-search input, .menu-main") ?? [])]
  const step = (by: number) => {
    const items = stops()
    const at = items.indexOf(document.activeElement as HTMLElement)
    items[(at + by + items.length) % items.length]?.focus()
  }
  /** Changes what a row shows, then puts focus on what it shows now. */
  const swap = (change: () => void, focus: string) => {
    swapping = true
    change()
    queueMicrotask(() => {
      ;(menu?.querySelector<HTMLElement>(focus) ?? stops()[0] ?? button).focus()
      swapping = false
    })
  }
  const row = (id: string) => `[data-session="${CSS.escape(id)}"]`

  createEffect(() => {
    if (!open()) return
    setQuery("")
    setRenaming("")
    setConfirming("")
    setArchived(undefined)
    setError("")
    act("refreshSessions")
    ;(menu?.querySelector<HTMLElement>(".menu-search input") ?? menu?.querySelector<HTMLElement>("[aria-checked=true]") ?? stops()[0])?.focus()
  })

  const q = () => query().trim().toLowerCase()
  const found = createMemo(() => state.sessions.filter((s) => !q() || s.title.toLowerCase().includes(q()) || !!s.said?.includes(q())))
  const foundArchived = createMemo(() => (archived() ?? []).filter((s) => !q() || s.title.toLowerCase().includes(q())))
  const searchable = () => state.sessions.length >= SEARCH_FROM || !!query()

  /** A command whose failure is said in the menu, where it was asked for. */
  const run = <K extends "renameSession" | "archiveSession" | "deleteSession">(name: K, ...args: Parameters<Commands[K]>) => {
    setError("")
    return b42.invoke(name, ...args).then(
      () => true,
      (err) => (setError(message(err)), false),
    )
  }
  const loadArchived = (): Promise<void> =>
    b42.invoke("archivedSessions").then(
      (list) => void setArchived(list),
      (err) => {
        setArchived([])
        setError(message(err))
      },
    )
  const rename = (s: SessionSummary, title: string) => {
    const clean = title.replace(/\s+/g, " ").trim()
    swap(() => setRenaming(""), `${row(s.id)} .menu-main`)
    if (!clean || clean === s.title) return
    void run("renameSession", s.id, clean).then((ok) => void (ok && s.archived && loadArchived()))
  }
  const putAway = (s: SessionSummary, away: boolean) => {
    // The row goes: focus moves to the list first, so the menu stays open under the reader.
    swap(() => undefined, away ? ".menu-search input" : ".menu-archived")
    void run("archiveSession", s.id, away).then(() => void (archived() && loadArchived()))
  }
  const remove = (s: SessionSummary) => {
    swap(() => setConfirming(""), ".menu-search input")
    void run("deleteSession", s.id).then(() => void (archived() && loadArchived()))
  }

  const Row = (p: { s: SessionSummary }) => {
    const s = () => p.s
    const current = () => s().id === state.session?.id
    return (
      <div class="menu-row" data-session={s().id} classList={{ current: current() }}>
        <Switch>
          <Match when={confirming() === s().id}>
            <span class="menu-ask" title={s().title}>
              Delete “{s().title || "Untitled"}”?
            </span>
            <button class="menu-do danger" data-do="delete" onClick={() => remove(s())}>
              Delete
            </button>
            <button class="menu-do" onClick={() => swap(() => setConfirming(""), `${row(s().id)} .menu-main`)}>
              Keep
            </button>
          </Match>
          <Match when={renaming() === s().id}>
            <input
              class="menu-rename"
              type="text"
              aria-label="The conversation's name"
              spellcheck={false}
              autocomplete="off"
              value={s().title}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename(s(), e.currentTarget.value)
                else if (e.key === "Escape") swap(() => setRenaming(""), `${row(s().id)} .menu-main`)
                else return void e.stopPropagation() // the arrows move the caret here, not the row
                e.preventDefault()
                e.stopPropagation()
              }}
            />
          </Match>
          <Match when={true}>
            <button
              class="menu-main"
              role="menuitemradio"
              aria-checked={current()}
              onClick={() => {
                if (s().archived) return putAway(s(), false)
                close(true)
                if (!current()) act("openSession", s().id)
              }}
            >
              <Show when={s().pinned} fallback={<span class="dot" classList={{ busy: s().busy }} title={s().busy ? "Working" : undefined} />}>
                <span class="menu-pin" classList={{ busy: s().busy }} title={s().busy ? "Pinned · working" : "Pinned"}>
                  <Icon name="pin" />
                </span>
              </Show>
              <span class="menu-title" title={s().title || "Untitled"}>
                {s().title || "Untitled"}
              </span>
              <span class="menu-meta">
                <Show when={s().notes}>
                  <span title={`${s().notes} ${s().notes === 1 ? "note" : "notes"} of this site went to it`}>
                    {s().notes} {s().notes === 1 ? "note" : "notes"}
                  </span>
                </Show>
                <time>{ago(s().updated)}</time>
              </span>
            </button>
            <span class="menu-acts">
              <Show
                when={!s().archived}
                fallback={
                  <button class="icon-btn small" title="Bring back" aria-label="Bring back" data-do="restore" onClick={() => putAway(s(), false)}>
                    <Icon name="restore" />
                  </button>
                }
              >
                <button
                  class="icon-btn small"
                  title={s().pinned ? "Unpin" : "Pin to the top"}
                  aria-label={s().pinned ? "Unpin" : "Pin to the top"}
                  aria-pressed={!!s().pinned}
                  data-do="pin"
                  onClick={() => act("pinSession", s().id, !s().pinned)}
                >
                  <Icon name="pin" />
                </button>
                <button class="icon-btn small" title="Rename" aria-label="Rename" data-do="rename" onClick={() => swap(() => (setConfirming(""), setRenaming(s().id)), `${row(s().id)} .menu-rename`)}>
                  <Icon name="pencil" />
                </button>
                <button class="icon-btn small" title="Archive (it can be brought back)" aria-label="Archive" data-do="archive" onClick={() => putAway(s(), true)}>
                  <Icon name="archive" />
                </button>
              </Show>
              <button class="icon-btn small" title="Delete" aria-label="Delete" data-do="ask-delete" onClick={() => swap(() => (setRenaming(""), setConfirming(s().id)), `${row(s().id)} [data-do=delete]`)}>
                <Icon name="trash" />
              </button>
            </span>
          </Match>
        </Switch>
      </div>
    )
  }

  return (
    <div
      class="convo"
      ref={root}
      onFocusOut={(e) => {
        if (open() && !swapping && !root.contains(e.relatedTarget as Node | null)) close(false)
      }}
    >
      <ServerButton onClick={props.openSettings} />
      <button
        ref={button}
        class="convo-current"
        aria-haspopup="menu"
        aria-expanded={open()}
        disabled={!state.session}
        title="Conversations: switch, rename, archive"
        onClick={() => setOpen(!open())}
      >
        <Show when={state.session?.busy}>
          <span class="dot busy" />
        </Show>
        <span class="convo-title">{state.session?.title || "Conversation"}</span>
        <Icon name="down" />
      </button>
      <RepoBar onOpen={() => close(false)} />
      <button
        class="icon-btn"
        title="New conversation, or another project"
        aria-label="New conversation, or another project"
        aria-haspopup="dialog"
        data-action="switcher"
        disabled={state.connection.status !== "online"}
        onClick={() => setSwitcherOpen(true)}
      >
        <Icon name="plus" />
      </button>
      <Show when={open()}>
        <div
          class="menu"
          role="menu"
          ref={menu}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (confirming() || renaming()) swap(() => (setConfirming(""), setRenaming("")), ".menu-main")
              else close(true)
            } else if (e.key === "ArrowDown") step(1)
            else if (e.key === "ArrowUp") step(-1)
            else return
            e.preventDefault()
          }}
        >
          <Show when={searchable()}>
            <label class="menu-search">
              <Icon name="search" />
              <input
                type="text"
                aria-label="Search conversations, by name or by what a note said"
                placeholder="Search names and notes"
                spellcheck={false}
                autocomplete="off"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return
                  e.preventDefault()
                  menu?.querySelector<HTMLElement>(".menu-main")?.click()
                }}
              />
            </label>
          </Show>
          <Show when={error()}>
            <p class="menu-empty menu-error" role="alert">
              {error()}
            </p>
          </Show>
          <For each={found()} fallback={<p class="menu-empty">{q() ? "No conversation matches." : "No other conversations yet."}</p>}>{(s) => <Row s={s} />}</For>
          <button
            class="menu-archived"
            aria-expanded={!!archived()}
            onClick={() => {
              if (archived()) setArchived(undefined)
              else void loadArchived()
            }}
          >
            <Icon name="right" class="caret" />
            Archived
          </button>
          <Show when={archived()}>
            <For each={foundArchived()} fallback={<p class="menu-empty">{q() ? "Nothing archived matches." : "Nothing is archived."}</p>}>
              {(s) => <Row s={s} />}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  )
}

// ── the whole thing ─────────────────────────────────────────────────────────────────────────────

/** `covered`: something of the panel's (a note's view, passed as children) stands in the place of
 *  the header and the transcript. They stay mounted under it, and the requests and the message
 *  box stay in use. */
export function Chat(props: {
  composerRef: (el: HTMLTextAreaElement) => void
  openSettings: () => void
  covered?: boolean
  children?: JSX.Element
}) {
  let scroller!: HTMLDivElement
  let section!: HTMLElement
  let content!: HTMLDivElement
  // Follow new output only while the reader is at the bottom. Not a signal: it changes on every
  // scroll event and nothing renders from it; `away` flips only when the button must show or hide.
  let stuck = true
  /** "Latest" shows only this far from the end: a few lines up is still reading the end. */
  const AWAY = 160
  let lastTop = 0
  const [away, setAway] = createSignal(false)

  // What has happened, then what is still waiting for its turn. One list, so a message that is
  // delivered moves within it and keeps its row; the same store objects, so <For> keeps every
  // other row too. With nothing waiting it is the store's own array.
  const ordered = createMemo(() => {
    // With no conversation open, the banner above the chat carries main's error; it is not
    // repeated here.
    if (!state.session) return chat.items.filter((item) => item.kind !== "marker")
    const waiting = chat.items.filter((item) => item.kind === "user" && item.pending)
    if (!waiting.length) return chat.items
    return [...chat.items.filter((item) => !(item.kind === "user" && item.pending)), ...waiting]
  })

  /** The reader opened or closed something in the transcript. The growth that follows is theirs,
   *  not the agent's: following it would scroll what they just opened out of view. */
  const readerActed = () => {
    stuck = false
    requestAnimationFrame(() => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      stuck = distance < 32
      setAway(distance > AWAY)
    })
  }

  const toBottom = () => {
    stuck = true
    setAway(false)
    scroller.scrollTop = scroller.scrollHeight
  }
  onMount(() => {
    // Whatever makes the transcript taller (a delta, an image loading, the panel resizing) ends
    // up here once per frame, so following costs one scrollTop write, not one per delta.
    const grow = new ResizeObserver(() => {
      if (stuck) scroller.scrollTop = scroller.scrollHeight
    })
    grow.observe(content)
    grow.observe(scroller)
    // Capture: `toggle` does not bubble, and this must run before the row builds its body.
    scroller.addEventListener("toggle", readerActed, true)
    const width = new ResizeObserver(() => setChatSize({ width: section.clientWidth, height: section.clientHeight }))
    width.observe(section)
    onCleanup(() => width.disconnect())
    onCleanup(() => grow.disconnect())
  })
  /** The main-lane note the agent is on now, named in the "Working" line. */
  const workingNote = createMemo(() => state.review.notes.find((n) => n.lane === "main" && n.status === "working"))

  // Requests that wait for the reviewer, shown one at a time: permissions first, then questions.
  const waiting = () => state.permissions.length + state.questions.length
  const head = createMemo(() =>
    state.permissions[0] ? `p:${state.permissions[0].id}` : state.questions[0] ? `q:${state.questions[0].id}` : "",
  )

  // A pin clicked on the page: bring its message into view and point at it.
  createEffect(
    on(
      focusedNote,
      (focus) => {
        if (!focus) return
        const note = state.review.notes.find((n) => n.id === focus.id)
        if (!note) return
        let id = ""
        for (let i = chat.items.length - 1; i >= 0 && !id; i--) {
          const item = chat.items[i]!
          if (item.kind === "user" && item.note?.n === note.n) id = item.id
        }
        const el = id && scroller.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"]`)
        if (!el) return
        stuck = false
        const still = matchMedia("(prefers-reduced-motion: reduce)").matches
        el.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" })
        el.classList.remove("flash")
        void el.offsetWidth // restart the animation when the same pin is clicked again
        el.classList.add("flash")
      },
      { defer: true },
    ),
  )

  createEffect(on(() => state.session?.id, () => setMarks([]), { defer: true }))

  // A hidden scroller forgets where it was: put it back when the cover goes.
  createEffect(
    on(
      () => !!props.covered,
      (covered) => {
        if (covered) return
        const top = lastTop
        requestAnimationFrame(() => (stuck ? toBottom() : (scroller.scrollTop = top)))
      },
      { defer: true },
    ),
  )

  // Opening another conversation starts at its end.
  createEffect(on(() => state.session?.id, toBottom, { defer: true }))

  return (
    <section class="chat" classList={{ covered: !!props.covered }} aria-label="Conversation" ref={section}>
      <Conversations openSettings={props.openSettings} />
      {props.children}
      <div class="transcript-wrap" classList={{ away: away() }}>
        <div
          class="transcript"
          ref={scroller}
          onScroll={() => {
            // Scroll events arrive a frame late, and the transcript may have grown since: "not at
            // the bottom" alone does not mean the reader left. Moving up does.
            // Hidden under a note's view it reads as scrolled to the top; that is not the reader.
            if (props.covered) return
            const top = scroller.scrollTop
            // The fade at the top edge only once something has gone under it.
            scroller.classList.toggle("scrolled", top > 4)
            if (scroller.scrollHeight - top - scroller.clientHeight < 32) stuck = true
            else if (top < lastTop) stuck = false
            lastTop = top
            const far = !stuck && scroller.scrollHeight - top - scroller.clientHeight > AWAY
            if (away() !== far) setAway(far)
          }}
        >
          <div class="transcript-content" ref={content}>
            <Show when={chat.items.length === 0 && state.session}>
              <Empty />
            </Show>
            <For each={ordered()}>
              {(item) => (
                <Switch>
                  <Match when={item.kind === "user" && item}>{(i) => <User item={i()} />}</Match>
                  <Match when={item.kind === "assistant" && item}>{(i) => <Assistant item={i()} />}</Match>
                  <Match when={item.kind === "marker" && item}>
                    {(i) => (
                      <Show
                        when={i().checkpoint}
                        fallback={
                          <div class="marker" classList={{ bad: i().tone === "error" }}>
                            <span>{i().text}</span>
                          </div>
                        }
                      >
                        {(id) => <CheckpointLine id={id()} name={i().text} />}
                      </Show>
                    )}
                  </Match>
                </Switch>
              )}
            </For>
            <For each={marks()}>
              {(text) => (
                <div class="marker">
                  <span>{text}</span>
                </div>
              )}
            </For>
            <Show when={state.session?.busy}>
              <div class="working" role="status">
                <Icon name="spinner" />
                <Show when={workingNote()} fallback="Working">
                  {(note) => (
                    <>
                      <span>Working on</span>
                      <span class="badge" data-status="working">
                        {note().n}
                      </span>
                      <span class="working-note" title={note().text}>
                        {note().text}
                      </span>
                    </>
                  )}
                </Show>
              </div>
            </Show>
          </div>
        </div>
        <Show when={away()}>
          <button class="jump" onClick={toBottom}>
            <Icon name="jump" />
            Latest
          </button>
        </Show>
      </div>
      <Show when={head()} keyed>
        {(key) => (
          <div class="asks">
            <Show
              when={state.permissions.find((p) => `p:${p.id}` === key)}
              fallback={
                <Show when={state.questions.find((q) => `q:${q.id}` === key)}>
                  {(q) => <Ask question={q()} count={waiting()} />}
                </Show>
              }
            >
              {(p) => <Permission ask={p()} count={waiting()} />}
            </Show>
          </div>
        )}
      </Show>
      <Composer ref={props.composerRef} onSent={toBottom} />
    </section>
  )
}

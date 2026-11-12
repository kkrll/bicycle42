// The window: top bar, a strip for a failed command, the page's box and the panel.
//
// The page itself is not in this document. Main draws it as a native view exactly over the
// `.page` box, and that view paints above every element here. So this file's one hard duty is to
// keep main told where the box is (setPageBounds), and to take the page away (null) whenever
// something of ours must show where it sits:
//   · no page is open yet, or the connect screen is up
//   · the settings dialog is open
//   · the panel is being resized (the native view would swallow the drag)
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { Rect, ReviewMode, Shortcut } from "../shared/types"
import { ConnectScreen, ModelScreen, ServerButton, SettingsDialog, SetupSteps, firstRunConnecting } from "./connect"
import { Icon, Kbd, type IconName } from "./icons"
import { Panel, RepoScreen, countNotes, countWords, shortWords } from "./panel"
import {
  act,
  host,
  keys,
  mac,
  notice,
  b42,
  ready,
  recall,
  remember,
  expandNotes,
  setFocusedNote,
  setNotice,
  state, pageCovered, message } from "./store"

const PANEL_MIN = 320
const PANEL_DEFAULT = 400

// ── top bar ─────────────────────────────────────────────────────────────────────────────────────

/** The address as it fits in `chars` characters while the field is not being edited: no scheme,
 *  the host whole, and a long path cut in the middle ("localhost:3000/products/…/page=4"). */
export function shortUrl(url: string, chars: number): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const rest = u.pathname === "/" && !u.search && !u.hash ? "" : u.pathname + u.search + u.hash
  const whole = u.host + rest
  if (whole.length <= chars || !rest) return whole
  const room = chars - u.host.length - 1
  if (room < 8) return u.host + (rest.length > 1 ? "/…" : "")
  const head = Math.ceil(room * 0.4)
  return u.host + rest.slice(0, head) + "…" + rest.slice(rest.length - (room - head))
}

function UrlField(props: { ref: (el: HTMLInputElement) => void }) {
  // null while the field shows the page's own address; a string while the user is typing.
  const [draft, setDraft] = createSignal<string | null>(null)
  // How many characters the field shows (12px mono is about 7.2px a character).
  const [chars, setChars] = createSignal(80)
  let el!: HTMLInputElement
  onMount(() => {
    const observer = new ResizeObserver(() => setChars(Math.max(12, Math.floor((el.clientWidth - 20) / 7.2))))
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })
  return (
    <input
      ref={(e) => {
        el = e
        props.ref(e)
      }}
      class="url"
      type="text"
      aria-label="Page address"
      title={state.page.url || undefined}
      spellcheck={false}
      autocomplete="off"
      placeholder="Your dev URL, e.g. localhost:3000"
      value={draft() ?? (state.page.url ? shortUrl(state.page.url, chars()) : "")}
      onFocus={(e) => {
        // Editing starts from the whole address.
        const input = e.currentTarget
        setDraft(state.page.url)
        requestAnimationFrame(() => input.select())
      }}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const url = e.currentTarget.value.trim()
          if (url) act("navigate", url)
          e.currentTarget.blur()
        } else if (e.key === "Escape") {
          setDraft(null)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

// ── hints: what a control does and its key, after the pointer rests on it ──────────────────────
// Not a tooltip under the control: the page view is drawn over the window below the top bar, so
// anything there would be hidden under it. The hint sits in the bar itself, just left of the
// controls, over the end of the address field.

type HintText = { text: string; keys: string[] }
const [hint, setHint] = createSignal<HintText | null>(null)
/** The pointer rests this long before a hint shows; once one is up, the next shows at once. */
const HINT_DELAY = 600
const HINT_WARM = 400
let hintTimer: ReturnType<typeof setTimeout> | undefined
let hintGone = 0

/** Event handlers for a control with a hint. `what` is read when the hint shows, so it follows
 *  state (Show / Hide the panel). */
function hinted(what: () => HintText) {
  const hide = () => {
    clearTimeout(hintTimer)
    if (hint()) hintGone = Date.now()
    setHint(null)
  }
  return {
    onPointerEnter: () => {
      clearTimeout(hintTimer)
      const warm = !!hint() || Date.now() - hintGone < HINT_WARM
      if (warm) setHint(what())
      else hintTimer = setTimeout(() => setHint(what()), HINT_DELAY)
    },
    onPointerLeave: hide,
    // A click is the answer to the question the hint was for.
    onPointerDown: hide,
  }
}

function Hint() {
  return (
    <Show when={hint()}>
      {(h) => (
        <div class="bar-hint" role="tooltip">
          <span>{h().text}</span>
          <For each={h().keys}>{(k) => <Kbd keys={k} />}</For>
        </div>
      )}
    </Show>
  )
}

/** Preview | Annotate | Edit | Motion: what a click on the page does (verbs, all of them;
 *  "annotate" is the mode that makes notes, and `notes` in the state). Each shows what it does
 *  and its key, if it has one, when the pointer rests on it. */
const MODES: { mode: ReviewMode; label: string; icon: IconName; what: string; keys?: () => string }[] = [
  { mode: "preview", label: "Preview", icon: "eye", what: "Use the page as it is", keys: () => keys("mod", "U") },
  { mode: "notes", label: "Annotate", icon: "note", what: "Point at something, say what to change", keys: () => keys("mod", "P") },
  { mode: "edit", label: "Edit", icon: "frame", what: "Change the page itself, then send", keys: () => keys("mod", "O") },
  { mode: "motion", label: "Motion", icon: "motion", what: "See what moves on the page, change an animation, then send", keys: () => keys("mod", "I") },
]
/** mod+U, P, O, I (and mod+shift+P, the pencil), by the key's place: the same keys on any layout,
 *  a Cyrillic one included. */
const MODE_KEYS: Record<string, ReviewMode> = { KeyU: "preview", KeyP: "notes", KeyO: "edit", KeyI: "motion" }

function ModeSwitch(props: { disabled: boolean }) {
  return (
    <div class="modes" role="radiogroup" aria-label="Mode">
      <For each={MODES}>
        {(m) => (
          <button
            class="mode"
            role="radio"
            data-mode={m.mode}
            aria-checked={state.review.mode === m.mode}
            aria-description={m.what}
            aria-keyshortcuts={m.keys?.()}
            disabled={props.disabled}
            onClick={() => act("setMode", m.mode)}
            {...hinted(() => ({ text: m.what, keys: m.keys ? [m.keys()] : [] }))}
          >
            <Icon name={m.icon} />
            <span class="mode-label">{m.label}</span>
          </button>
        )}
      </For>
    </div>
  )
}

function TopBar(props: {
  bare: boolean
  urlRef: (el: HTMLInputElement) => void
  panelOpen: boolean
  togglePanel: () => void
  showNotes: () => void
  openSettings: () => void
}) {
  // No page, or a page the overlay could not get into: nothing for the modes to act on.
  const noOverlay = () => !state.page.url || overlayError()
  return (
    <header class="topbar" classList={{ mac: mac() }}>
      <Show when={!props.bare} fallback={<span class="wordmark">bicycle 42</span>}>
        <div class="nav">
          <button class="icon-btn" aria-label="Back" title="Back" disabled={!state.page.canGoBack} onClick={() => act("back")}>
            <Icon name="back" />
          </button>
          <button
            class="icon-btn"
            aria-label="Forward"
            title="Forward"
            disabled={!state.page.canGoForward}
            onClick={() => act("forward")}
          >
            <Icon name="forward" />
          </button>
          <button
            class="icon-btn"
            aria-label="Reload"
            title={state.page.loading ? "Loading" : "Reload"}
            disabled={!state.page.url}
            onClick={() => act("reload")}
          >
            <Icon name={state.page.loading ? "spinner" : "reload"} />
          </button>
        </div>
        <UrlField ref={props.urlRef} />
        <PageError />
        <div class="tools">
          <Hint />
          <button
            class="icon-btn boxed"
            data-action="draw"
            aria-label="Draw on the page"
            aria-pressed={state.review.brush}
            aria-description="A line selects what it crosses, a loop what it encloses"
            disabled={noOverlay()}
            onClick={() => act("toggleBrush")}
            {...hinted(() => ({ text: "Draw: a line selects what it crosses", keys: [keys("mod", "shift", "P"), `${keys("alt")} drag`] }))}
          >
            <Icon name="draw" size={20} />
          </button>
          <ModeSwitch disabled={noOverlay()} />
          {/* With the panel open the server button is in its conversation row, and the notes are
              right there: both are here only while they cannot be seen in the panel. */}
          <Show when={!props.panelOpen || !state.site?.directory}>
            <ServerButton onClick={props.openSettings} />
          </Show>
          <Show when={!props.panelOpen}>
            <NotesStatus panelOpen={props.panelOpen} showNotes={props.showNotes} />
          </Show>
          <button
            class="icon-btn"
            data-action="panel"
            aria-label="Notes and conversation"
            aria-pressed={props.panelOpen}
            aria-keyshortcuts={keys("mod", "\\")}
            onClick={props.togglePanel}
            {...hinted(() => ({ text: `${props.panelOpen ? "Hide" : "Show"} notes and conversation`, keys: [keys("mod", "\\")] }))}
          >
            <Icon name="panel" />
          </button>
        </div>
      </Show>
    </header>
  )
}

/** The page's error is about the review overlay, not the page: the page itself is fine. */
const overlayError = () => /overlay/i.test(state.page.error ?? "")
/** The page itself failed to load: the view would show a stale or blank page. */
const loadFailed = () => !!state.page.error && !overlayError()

/** The page loaded without the review overlay. Said beside its address, so the page does not
 *  move; the full message is in the tooltip. (A page that failed to load gets a card instead.) */
function PageError() {
  return (
    <Show when={overlayError() && state.page.error}>
      {(error) => (
        <div class="page-error" role="alert" title={`${host(state.page.url)}: ${error()}`}>
          <Icon name="alert" />
          <span class="page-error-text">Notes are off on this page</span>
          <button class="text-btn" onClick={() => act("reload")}>
            Try again
          </button>
        </div>
      )}
    </Show>
  )
}

/** The notes at a glance, beside the panel button, in words: "1 failed · 2 working · 6 waiting",
 *  done quieter. In a narrow window, one chip: "1 failed · 8 left". Before the site has a folder,
 *  the way to choose one. */
function NotesStatus(props: { panelOpen: boolean; showNotes: () => void }) {
  const counts = createMemo(countNotes)
  const needsFolder = () => !!state.site && !state.site.directory && state.connection.status === "online"
  const tone = () => (counts().failed ? "failed" : counts().working ? "working" : counts().paused ? "paused" : "waiting")
  const sentence = () => `${counts().total} notes: ${countWords(counts()).join(", ")}`
  return (
    <Switch>
      <Match when={needsFolder() && !props.panelOpen}>
        <button class="text-btn status-btn" onClick={props.showNotes}>
          Choose code folder
        </button>
      </Match>
      <Match when={state.review.notes.length}>
        <button
          class="status-btn counts-btn"
          aria-label={`${sentence()}. Show notes`}
          title={`${sentence()}. Click to show them.`}
          onClick={props.showNotes}
        >
          <span class="counts-full">
            <For each={(["failed", "working", "paused", "waiting", "stopped", "done"] as const).filter((k) => counts()[k])}>
              {(k) => (
                <span class="count" data-status={k}>
                  <Show when={k !== "done" && k !== "stopped"}>
                    <span class="count-dot" />
                  </Show>
                  {counts()[k]} {k}
                </span>
              )}
            </For>
          </span>
          <span class="counts-short count" data-status={shortWords(counts()) === "all done" ? "done" : tone()}>
            <Show when={shortWords(counts()) !== "all done"}>
              <span class="count-dot" />
            </Show>
            {shortWords(counts())}
          </span>
        </button>
      </Match>
    </Switch>
  )
}

// ── strip ───────────────────────────────────────────────────────────────────────────────────────
// A command failed and nothing else owns the message. Rare, and dismissed by the reviewer.

function Strips() {
  return (
    <Show when={notice()}>
      <div class="strip bad" role="alert">
        <Icon name="alert" />
        <span class="strip-text">{notice()}</span>
        <button class="icon-btn small" aria-label="Dismiss" title="Dismiss" onClick={() => setNotice("")}>
          <Icon name="close" />
        </button>
      </div>
    </Show>
  )
}

// ── window ──────────────────────────────────────────────────────────────────────────────────────

const sameRect = (a: Rect | null | undefined, b: Rect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)

export function App() {
  const [panelOpen, setPanelOpen] = createSignal(recall("panel.open") !== "0")
  const [panelWidth, setPanelWidth] = createSignal(Math.max(PANEL_MIN, Number(recall("panel.width")) || PANEL_DEFAULT))
  const [settings, setSettings] = createSignal(false)
  const [resizing, setResizing] = createSignal(false)
  // The panel's size, for the panel to decide whether its notes list fits.
  const [panelSize, setPanelSize] = createSignal({ width: 0, height: 0 })
  let panelEl!: HTMLElement
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      // A frame later: what the panel lays out from this size changes what is observed.
      const r = entry!.contentRect
      const size = { width: Math.round(r.width), height: Math.round(r.height) }
      if (size.width > 0) requestAnimationFrame(() => setPanelSize(size))
    })
    observer.observe(panelEl)
    onCleanup(() => observer.disconnect())
  })
  let pageEl!: HTMLDivElement
  let urlEl: HTMLInputElement | undefined
  let composerEl: HTMLTextAreaElement | undefined

  // The first-run screen: no server yet, or the form on that screen is waiting for main.
  const connectStep = () => state.connection.status === "unconfigured" || firstRunConnecting()
  // …or connected, and main asks which model conversations should start with.
  const modelStep = () => !connectStep() && !!state.modelChoice && state.connection.status === "online"
  // …or ready to work, and no repo is open: the folder comes before the site.
  const repoStep = () => !connectStep() && !modelStep() && state.connection.status === "online" && !state.site?.directory
  const setup = () => connectStep() || modelStep() || repoStep()
  // The shortcut on the empty (or failed) page: the agent gets the site running and says where.
  const [startError, setStartError] = createSignal("")
  const startSite = () => {
    setStartError("")
    openPanel()
    b42.invoke("startSite").catch((err) => setStartError(message(err)))
  }
  const canStart = () => state.connection.status === "online" && !!state.session && !state.startingSite
  // A page that failed to load is replaced by a card saying so, in the same place.
  const pageHidden = () => setup() || settings() || resizing() || state.page.url === "" || loadFailed() || pageCovered()

  // ── page bounds: one call per frame at most, none when nothing moved ──
  let sent: Rect | null | undefined
  let frame = 0
  const report = () => {
    frame = 0
    let next: Rect | null = null
    if (!pageHidden()) {
      // Inside the pane's border, so the border stays visible around the page view.
      const r = pageEl.getBoundingClientRect()
      const x = Math.round(r.x + pageEl.clientLeft)
      const y = Math.round(r.y + pageEl.clientTop)
      if (pageEl.clientWidth >= 1 && pageEl.clientHeight >= 1) next = { x, y, width: pageEl.clientWidth, height: pageEl.clientHeight }
    }
    if (sameRect(sent, next)) return
    sent = next
    act("setPageBounds", next)
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(report)
  }
  onMount(() => {
    // The box only moves when it also changes size (a strip appears, the panel resizes, the
    // window resizes), so observing its size covers its position too.
    const observer = new ResizeObserver(schedule)
    observer.observe(pageEl)
    window.addEventListener("resize", schedule)
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", schedule)
      cancelAnimationFrame(frame)
    })
  })
  createEffect(() => {
    // Hiding must not wait a frame: whatever needs the space is already on screen.
    if (pageHidden()) report()
    else schedule()
  })

  // ── panel ──
  const togglePanel = () => {
    setPanelOpen(!panelOpen())
    remember("panel.open", panelOpen() ? "1" : "0")
  }
  const openPanel = () => panelOpen() || togglePanel()
  /** From the top bar's note counts: the panel, open on the notes, at the first one that needs
   *  the reviewer (failed, else working). */
  const showNotes = () => {
    openPanel()
    expandNotes()
    requestAnimationFrame(() => {
      const first =
        document.querySelector('.note:has(.note-status[data-status="failed"])') ??
        document.querySelector('.note:has(.note-status[data-status="working"])')
      if (first) first.scrollIntoView({ block: "nearest" })
      else document.querySelector(".notes-list")?.scrollTo({ top: 0 })
    })
  }
  const maxWidth = () => Math.max(PANEL_MIN, Math.floor(window.innerWidth / 2))
  const clampWidth = (w: number) => Math.min(maxWidth(), Math.max(PANEL_MIN, Math.round(w)))

  let dragFrom: { x: number; width: number } | undefined
  const dragStart = (e: PointerEvent) => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragFrom = { x: e.clientX, width: clampWidth(panelWidth()) }
  }
  const dragMove = (e: PointerEvent) => {
    if (!dragFrom) return
    // The page goes away on the first move, not on press, so a plain click does not blink it.
    setResizing(true)
    setPanelWidth(clampWidth(dragFrom.width + dragFrom.x - e.clientX))
  }
  const dragEnd = () => {
    if (!dragFrom) return
    dragFrom = undefined
    setResizing(false)
    remember("panel.width", String(panelWidth()))
  }
  const nudge = (by: number) => {
    setPanelWidth(clampWidth(clampWidth(panelWidth()) + by))
    remember("panel.width", String(panelWidth()))
  }

  // ── focus and shortcuts ──
  const focusUrl = () => {
    window.focus()
    urlEl?.focus()
  }
  const focusChat = () => {
    if (!panelOpen()) togglePanel()
    window.focus()
    // The panel may have just been un-hidden; a hidden field cannot take focus until it is laid out.
    requestAnimationFrame(() => composerEl?.focus())
  }
  const onShortcut = (s: Shortcut) => {
    if (setup() || settings()) return
    if (s === "focus-url") focusUrl()
    else if (s === "toggle-panel") togglePanel()
    else focusChat()
  }
  const onKey = (e: KeyboardEvent) => {
    if (!(mac() ? e.metaKey : e.ctrlKey) || e.altKey || setup() || settings()) return
    const key = e.key.toLowerCase()
    const mode = e.shiftKey ? undefined : MODE_KEYS[e.code]
    // The same keys as while the page has the keyboard: mod+U again goes back to the mode it left.
    if (e.shiftKey) {
      if (e.code !== "KeyP") return
      act("toggleBrush")
    } else if (mode === "preview") act("toggleReview")
    else if (mode) act("setMode", mode)
    else if (key === "l") focusUrl()
    else if (key === "\\") togglePanel()
    else if (key === "k") focusChat()
    else return
    e.preventDefault()
  }
  onMount(() => {
    window.addEventListener("keydown", onKey)
    const off = b42.onShortcut(onShortcut)
    // A pin clicked on the page: its row in the list and its message in the chat come into view.
    const offFocus = b42.onNoteFocus(({ id }) => {
      openPanel()
      expandNotes()
      setFocusedNote({ id, at: Date.now() })
    })
    onCleanup(() => {
      window.removeEventListener("keydown", onKey)
      off()
      offFocus()
    })
  })
  // Nothing to look at yet: put the caret where the next step happens.
  createEffect(() => {
    if (ready() && !setup() && state.page.url === "") urlEl?.focus()
  })

  return (
    <div class="app" style={{ "--panel-width": `${panelWidth()}px` }}>
      <TopBar
        bare={!ready() || setup()}
        urlRef={(el) => (urlEl = el)}
        panelOpen={panelOpen()}
        togglePanel={togglePanel}
        showNotes={showNotes}
        openSettings={() => setSettings(true)}
      />
      <Show when={ready() && !setup()}>
        <Strips />
      </Show>
      <main class="work" inert={!ready() || setup()}>
        {/* While a dialog is open or the panel is resized the page view is away: a quiet surface
            stands in for it, so the window does not go black. */}
        <div class="page" ref={pageEl} classList={{ veiled: settings() || resizing() }}>
          <Show when={state.page.url !== "" && loadFailed()}>
            <div class="page-failed" role="alert">
              <Icon name="alert" size={20} />
              <p class="chat-empty-lead page-failed-host" title={state.page.url}>
                Can't load {host(state.page.url)}
              </p>
              <p class="page-failed-why">
                {/refused|not_resolved|timed_out|unreachable/i.test(state.page.error ?? "")
                  ? "Nothing answered at that address. Is the site's dev server running?"
                  : "The page did not open."}
              </p>
              <p class="page-failed-detail">{state.page.error}</p>
              <div class="page-actions">
                <button class="btn primary" onClick={() => act("reload")}>
                  Try again
                </button>
                <Show when={state.site?.directory}>
                  <button class="btn" disabled={!canStart()} onClick={startSite}>
                    {state.startingSite ? "The agent is starting it…" : "Ask the agent to start it"}
                  </button>
                </Show>
              </div>
              <Show when={startError()}>
                <p class="form-error">{startError()}</p>
              </Show>
            </div>
          </Show>
          <Show when={state.page.url === ""}>
            <div class="page-empty">
              <SetupSteps at={3} />
              <p class="chat-empty-lead">Open your site.</p>
              <p>
                If it is running, type its address above and press Enter. If it is not, the agent can start it from
                the repo and open it here; it asks you when it needs something.
              </p>
              <div class="page-actions">
                <button class="btn primary" disabled={!canStart()} onClick={startSite}>
                  {state.startingSite ? "The agent is starting it…" : "Ask the agent to start it"}
                </button>
              </div>
              <Show when={state.startingSite}>
                <p class="page-starting">Its answer is in the panel. The site opens here once it is up.</p>
              </Show>
              <Show when={startError()}>
                <p class="form-error">{startError()}</p>
              </Show>
            </div>
          </Show>
        </div>
        <Show when={panelOpen()}>
          <div
            class="resizer"
            classList={{ active: resizing() }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the panel"
            aria-valuemin={PANEL_MIN}
            aria-valuemax={maxWidth()}
            aria-valuenow={panelWidth()}
            tabindex="0"
            onPointerDown={dragStart}
            onPointerMove={dragMove}
            onPointerUp={dragEnd}
            onPointerCancel={dragEnd}
            onLostPointerCapture={dragEnd}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") nudge(16)
              else if (e.key === "ArrowRight") nudge(-16)
            }}
          />
        </Show>
        {/* Hidden, not unmounted: the conversation keeps its scroll position and rendered text. */}
        <aside class="panel" ref={panelEl} hidden={!panelOpen()}>
          <Panel composerRef={(el) => (composerEl = el)} openSettings={() => setSettings(true)} size={panelSize()} />
        </aside>
      </main>
      <Show when={ready() && connectStep()}>
        <ConnectScreen />
      </Show>
      <Show when={ready() && modelStep()}>
        <ModelScreen />
      </Show>
      <Show when={ready() && repoStep()}>
        <RepoScreen />
      </Show>
      <Show when={settings()}>
        <SettingsDialog onClose={() => setSettings(false)} />
      </Show>
    </div>
  )
}

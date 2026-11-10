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
import type { Rect, Shortcut } from "../shared/types"
import { ConnectScreen, ModelScreen, SettingsDialog, SetupSteps, connectionText, firstRunConnecting } from "./connect"
import { Icon } from "./icons"
import { Panel, countNotes, countWords, shortWords } from "./panel"
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
  state, pageCovered } from "./store"

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

function Toggle(props: { on: boolean; label: string; title: string; disabled?: boolean; accent?: boolean; onClick: () => void }) {
  return (
    <button
      class="toggle"
      classList={{ accent: props.accent }}
      role="switch"
      aria-checked={props.on}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
    >
      <span class="toggle-track" />
      {props.label}
    </button>
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
  const serverWord = () =>
    state.connection.status === "offline" ? "Offline" : state.connection.status === "connecting" ? "Connecting" : ""
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
          <Toggle
            accent
            on={state.review.enabled}
            label="Review"
            title={`Click, drag or draw on the page to leave notes (${keys("mod", "shift", "M")})`}
            disabled={!state.page.url}
            onClick={() => act("toggleReview")}
          />
          <Show
            when={!state.page.hmr}
            fallback={
              <span class="tool-note" title="This page updates by itself when files change, so the app doesn't reload it.">
                Page reloads itself
              </span>
            }
          >
            <Toggle
              on={state.review.autoReload}
              label="Auto-reload"
              title="Reload the page when the agent finishes a note"
              disabled={!state.page.url}
              onClick={() => act("toggleAutoReload")}
            />
          </Show>
          <button
            class="icon-btn"
            classList={{ labelled: serverWord() !== "" }}
            data-action="settings"
            data-status={state.connection.status}
            aria-label={serverWord() ? `Server: ${serverWord()}` : "Server"}
            title={connectionText(state.connection)}
            onClick={props.openSettings}
          >
            <Icon name="server" />
            <Show when={serverWord()} fallback={<span class="dot" data-status={state.connection.status} />}>
              <span>{serverWord()}</span>
            </Show>
          </button>
          <NotesStatus panelOpen={props.panelOpen} showNotes={props.showNotes} />
          <button
            class="icon-btn"
            data-action="panel"
            aria-label="Notes and conversation"
            aria-pressed={props.panelOpen}
            title={`${props.panelOpen ? "Hide" : "Show"} notes and conversation (${keys("mod", "\\")})`}
            onClick={props.togglePanel}
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
  const setup = () => connectStep() || modelStep()
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
    if (e.shiftKey) {
      if (key !== "m") return
      act("toggleReview")
    } else if (key === "l") focusUrl()
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
              <button class="btn primary" onClick={() => act("reload")}>
                Try again
              </button>
            </div>
          </Show>
          <Show when={state.page.url === ""}>
            <div class="page-empty">
              <SetupSteps at={2} />
              <p class="chat-empty-lead">Open your running site.</p>
              <p>
                Type its address above and press Enter. The page opens here, and you review it by clicking on it.
              </p>
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
      <Show when={settings()}>
        <SettingsDialog onClose={() => setSettings(false)} />
      </Show>
    </div>
  )
}

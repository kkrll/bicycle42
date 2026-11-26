// The window: top bar, a strip for a failed command, the panel at the left and the page's box.
//
// The page itself is not in this document. Main draws it as a native view exactly over the
// `.page` box, and that view paints above every element here. So this file's one hard duty is to
// keep main told where the box is (setPageBounds), and to take the page away (null) whenever
// something of ours must show where it sits:
//   · no page is open yet, or the connect screen is up
//   · the settings dialog is open
//   · the panel is being resized (the native view would swallow the drag)
import { For, Match, Show, Switch, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { PHONES, phoneOf, type CaptureKind, type Device, type Rect, type ReviewMode, type Shortcut } from "../shared/types"
import { sizeOf } from "../shared/wire"
import { DockRegion, PhoneAside, dockShown } from "./dock"
import { DsSpace } from "./ds-space"
import { copyText } from "./copy"
import { CAPTURES, ConnectScreen, ModelScreen, ServerButton, SettingsDialog, SetupSteps, firstRunConnecting } from "./connect"
import { Icon, Kbd, type IconName } from "./icons"
import { frameOf } from "./phone"
import { StatusStrip, surroundOf } from "./phone-frame"
import { KeysSheet } from "./keys-sheet"
import { Switcher } from "./switcher"
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
  state, pageCovered, message, switcherOpen, setSwitcherOpen, setPanelUp } from "./store"

const PANEL_MIN = 320
const PANEL_DEFAULT = 400
/** A dock under the page: its height, between these. (Beside a phone's page it takes the width left.) */
const DOCK_MIN = 160
const DOCK_DEFAULT = 360
/** What stays of the page above a dock, whatever the dock is dragged to. */
const PAGE_MIN = 120
/** In a short window the dock takes more than half the stage, up to DOCK_DEFAULT, while the page
 *  keeps this: a 720px window's Motion dock then has room for two of its tracks. */
const PAGE_SHORT = 300
/** What a phone's column holds besides the phone, top to bottom: 16px of air above and below, the
 *  picker's row (28) and the gap under it (20). The ring around the phone (8) is drawn in the air
 *  and the gap, and takes no room. The same numbers as `.stage.phone > .device-col` and
 *  `.device-bar` in styles.css. */
const PHONE_AROUND = 16 + 28 + 20 + 16
/** What a phone's column needs beside the phone: the ring (8) at both sides, and air beyond it.
 *  The same as the column's min-width in styles.css. */
const PHONE_SIDES = 34
/** A phone is never drawn smaller than this: under it the window is too small to review in. */
const PHONE_FIT_MIN = 0.3
/** The column at a phone's right is never left less than this by the panel: a dock's narrowest
 *  shape (`.stage.phone > .dock` in styles.css has the same number). */
const COLUMN_MIN = 300

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
  const [width, setWidth] = createSignal(600)
  const chars = () => Math.max(12, Math.floor((width() - 20) / 7.2))
  let el!: HTMLInputElement
  onMount(() => {
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })
  return (
    <div class="url-field">
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
    </div>
  )
}

// ── hints: what a control does and its key, after the pointer rests on it ──────────────────────
// Not a tooltip under the control: the page view is drawn over the window below the top bar, so
// anything there would be hidden under it. The hint sits in the bar itself, over the end of the
// address field, so it covers none of the controls right of the address.

type HintText = { text: string; keys: string[] }
const [hint, setHint] = createSignal<HintText | null>(null)
/** The hint came up at once, the pointer going from one control to the next: it has no fade. */
const [hintWarm, setHintWarm] = createSignal(false)
/** The pointer rests this long before a hint shows: a pointer passing over on its way to a click
 *  never sees one, one resting on a control it does not know is told soon. Once one is up, the
 *  next shows at once. */
const HINT_DELAY = 600
const HINT_WARM = 400
/** A hint stays this long after the pointer leaves its control: on the way to the control next
 *  to it the hint is not taken down and put up again (which blinked), only its words change. */
const HINT_LINGER = 120
let hintTimer: ReturnType<typeof setTimeout> | undefined
let hintLeave: ReturnType<typeof setTimeout> | undefined
let hintGone = 0

/** Event handlers for a control with a hint. `what` is read when the hint shows, so it follows
 *  state. */
function hinted(what: () => HintText) {
  const drop = () => {
    if (hint()) hintGone = Date.now()
    setHint(null)
  }
  const hide = (atOnce: boolean) => {
    clearTimeout(hintTimer)
    clearTimeout(hintLeave)
    if (atOnce || !hint()) drop()
    else hintLeave = setTimeout(drop, HINT_LINGER)
  }
  return {
    onPointerEnter: () => {
      clearTimeout(hintTimer)
      clearTimeout(hintLeave)
      const warm = !!hint() || Date.now() - hintGone < HINT_WARM
      setHintWarm(warm)
      if (warm) setHint(what())
      else hintTimer = setTimeout(() => setHint(what()), HINT_DELAY)
    },
    onPointerLeave: () => hide(false),
    // A click is the answer to the question the hint was for.
    onPointerDown: () => hide(true),
  }
}

/** Words in the hint's place for a moment, with no control under the pointer: what a key did. */
let flashTimer: ReturnType<typeof setTimeout> | undefined
function flashHint(text: string) {
  const shown: HintText = { text, keys: [] }
  clearTimeout(flashTimer)
  setHintWarm(false)
  setHint(shown)
  flashTimer = setTimeout(() => hint() === shown && setHint(null), 1500)
}

function Hint() {
  return (
    <Show when={hint()}>
      {(h) => (
        <div class="bar-hint" classList={{ warm: hintWarm() }} role="tooltip">
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
const MODES: { mode: ReviewMode; label: string; icon: IconName; what: string; keys?: () => string; more?: () => string }[] = [
  // Held, alt+A is Preview for as long as it is held: the layer out of sight, nothing switched.
  { mode: "preview", label: "Preview", icon: "eye", what: "Use the page as it is", keys: () => keys("mod", "U"), more: () => `hold ${keys("alt", "A")}` },
  { mode: "notes", label: "Annotate", icon: "note", what: "Point at something, say what to change", keys: () => keys("mod", "P") },
  { mode: "edit", label: "Edit", icon: "frame", what: "Change the page itself, then send", keys: () => keys("mod", "O") },
  { mode: "motion", label: "Motion", icon: "motion", what: "See what moves on the page, change an animation, then send", keys: () => keys("mod", "I") },
]
/** mod+U, P, O, I (and mod+shift+P, the pencil), by the key's place: the same keys on any layout,
 *  a Cyrillic one included. */
/** Where a key types: a text field, a text box, or anything editable. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range"].includes(target.type)) || target instanceof HTMLSelectElement)

/** The least the address keeps before the modes' names go under their icons: a short local
 *  address and its path ("localhost:3000/pricing", 22 characters of 12 px mono, and padding). */
const URL_ROOM = 200
const MODE_KEYS: Record<string, ReviewMode> = { KeyU: "preview", KeyP: "notes", KeyO: "edit", KeyI: "motion" }

/** The switch is a radio group: one Tab stop (the mode in use), and the arrows move along it
 *  and choose as they go, Home and End to either end. The keyboard stays on the switch while
 *  it does (a click hands it to the page, as the mode's keys do). `stacked`: each mode's name
 *  under its icon, in a narrow bar (TopBar). */
function ModeSwitch(props: { disabled: boolean; stacked: boolean; ref: (el: HTMLDivElement) => void }) {
  let group: HTMLDivElement | undefined
  const step = (e: KeyboardEvent) => {
    const at = MODES.findIndex((m) => m.mode === state.review.mode)
    const n = MODES.length
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (at + 1) % n
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (at - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1
    if (to < 0 || e.altKey || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    act("setMode", MODES[to]!.mode, true)
    group?.querySelectorAll<HTMLButtonElement>(".mode")[to]?.focus()
  }
  return (
    <div
      class="modes"
      classList={{ stacked: props.stacked }}
      role="radiogroup"
      aria-label="Mode"
      ref={(el) => {
        group = el
        props.ref(el)
      }}
      onKeyDown={step}
    >
      <For each={MODES}>
        {(m) => (
          <button
            class="mode"
            role="radio"
            data-mode={m.mode}
            aria-checked={state.review.mode === m.mode}
            aria-description={m.what}
            aria-keyshortcuts={m.keys?.()}
            tabindex={state.review.mode === m.mode ? 0 : -1}
            disabled={props.disabled}
            onClick={() => act("setMode", m.mode)}
            {...hinted(() => ({ text: m.what, keys: [m.keys?.(), m.more?.()].filter((k): k is string => !!k) }))}
          >
            <Icon name={m.icon} />
            <span class="mode-label" data-label={m.label}>
              {m.label}
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

/** Desktop | Phone | Design system, beside the address: how the page is shown, or its variables
 *  in its place (Device in shared/types.ts). */
const DEVICES: { device: Device; label: string; icon: IconName; what: () => string }[] = [
  { device: "desktop", label: "Desktop", icon: "desktop", what: () => "The page as on a desktop: as wide as its pane" },
  { device: "phone", label: "Phone", icon: "phone", what: () => `The page as on a phone: ${phoneOf(state.page.phone).width} px wide` },
  { device: "ds", label: "Design system", icon: "tokens", what: () => "The page's design system: its variables, to see and change" },
]

function DeviceSwitch(props: { disabled: boolean }) {
  return (
    <div class="devices" role="radiogroup" aria-label="Show the page as">
      <For each={DEVICES}>
        {(d) => (
          <button
            class="device"
            role="radio"
            data-device={d.device}
            aria-label={d.label}
            aria-checked={state.page.device === d.device}
            aria-description={d.what()}
            disabled={props.disabled}
            onClick={() => act("setDevice", d.device)}
            {...hinted(() => ({ text: d.what(), keys: [] }))}
          >
            <Icon name={d.icon} />
          </button>
        )}
      </For>
    </div>
  )
}

/** Which phone, above a phone's page: a native list under words (as the composer's model is),
 *  because the list opens over the page, where nothing of this document's would show. */
function PhonePick(props: { fit: number }) {
  const phone = () => phoneOf(state.page.phone)
  const size = (p: { width: number; height: number }) => `${p.width} × ${p.height}`
  /** Drawn smaller than life (the phone is taller than its room): by how much. The page's own
   *  size is the phone's all the same. */
  const percent = () => (props.fit < 1 ? `${Math.round(props.fit * 100)}%` : "")
  const title = () =>
    `Shown as an ${phone().name}: ${size(phone())} px`.replace(/ an (?=[^AEIOUaeiou])/, " a ") +
    (percent() ? `, drawn at ${percent()} to fit the window` : "")
  return (
    <label class="pick phone-pick" title={title()}>
      <span class="pick-text">
        <span class="pick-long">{phone().name}</span>
        <span class="phone-size">
          {size(phone())}
          <Show when={percent()}> · {percent()}</Show>
        </span>
      </span>
      <Icon name="down" />
      <select class="pick-native" aria-label="Phone" onChange={(e) => act("setPhone", e.currentTarget.value)}>
        <For each={PHONES}>
          {(p) => (
            <option value={p.id} selected={p.id === phone().id}>
              {p.name} · {size(p)}
            </option>
          )}
        </For>
      </select>
    </label>
  )
}

function TopBar(props: {
  bare: boolean
  urlRef: (el: HTMLInputElement) => void
  panelOpen: boolean
  /** The panel is open but has no room in this window beside a phone's page and its dock. */
  panelCrowded: boolean
  togglePanel: () => void
  showNotes: () => void
  openSettings: () => void
}) {
  // No page, or a page the overlay could not get into: nothing for the modes to act on.
  const noOverlay = () => !state.page.url || overlayError()
  // A narrow bar: the address gives up its width first, down to URL_ROOM; past that the modes'
  // names go under their icons, so they stay. Back on one line only once the address would
  // still have URL_ROOM with them there (what stacking gave it is measured when it does).
  const [stacked, setStacked] = createSignal(false)
  // Reload's spinner turns for the first seconds of a load only. A page counts as loading for as
  // long as anything on it is still being fetched, and one request that is never answered kept
  // the spinner (and the window's redrawing) going for good. The title still says "Loading…".
  const [loadShown, setLoadShown] = createSignal(false)
  createEffect(() => {
    setLoadShown(state.page.loading)
    if (!state.page.loading) return
    const t = setTimeout(() => setLoadShown(false), 8000)
    onCleanup(() => clearTimeout(t))
  })
  let field: HTMLElement | undefined
  let modes: HTMLDivElement | undefined
  let gave = 0
  const fit = () => {
    if (!field || !modes) return
    const room = field.getBoundingClientRect().width
    if (!stacked() && room < URL_ROOM) {
      const wide = modes.getBoundingClientRect().width
      setStacked(true)
      gave = wide - modes.getBoundingClientRect().width
    } else if (stacked() && room - gave >= URL_ROOM) setStacked(false)
  }
  // A frame later: stacking resizes the field it watches, which is a loop inside one callback.
  const watch = new ResizeObserver(() => requestAnimationFrame(fit))
  onCleanup(() => watch.disconnect())
  return (
    <header class="topbar" classList={{ mac: mac() }}>
      <Show when={!props.bare} fallback={<><span class="wordmark">Bicycle42</span><UpdateButton /></>}>
        {/* First in the bar, over the panel it shows and hides. (A plain title, as the buttons
            beside it have: the bar's own hint is at the other end, by the modes.) */}
        <button
          class="icon-btn"
          data-action="panel"
          aria-label="Notes and conversation"
          aria-pressed={props.panelOpen}
          aria-keyshortcuts={keys("mod", "J")}
          disabled={props.panelCrowded}
          title={
            props.panelCrowded
              ? "No room for the notes beside a phone's page and its dock: widen the window, or leave Edit and Motion"
              : `${props.panelOpen ? "Hide" : "Show"} notes and conversation (${keys("mod", "J")} or ${keys("mod", "\\")})`
          }
          onClick={props.togglePanel}
        >
          <Icon name="panel" />
        </button>
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
            title={state.page.loading ? "Loading…" : "Reload"}
            disabled={!state.page.url}
            onClick={() => act("reload")}
          >
            <Icon name={loadShown() ? "spinner" : "reload"} />
          </button>
        </div>
        <DeviceSwitch disabled={!state.page.url} />
        <UrlField
          ref={(el) => {
            props.urlRef(el)
            // (The field's box, around the input: what the bar leaves the address.)
            queueMicrotask(() => {
              field = el.parentElement ?? undefined
              if (field) watch.observe(field)
            })
          }}
        />
        {/* The hint's place: at the end of the address, left of every control after it (one
            anchored by the tools covered the page's error). */}
        <div class="hint-anchor">
          <Hint />
        </div>
        <PageError />
        <PageRefused />
        {/* Of the app, not of the page: apart from the controls after it, which end where they
            always do (the address gives up its room). */}
        <UpdateButton />
        {/* Copy to Figma, to Paper: their own Chrome extensions, started on the page (its picker
            takes the clicks, so review goes to preview). The first press downloads one. After
            the address, apart from Draw and the modes: they copy the page out, not mark it up.
            Only those switched on in Settings. */}
        <Show when={state.capture?.on.length ? state.capture : undefined}>
          {(capture) => (
            <div class="captures">
              <For each={CAPTURES.filter((c) => capture().on.includes(c.kind))}>
                {(c) => (
                  <button
                    class="icon-btn capture-btn"
                    data-action={`capture-${c.kind}`}
                    aria-label={`Copy to ${c.name}`}
                    aria-busy={capture().busy === c.kind}
                    disabled={!state.page.url || !!state.page.error || !!capture().busy}
                    onClick={() => act("capture", c.kind)}
                    {...hinted(() => ({ text: `${c.name}: pick what to copy, then paste it in ${c.name}`, keys: [] }))}
                  >
                    <Icon name={capture().busy === c.kind ? "spinner" : c.kind} size={20} />
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
        <div class="tools">
          {/* The pen alone, in a look of its own: pressed, it turns Annotate on too, and is not a
              fourth mode beside it. Its name and key are in its hint. */}
          <button
            class="icon-btn draw-btn"
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
          <ModeSwitch disabled={noOverlay()} stacked={stacked()} ref={(el) => (modes = el)} />
          {/* With the panel open the agent button is in its conversation row, and the notes are
              right there: both are here only while they cannot be seen in the panel. */}
          <Show when={!props.panelOpen || !state.site?.directory}>
            <ServerButton onClick={props.openSettings} />
          </Show>
          <Show when={!props.panelOpen}>
            <NotesStatus panelOpen={props.panelOpen} showNotes={props.showNotes} />
          </Show>
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

/** The page tried to leave the web for another scheme (an app's link, "mailto:") and was stopped
 *  (main/page.ts). Said quietly beside its address, until the next page: nothing is wrong with
 *  the page, and nothing is to be done. */
function PageRefused() {
  return (
    <Show when={!overlayError() && state.page.refused}>
      {(scheme) => (
        <div class="page-error page-refused" role="status">
          <span class="page-error-text">
            The page tried to open “{scheme()}” and was not allowed
          </span>
        </div>
      )}
    </Show>
  )
}

/** A newer release of the app: ready to restart into, or (a copy that can't replace itself) its
 *  release page. Nothing while it is still coming, or when that failed. */
function UpdateButton() {
  const shown = () => (state.update?.status === "ready" || state.update?.status === "manual" ? state.update : undefined)
  return (
    <Show when={shown()}>
      {(update) => {
        const ready = () => update().status === "ready"
        const words = () => (ready() ? "Restart to update" : `${update().version} is out`)
        const what = () => (ready() ? `Restart into Bicycle42 ${update().version}` : `Open the release page of Bicycle42 ${update().version}`)
        return (
          <button class="icon-btn labelled update-btn" data-action="update" aria-label={words()} aria-description={what()} title={what()} onClick={() => act("installUpdate")}>
            <Icon name="download" />
            <span>{words()}</span>
          </button>
        )
      }}
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

// ── strips ──────────────────────────────────────────────────────────────────────────────────────
// A command failed and nothing else owns the message. Rare, and dismissed by the reviewer.
// And the page asked to download a file: held, not saved, until the reviewer says (main/page.ts);
// and one saved, while it is still coming.

function Strips() {
  return (
    <>
      <Show when={state.page.download}>
        {(d) => (
          <div class="strip download-ask" role="alert">
            <Icon name="download" />
            <span class="strip-text" title={`${d().frame ? "A frame in " : ""}${d().site} wants to download ${d().file}${d().from ? ` from ${d().from}` : ""}`}>
              {d().frame ? "A frame in " : ""}
              <span class="download-site">{d().site}</span> wants to download <span class="download-file">{d().file}</span>
              {d().from ? " from " : ""}
              <Show when={d().from}>{(from) => <span class="download-site">{from()}</span>}</Show>
              {d().size !== undefined ? ` (${sizeOf(d().size!)})` : ""}
            </span>
            <button class="btn primary" onClick={() => act("saveDownload", d().id)}>
              Save…
            </button>
            <button class="btn" onClick={() => act("dropDownload", d().id)}>
              Don't
            </button>
          </div>
        )}
      </Show>
      <For each={state.page.saving ?? []}>
        {(s) => (
          <div class="strip download-saving" role="status">
            <Icon name="download" />
            <span class="strip-text" title={`Saving ${s.file}`}>
              Saving <span class="download-file">{s.file}</span>… <span class="download-progress">{s.size ? `${Math.min(100, Math.floor((s.received / s.size) * 100))}%` : sizeOf(s.received)}</span>
            </span>
            <button class="btn" onClick={() => act("dropDownload", s.id)}>
              Cancel
            </button>
          </div>
        )}
      </For>
      <Show when={notice()}>
        <div class="strip bad" role="alert">
          <Icon name="alert" />
          <span class="strip-text">{notice()}</span>
          <button class="icon-btn small" aria-label="Dismiss" title="Dismiss" onClick={() => setNotice("")}>
            <Icon name="close" />
          </button>
        </div>
      </Show>
    </>
  )
}

// ── window ──────────────────────────────────────────────────────────────────────────────────────

const sameRect = (a: Rect | null | undefined, b: Rect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)

export function App() {
  const [panelOpen, setPanelOpen] = createSignal(recall("panel.open") !== "0")
  const [panelWidth, setPanelWidth] = createSignal(Math.max(PANEL_MIN, Number(recall("panel.width")) || PANEL_DEFAULT))
  const [settings, setSettings] = createSignal(false)
  /** The sheet of keys ("?", Help ▸ Keyboard Shortcuts). */
  const [keysOpen, setKeysOpen] = createSignal(false)
  /** Settings, closed, is still drawn while it leaves (.dialog:not([open]) in styles.css): it is
   *  kept that long, with the page still away under it. */
  const [settingsLeaving, setSettingsLeaving] = createSignal(false)
  let settingsLeft = 0
  const openSettings = () => {
    clearTimeout(settingsLeft)
    setSettingsLeaving(false) // (one still leaving goes first: the new one opens in its place)
    setSettings(true)
  }
  const closeSettings = () => {
    // (One change: a moment of neither would take the dialog away and draw it anew, open.)
    batch(() => {
      setSettings(false)
      setSettingsLeaving(true)
    })
    const exit = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--duration-exit")) || 150
    settingsLeft = window.setTimeout(() => setSettingsLeaving(false), exit)
  }
  onCleanup(() => clearTimeout(settingsLeft))
  const [resizing, setResizing] = createSignal(false)
  /** Which edge the resize is of: the dock's top (true), else the panel's side. */
  const [dockDragging, setDockDragging] = createSignal(false)
  /** …or the left edge of the column at a phone's right. */
  const [columnDragging, setColumnDragging] = createSignal(false)
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
  let stageEl!: HTMLDivElement
  let bodyEl!: HTMLDivElement
  /** How far the phone's body is moved to sit on whole pixels (report below). */
  let shift = { x: 0, y: 0 }
  // ── a phone's page: as large as life, or as large as fits ──
  // The phone's column is as tall as the window allows; above the page it has the picker's row.
  // A phone taller than what is left is drawn smaller, whole (main draws the page at the box's
  // width over the phone's, and the page's own size stays the phone's): never cut, which would
  // be another phone than the one named.
  const [colHeight, setColHeight] = createSignal(0)
  const [winWidth, setWinWidth] = createSignal(window.innerWidth)
  // While an edge is dragged the page is away, and its box says how large the page will be:
  // a desktop's page is as large as its box, a phone's is the phone, drawn at the box's size.
  const [pageSize, setPageSize] = createSignal({ width: 0, height: 0 })
  const sizeSaid = () => {
    if (!phone()) return `${pageSize().width} × ${pageSize().height}`
    const p = phoneOf(state.page.phone)
    return `${p.width} × ${p.height}${drawn().scale < 1 ? ` · ${Math.round(drawn().scale * 100)}%` : ""}`
  }
  const fit = () => {
    const room = colHeight() - PHONE_AROUND
    const h = phoneOf(state.page.phone).height
    return room <= 0 || room >= h ? 1 : Math.max(PHONE_FIT_MIN, room / h)
  }
  /** The phone as it is drawn: its body (the whole screen), its strips and the page's box between
   *  them (phone.ts). (By the width as it was rounded: main draws by the box's width over the phone's.) */
  const drawn = () => frameOf(phoneOf(state.page.phone), fit())
  // A dock the window draws: under the page at this height, or beside a phone's page.
  // Until it is dragged: DOCK_DEFAULT, or in a window so short that it is less, what the page
  // leaves over PAGE_SHORT, and never less than half the stage (Motion's timeline needs the
  // height). From the stage as it is now, not as it was when the window opened.
  const [dockChosen, setDockHeight] = createSignal<number | undefined>(Number(recall("dock.height")) || undefined)
  const dockHeight = () =>
    Math.max(DOCK_MIN, dockChosen() ?? (colHeight() > 0 ? Math.min(DOCK_DEFAULT, Math.round(Math.max((colHeight() - 16) * 0.5, colHeight() - 16 - PAGE_SHORT))) : DOCK_DEFAULT))
  // (With no page open the box holds the window's own words, at its whole width.)
  const phone = () => state.page.device === "phone" && state.page.url !== ""
  // The column at a phone's right: until its edge is dragged, the room the phone's column leaves
  // (styles.css); dragged, that width, in every mode, kept across launches. The stage's width and
  // the column's as drawn, for its limits and for its edge to say.
  const [columnChosen, setColumnWidth] = createSignal<number | undefined>(Number(recall("dock.width")) || undefined)
  const [stageWidth, setStageWidth] = createSignal(0)
  const [columnSeen, setColumnSeen] = createSignal(0)
  let urlEl: HTMLInputElement | undefined
  let composerEl: HTMLTextAreaElement | undefined

  // The first-run screen: no agent yet, or the form on that screen is waiting for main.
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
  /** Not the page but its design system, where the page was (ds-space.tsx). */
  const ds = () => state.page.device === "ds" && state.page.url !== "" && !loadFailed()
  const pageHidden = () => ds() || setup() || settings() || settingsLeaving() || keysOpen() || !!switcherOpen() || resizing() || state.page.url === "" || loadFailed() || pageCovered()
  /** The page is away for a moment: a dialog over the window, or an edge being dragged. */
  const veiled = () => settings() || settingsLeaving() || keysOpen() || !!switcherOpen() || resizing()

  // ── the page's still: while it is away for a moment, a picture of it as it was holds its
  // place, so the window does not blank, a dialog's backdrop fades over the page, and a dragged
  // edge crops it. The view stays until the picture is drawn under it (STILL_WAIT at most), and
  // the picture until the view is back over it. ──
  const STILL_WAIT = 150
  const STILL_KEEP = 250
  const [still, setStill] = createSignal<{ url: string; width: number; height: number } | null>(null)
  /** "asking": the view waits for its picture; "drawn": it may go. */
  let stillFor: "asking" | "drawn" | undefined
  let stillAsk = 0
  let stillTimer = 0
  const dropStill = () => setStill(null)
  /** Until the view has gone, a dialog that opened waits unseen at its start (.page-holding in
   *  styles.css), so it comes in whole over the window, not partly under the page. */
  const holding = (on: boolean) => document.documentElement.classList.toggle("page-holding", on)
  const askStill = () => {
    const ask = ++stillAsk
    stillFor = "asking"
    holding(true)
    clearTimeout(stillTimer)
    const go = () => {
      if (ask !== stillAsk || stillFor !== "asking") return
      clearTimeout(stillTimer)
      stillFor = "drawn"
      report()
      holding(false)
    }
    stillTimer = window.setTimeout(go, STILL_WAIT)
    b42
      .invoke("pageStill")
      .then(async (s) => {
        if (!s || ask !== stillAsk) return
        const img = new Image()
        img.src = s.url
        await img.decode()
        if (ask !== stillAsk) return
        setStill(s)
        // Drawn in the window before the view goes: the next frame, and the one after it.
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      })
      .catch(() => undefined)
      .finally(go)
  }
  /** The moment is over: no picture is waited for any more, and the one drawn is let go once the
   *  view surely covers it again. */
  const stillBack = () => {
    stillAsk++
    stillFor = undefined
    holding(false)
    clearTimeout(stillTimer)
    if (still()) stillTimer = window.setTimeout(dropStill, STILL_KEEP)
  }
  onCleanup(() => {
    clearTimeout(stillTimer)
    holding(false)
    dropStill()
  })

  // ── page bounds: one call per frame at most, none when nothing moved ──
  let sent: Rect | null | undefined
  let frame = 0
  const report = () => {
    frame = 0
    let next: Rect | null = null
    // A phone's body on whole pixels: centred in its column it can fall on half a one, and the
    // page view, which main places on whole ones, would then meet the strips half a pixel off.
    const b = phone() ? bodyEl.getBoundingClientRect() : undefined
    const to = b ? { x: Math.round(b.x - shift.x) - (b.x - shift.x), y: Math.round(b.y - shift.y) - (b.y - shift.y) } : { x: 0, y: 0 }
    if (Math.abs(to.x - shift.x) > 0.001 || Math.abs(to.y - shift.y) > 0.001) {
      shift = to
      // (An offset of the layout's own, not a transform: a body moved by a fraction of a pixel
      // with `translate` had its rounded clip snapped before the move, a pixel short at one side.)
      bodyEl.style.left = to.x ? `${to.x}px` : ""
      bodyEl.style.top = to.y ? `${to.y}px` : ""
    }
    if (!pageHidden()) {
      if (stillFor) stillBack()
      // Inside the pane's border, so the border stays visible around the page view.
      const r = pageEl.getBoundingClientRect()
      const x = Math.round(r.x + pageEl.clientLeft)
      const y = Math.round(r.y + pageEl.clientTop)
      if (pageEl.clientWidth >= 1 && pageEl.clientHeight >= 1) next = { x, y, width: pageEl.clientWidth, height: pageEl.clientHeight }
    } else if (sent && veiled() && stillFor !== "drawn") {
      // On screen and going away for a moment: its picture first, then it goes (askStill).
      if (!stillFor) askStill()
      return
    } else if (!veiled() && stillFor) {
      // Away for good (the page failed, the window went back to a setup step): no picture of it.
      stillBack()
      clearTimeout(stillTimer)
      dropStill()
    }
    if (sameRect(sent, next)) return
    sent = next
    act("setPageBounds", next)
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(report)
  }
  onMount(() => {
    // As a desktop's the box only moves when it also changes size (a strip appears, the panel
    // resizes, the window resizes). As a phone's it keeps its size and moves with the room it is
    // centred in: that room is observed too.
    const observer = new ResizeObserver(() => {
      setColHeight(stageEl.clientHeight)
      setStageWidth(stageEl.clientWidth)
      const column = stageEl.querySelector(":scope > .dock")
      if (column) setColumnSeen(Math.round(column.getBoundingClientRect().width))
      setPageSize({ width: pageEl.clientWidth, height: pageEl.clientHeight })
      schedule()
    })
    observer.observe(pageEl)
    observer.observe(stageEl)
    // (A phone's column: the column at its right, dragged, moves the phone and resizes neither
    // the page nor the stage.)
    observer.observe(stageEl.querySelector(":scope > .device-col")!)
    const resized = () => {
      setWinWidth(window.innerWidth)
      // The stage's new height now, not when the observer says it: the window's size event
      // comes before the frame's report and the observer after it, so the report measured a
      // phone's box where it now sits at the size it had, and the next frame's the size it has.
      // Two boxes a change of height, each a move of the page view in main.
      setColHeight(stageEl.clientHeight)
      schedule()
    }
    window.addEventListener("resize", resized)
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", resized)
      cancelAnimationFrame(frame)
    })
  })
  createEffect(() => {
    // Hiding must not wait a frame: whatever needs the space is already on screen.
    if (pageHidden()) report()
    else schedule()
  })
  createEffect(() => {
    // A dock that comes or goes beside a phone's page moves the page and resizes nothing.
    dockShown()
    phone()
    schedule()
  })
  // What the window draws around a phone's screen, which the page's overlay paints in the
  // screen's bottom corners (the page view covers the window there): said to main once the
  // phone is drawn, and again when the theme changes (main.tsx's class is on by then).
  const [theme, setTheme] = createSignal(0)
  onMount(() => {
    const dark = matchMedia("(prefers-color-scheme: dark)")
    const changed = () => setTheme((n) => n + 1)
    dark.addEventListener("change", changed)
    onCleanup(() => dark.removeEventListener("change", changed))
  })
  let surroundSaid = ""
  createEffect(() => {
    theme()
    if (!phone()) return
    requestAnimationFrame(() => {
      const around = phone() ? surroundOf(bodyEl) : undefined
      if (!around || JSON.stringify(around) === surroundSaid) return
      surroundSaid = JSON.stringify(around)
      act("setPhoneSurround", around)
    })
  })

  // ── panel ──
  const togglePanel = () => {
    setPanelOpen(!panelOpen())
    remember("panel.open", panelOpen() ? "1" : "0")
  }
  const openPanel = () => panelOpen() || togglePanel()
  // A window too narrow for the panel, a phone's page and the column at its right all at once
  // shows two of them: with a dock (Edit, Motion) the page and the dock, which the mode cannot
  // do without; else the panel and the page, and what the column says of the page waits.
  const crowded = () => phone() && winWidth() < PANEL_MIN + drawn().width + PHONE_SIDES + COLUMN_MIN + 8
  const panelShown = () => panelOpen() && !(crowded() && !!dockShown())
  // (The docks send from the panel's message box while it is on screen: store.ts, composerUp.)
  createEffect(() => setPanelUp(panelShown() && !setup()))
  const asideShown = () => phone() && !(crowded() && panelOpen())
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
  // Half the window at most; beside a phone's page, no more than leaves the column at the
  // page's right the 300px a dock needs (COLUMN_MIN), with the page's own column and the gaps.
  const maxWidth = () => {
    const half = Math.floor(winWidth() / 2)
    const room = phone() ? winWidth() - (drawn().width + PHONE_SIDES) - COLUMN_MIN - 8 : half
    return Math.max(PANEL_MIN, Math.min(half, room))
  }
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
    // (The panel is at the left: its edge is dragged right to widen it.)
    setPanelWidth(clampWidth(dragFrom.width + e.clientX - dragFrom.x))
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

  // ── the dock under the page: its height, dragged by its top edge as the panel is by its side ──
  // (The 16 are the page's and the dock's own margins: PAGE_MIN is the page, not its share of the stage.)
  const dockMax = () => Math.max(DOCK_MIN, stageEl.clientHeight - PAGE_MIN - 16)
  const clampDock = (h: number) => Math.min(dockMax(), Math.max(DOCK_MIN, Math.round(h)))
  let dockFrom: { y: number; height: number } | undefined
  const dockDragStart = (e: PointerEvent) => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dockFrom = { y: e.clientY, height: clampDock(dockHeight()) }
  }
  const dockDragMove = (e: PointerEvent) => {
    if (!dockFrom) return
    setResizing(true)
    setDockDragging(true)
    setDockHeight(clampDock(dockFrom.height + dockFrom.y - e.clientY))
  }
  const dockDragEnd = () => {
    if (!dockFrom) return
    dockFrom = undefined
    setResizing(false)
    setDockDragging(false)
    remember("dock.height", String(dockHeight()))
  }
  const dockNudge = (by: number) => {
    setDockHeight(clampDock(clampDock(dockHeight()) + by))
    remember("dock.height", String(dockHeight()))
  }
  /** Back to what it is until dragged (a double click on its edge, as on the notes' divider). */
  const dockReset = () => {
    setDockHeight(undefined)
    remember("dock.height", "")
  }

  // ── the column at a phone's right: its width, dragged by its left edge ──
  // At least COLUMN_MIN, at most what leaves the phone its column (the phone's body as it is drawn
  // with its ring and air: PHONE_SIDES, `.stage.phone > .device-col`'s min-width) and the dock's
  // own 8px at the window's edge. Wider than that the phone would be cut: it is drawn smaller
  // only for the window's height (fit).
  const columnMax = () => Math.max(COLUMN_MIN, stageWidth() - (drawn().width + PHONE_SIDES) - 8)
  const clampColumn = (w: number) => Math.min(columnMax(), Math.max(COLUMN_MIN, Math.round(w)))
  const columnWidth = () => {
    const chosen = columnChosen()
    return chosen === undefined ? undefined : clampColumn(chosen)
  }
  const columnNow = () => columnWidth() ?? columnSeen()
  const columnShown = () => phone() && (!!dockShown() || asideShown())
  let columnFrom: { x: number; width: number } | undefined
  const columnDragStart = (e: PointerEvent) => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    columnFrom = { x: e.clientX, width: clampColumn(columnNow()) }
  }
  const columnDragMove = (e: PointerEvent) => {
    if (!columnFrom) return
    setResizing(true)
    setColumnDragging(true)
    // (The column is at the right: its edge is dragged left to widen it.)
    setColumnWidth(clampColumn(columnFrom.width + columnFrom.x - e.clientX))
  }
  const columnDragEnd = () => {
    if (!columnFrom) return
    columnFrom = undefined
    setResizing(false)
    setColumnDragging(false)
    remember("dock.width", String(columnWidth()))
  }
  const columnNudge = (by: number) => {
    setColumnWidth(clampColumn(clampColumn(columnNow()) + by))
    remember("dock.width", String(columnWidth()))
  }
  /** Back to the room that is left (a double click on its edge, as on the others). */
  const columnReset = () => {
    setColumnWidth(undefined)
    remember("dock.width", "")
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
  /** mod+shift+C: the page's whole address on the clipboard, said for a moment where hints are. */
  const copyUrl = async () => {
    if (state.page.url && (await copyText(state.page.url))) flashHint("Copied the page's address")
  }
  // The app zoomed (mod+= / mod+- / mod+0, from anywhere): how far, for a moment where hints are.
  createEffect(on(() => state.zoom ?? 1, (z) => flashHint(`Zoom ${Math.round(z * 100)}%`), { defer: true }))
  const onShortcut = (s: Shortcut) => {
    if (s === "url-copied") return flashHint("Copied the page's address")
    if (setup() || settings()) return
    // (From the app's menu: Stop as the message box's button has it, and the sheet of keys.)
    if (s === "stop") return act("stop")
    if (s === "show-keys") return void setKeysOpen(true)
    if (s === "focus-url") focusUrl()
    else if (s === "toggle-panel") togglePanel()
    else focusChat()
  }
  const onKey = (e: KeyboardEvent) => {
    if (setup() || settings()) return
    const key = e.key.toLowerCase()
    // The page is reloaded from the window too (the chat box, the inspector): the keyboard is
    // here more often than in the page, which has the same two keys (main/page.ts).
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    if (key === "f5" && plain) {
      e.preventDefault()
      act("reload")
      return
    }
    // "?" outside a field: the sheet of keys. (In a field it is a question mark.)
    if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target) && !keysOpen()) {
      e.preventDefault()
      setKeysOpen(true)
      return
    }
    if (!(mac() ? e.metaKey : e.ctrlKey) || e.altKey) return
    const mode = e.shiftKey ? undefined : MODE_KEYS[e.code]
    // The same keys as while the page has the keyboard: mod+U again goes back to the mode it left.
    if (e.shiftKey) {
      if (e.code === "KeyP") act("toggleBrush")
      else if (e.code === "KeyC") void copyUrl()
      else return
    } else if (mode === "preview") act("toggleReview")
    else if (mode) act("setMode", mode)
    else if (key === "r") act("reload")
    else if (key === "l") focusUrl()
    else if (key === "\\" || e.code === "KeyJ") togglePanel()
    else if (key === "k") focusChat()
    else return
    e.preventDefault()
  }
  // An edge's pill is where the pointer is on it (styles.css, .resizer and .divider: --at). One
  // listener for all of them, the dock's own handles too; with the pointer captured (a drag) the
  // moves still come to the edge. On the way down (capture), so before the edge's own handler:
  // this one measures the edge and then writes, and measuring after a handler that has just
  // written a size is a layout of the window in the middle of the event.
  const pillFollows = (e: PointerEvent) => {
    const edge = e.target instanceof Element ? e.target.closest<HTMLElement>(".resizer, .divider, .cd-grip") : null
    if (!edge) return
    const r = edge.getBoundingClientRect()
    edge.style.setProperty("--at", r.height > r.width ? `${Math.round(e.clientY - r.top)}px` : `${Math.round(e.clientX - r.left)}px`)
  }
  onMount(() => {
    document.addEventListener("pointermove", pillFollows, true)
    onCleanup(() => document.removeEventListener("pointermove", pillFollows, true))
  })
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
    // The lengths the window's boxes are sized by are each set on the box that reads it, or on
    // the nearest one around those that do (styles.css has who reads what): a variable set up
    // here, on .app, was every element's to inherit, and an edge dragged restyled the whole
    // window on every move of the pointer.
    <div class="app">
      <TopBar
        bare={!ready() || setup()}
        urlRef={(el) => (urlEl = el)}
        panelOpen={panelShown()}
        panelCrowded={panelOpen() && !panelShown()}
        togglePanel={togglePanel}
        showNotes={showNotes}
        openSettings={openSettings}
      />
      <Show when={ready() && !setup()}>
        <Strips />
      </Show>
      <main class="work" inert={!ready() || setup()}>
        {/* Hidden, not unmounted: the conversation keeps its scroll position and rendered text. */}
        <aside
          class="panel"
          ref={panelEl}
          hidden={!panelShown()}
          style={{ "--panel-width": `${panelWidth()}px`, "--panel-max": `${maxWidth()}px` }}
        >
          <Panel composerRef={(el) => (composerEl = el)} openSettings={openSettings} size={panelSize()} />
        </aside>
        <Show when={panelShown()}>
          <div
            class="resizer"
            classList={{ active: resizing() && !dockDragging() && !columnDragging() }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the panel"
            aria-valuemin={PANEL_MIN}
            aria-valuemax={maxWidth()}
            aria-valuenow={clampWidth(panelWidth())}
            tabindex="0"
            onPointerDown={dragStart}
            onPointerMove={dragMove}
            onPointerUp={dragEnd}
            onPointerCancel={dragEnd}
            onLostPointerCapture={dragEnd}
            onDblClick={() => nudge(PANEL_DEFAULT - clampWidth(panelWidth()))}
            onKeyDown={(e) => {
              // (As the notes' divider and the dock's: arrows step, Home and End go to the limits.)
              if (e.key === "ArrowRight") nudge(16)
              else if (e.key === "ArrowLeft") nudge(-16)
              else if (e.key === "Home") nudge(PANEL_MIN - clampWidth(panelWidth()))
              else if (e.key === "End") nudge(maxWidth() - clampWidth(panelWidth()))
              else return
              e.preventDefault()
            }}
          />
        </Show>
        {/* The page and, when the window draws the dock of the mode that is on, that dock: under
            the page. A phone's page has a column beside it in every mode (the dock, or the page's facts),
            so it stays where it is when the mode changes. */}
        <div
          class="stage"
          ref={stageEl}
          classList={{ phone: phone(), "ds-on": ds(), sized: columnWidth() !== undefined }}
          style={{ "--dock-height": `${dockHeight()}px`, "--dock-width": columnWidth() === undefined ? undefined : `${columnWidth()}px` }}
        >
        <Show when={ds()}>
          <DsSpace />
        </Show>
        {/* A phone's page has a column of its own: in the middle of it, with air around, and
            which phone it is above it. (A desktop's page is the stage's own child: the wrapper
            makes no box then.) */}
        <div
          class="device-col"
          style={{
            "--phone-width": `${drawn().width}px`,
            "--phone-height": `${drawn().height}px`,
            // (The screen's own corners at the size it is drawn, and the page's box between the strips.)
            "--phone-radius": `${drawn().radius}px`,
            "--phone-screen": `${drawn().screen}px`,
          }}
        >
        <Show when={phone()}>
          <div class="device-bar">
            <PhonePick fit={drawn().scale} />
          </div>
        </Show>
        {/* A phone's body: the status strip and the page's box, down to its bottom edge, with the
            ring around it (phone-frame.tsx). A desktop's page has none: the wrapper makes no box. */}
        <div class="device-body" ref={bodyEl}>
        <Show when={phone()}>
          <StatusStrip phone={phoneOf(state.page.phone)} height={drawn().top} scale={drawn().scale} tint={state.page.tint} />
        </Show>
        {/* While a dialog is open or an edge is dragged the page view is away: its picture as it was
            stands in for it (the still, above), on a quiet surface, so the window does not go
            blank. */}
        <div
          class="page"
          ref={pageEl}
          classList={{ veiled: veiled() }}
        >
          <Show when={still()}>
            {(s) => <img class="page-still" src={s().url} alt="" aria-hidden="true" style={{ width: `${s().width}px`, height: `${s().height}px` }} />}
          </Show>
          <Show when={resizing() && state.page.url !== "" && !loadFailed()}>
            <p class="page-size" aria-hidden="true">
              {sizeSaid()}
            </p>
          </Show>
          <Show when={state.page.url !== "" && loadFailed()}>
            <div class="page-failed" role="alert">
              <Icon name="alert" size={20} />
              {/* The host whole, on as many lines as it takes: it is what the card is there to
                  name. A long one breaks after its dots, else anywhere. */}
              <p class="chat-empty-lead" title={state.page.url}>
                Can't load <For each={host(state.page.url).split(/(?<=\.)/)}>{(part, i) => (i() ? [<wbr />, part] : part)}</For>
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
          <Show when={state.page.url === "" && state.page.elsewhere}>
            {(at) => (
              <div class="page-failed page-elsewhere" role="alert">
                <Icon name="alert" size={20} />
                <p class="chat-empty-lead">
                  The agent says the site is at <span class="page-elsewhere-url">{at().url}</span>, which is not on{" "}
                  {at().computer}. Open it here?
                </p>
                <p class="page-failed-why">
                  It would load from this computer, not from {at().computer}: from your network, or the web.
                </p>
                <div class="page-actions">
                  <button class="btn primary" onClick={() => act("navigate", at().url)}>
                    Open it here
                  </button>
                </div>
              </div>
            )}
          </Show>
          <Show when={state.page.url === "" && !state.page.elsewhere}>
            <div class="page-empty">
              <SetupSteps at={3} />
              <p class="chat-empty-lead">Open your site.</p>
              <p>Type its address above, or let the agent start it.</p>
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
        </div>
        </div>
        {/* The column at a phone's right, in every mode: its left edge, as the panel's right one. */}
        <Show when={columnShown()}>
          <div
            class="resizer column-resizer"
            classList={{ active: columnDragging() }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the column"
            aria-valuemin={COLUMN_MIN}
            aria-valuemax={columnMax()}
            aria-valuenow={columnNow()}
            tabindex="0"
            onPointerDown={columnDragStart}
            onPointerMove={columnDragMove}
            onPointerUp={columnDragEnd}
            onPointerCancel={columnDragEnd}
            onLostPointerCapture={columnDragEnd}
            onDblClick={columnReset}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") columnNudge(16)
              else if (e.key === "ArrowRight") columnNudge(-16)
              else if (e.key === "Home") columnNudge(COLUMN_MIN - clampColumn(columnNow()))
              else if (e.key === "End") columnNudge(columnMax() - clampColumn(columnNow()))
              else return
              e.preventDefault()
            }}
          />
        </Show>
        <Show when={!ds() && dockShown()} fallback={<Show when={asideShown()}><PhoneAside /></Show>}>
          {(dock) => (
            <>
              <Show when={!phone()}>
                <div
                  class="divider dock-divider"
                  classList={{ active: dockDragging() }}
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize the dock"
                  aria-valuemin={DOCK_MIN}
                  aria-valuemax={Math.max(DOCK_MIN, colHeight() - PAGE_MIN - 16)}
                  aria-valuenow={Math.min(dockHeight(), Math.max(DOCK_MIN, colHeight() - PAGE_MIN - 16))}
                  tabindex="0"
                  onPointerDown={dockDragStart}
                  onPointerMove={dockDragMove}
                  onPointerUp={dockDragEnd}
                  onPointerCancel={dockDragEnd}
                  onLostPointerCapture={dockDragEnd}
                  onDblClick={dockReset}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp") dockNudge(16)
                    else if (e.key === "ArrowDown") dockNudge(-16)
                    else if (e.key === "Home") dockNudge(DOCK_MIN - clampDock(dockHeight()))
                    else if (e.key === "End") dockNudge(dockMax() - clampDock(dockHeight()))
                    else return
                    e.preventDefault()
                  }}
                />
              </Show>
              <DockRegion dock={dock()} />
            </>
          )}
        </Show>
        </div>
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
      <Show when={keysOpen()}>
        <KeysSheet onClose={() => setKeysOpen(false)} />
      </Show>
      <Show when={settings() || settingsLeaving()}>
        <SettingsDialog onClose={closeSettings} />
      </Show>
      <Show when={switcherOpen() && !setup()}>
        <Switcher projectsOnly={switcherOpen() === "projects"} onClose={() => setSwitcherOpen(false)} />
      </Show>
    </div>
  )
}

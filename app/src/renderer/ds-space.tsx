// The page's design system, where the page was: Desktop | Phone | Design system in the top bar
// (Device "ds" in shared/types.ts). The variables the page's stylesheets declare, drawn as what
// they are: a family of colours as a ramp, a size as a bar of that length, a shadow as a shadow.
// One is chosen at a time: beside the list it says where it is declared and how much it is used,
// and its value is changed there, a colour with a picker that works in OKLCH (colour.ts).
//
// The variables are the overlay's (overlay/src/tokens/host.js; TokensView in
// overlay/protocol-tokens.ts), read while this view is up ("view" until "stop"). A value set here
// is the page's at once and nowhere else: "Send to agent" says the changes to the agent in words,
// as a message, and the agent writes them into the code. Like a dock it keeps nothing of the
// page's: what is drawn is what the overlay last said, as text.
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js"
import type { LooseValue, Token, TokenKind, TokensAct } from "../../../overlay/protocol-tokens"
import type { PromptFile } from "../shared/types"
import { NOTATIONS, contrast, fromOklch, toOklab, inSrgb, intoSrgb, maxChroma, notationOf, toOklch, write, type Notation, type Oklch, type Rgb } from "./colour"
import { Icon } from "./icons"
import { b42, composerUp, dockAct, dockViews, message, offerPending, state, type PendingItem } from "./store"
import "./ds-space.css"

const send = (act: TokensAct) => dockAct({ panel: "tokens", act })

// ── a colour, read as the window's own engine reads it ──────────────────────────────────────────
let ctx: CanvasRenderingContext2D | null | undefined
const parsed = new Map<string, Rgb | null>()
/** Any CSS colour as sRGB (what a canvas paints for it), or null for what is none. */
function rgbOf(css: string): Rgb | null {
  let c = parsed.get(css)
  if (c !== undefined) return c
  c = null
  if (ctx === undefined) ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (ctx && CSS.supports("color", css)) {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    c = { r: d[0]! / 255, g: d[1]! / 255, b: d[2]! / 255, a: d[3]! / 255 }
  }
  if (parsed.size > 4000) parsed.clear()
  parsed.set(css, c)
  return c
}
/** The colour a token is, as CSS the window can draw. */
const cssOf = (t: Token) => t.css ?? t.value
/** Black or white ink, whichever reads on the colour (over the window's paper, when it is see-through). */
function inkOn(css: string): string {
  const c = rgbOf(css)
  if (!c || c.a < 0.5) return "var(--foreground)"
  return contrast(c, { r: 0, g: 0, b: 0, a: 1 }) >= contrast(c, { r: 1, g: 1, b: 1, a: 1 }) ? "#000" : "#fff"
}

// ── families: --sand-0 … --sand-400 are one ramp ────────────────────────────────────────────────
const STEP = /^(.*?)[-_]?(\d+(?:[._]\d+)?)$/
type Family = { base: string; tokens: Token[] }
/** Names that differ only in a number at the end, three or more: a family, in the numbers'
 *  order. The rest, by name. */
function families(list: Token[]): { ramps: Family[]; rest: Token[] } {
  const by = new Map<string, Array<{ t: Token; n: number }>>()
  for (const t of list) {
    const m = STEP.exec(t.name)
    if (!m || !m[1] || m[1] === "-" || m[1] === "--") continue
    const at = by.get(m[1]) ?? []
    at.push({ t, n: Number(m[2]!.replace("_", ".")) })
    by.set(m[1], at)
  }
  const ramps: Family[] = []
  const inRamp = new Set<Token>()
  for (const [base, all] of by) {
    if (all.length < 3) continue
    all.sort((a, b) => a.n - b.n)
    ramps.push({ base, tokens: all.map((x) => x.t) })
    for (const x of all) inRamp.add(x.t)
  }
  return { ramps, rest: list.filter((t) => !inRamp.has(t)) }
}
/** A token's step in its family: "400" of --sand-400. */
const stepOf = (t: Token, base: string) => t.name.slice(base.length).replace(/^[-_]/, "")

const KINDS: Array<{ kind: TokenKind; title: string }> = [
  { kind: "colour", title: "Colours" },
  { kind: "size", title: "Sizes" },
  { kind: "font", title: "Type" },
  { kind: "shadow", title: "Shadows" },
  { kind: "time", title: "Durations" },
  { kind: "ease", title: "Easings" },
  { kind: "number", title: "Numbers" },
  { kind: "other", title: "Other" },
]

// ── suggestions ─────────────────────────────────────────────────────────────────────────────────
// What the page could do with its variables, worked out from what was read and nothing else (no
// model): a value written out where a variable says it, a value written out often with no
// variable, two variables that are one colour or nearly, variables nothing uses. Each is a line
// for the agent, sent with the rest when it is picked.
type Suggestion = {
  id: string
  /** Colours to draw before the words. */
  swatches: string[]
  title: string
  /** In a few words, for its chip in the send box. */
  short: string
  detail: string
  /** The line the agent gets. */
  say: string
  /** Variables it names: a click on one chooses it. */
  names: string[]
}
const WORDS = { colour: "colour", space: "spacing", radius: "radius", text: "text size" } as const
const code = (s: string) => `\`${s}\``
const rules = (n: number) => `${n} ${n === 1 ? "rule" : "rules"}`
/** `var(--other)` and nothing else: the variable is another one's name for the same value. */
const aliasOf = (t: Token) => t.where.length > 0 && t.where.every((w) => /^var\(\s*--[\w-]+\s*\)$/.test(w.value))
const familyOf = (t: Token) => STEP.exec(t.name)?.[1] ?? t.name

function suggest(tokens: readonly Token[], loose: readonly LooseValue[]): Suggestion[] {
  const out: Suggestion[] = []
  for (const read of loose) {
    // (The engine says a rule's `#111827` as rgb(17, 24, 39): said here as the hex it most likely was.)
    const c = read.kind === "colour" && /^rgba?\(/.test(read.value) ? rgbOf(read.value) : null
    const l = c ? { ...read, value: write("hex", toOklch(c), c.a) } : read
    const eg = l.where.length ? `e.g. ${l.where.map(code).join(", ")}` : ""
    const swatches = l.kind === "colour" ? [l.value] : []
    if (l.tokens.length)
      out.push({
        id: `use ${l.kind} ${l.value}`,
        short: `${l.value} → ${l.tokens[0]}`,
        swatches,
        title: `${l.value} is written out in ${rules(l.rules)}; ${l.tokens[0]} says it`,
        detail: l.where.join(" · "),
        say: `${rules(l.rules)} write the ${WORDS[l.kind]} ${code(l.value)} literally (${eg}): use ${code(`var(${l.tokens[0]})`)} there${l.tokens.length > 1 ? ` (or ${l.tokens.slice(1).map(code).join(", ")}, whichever fits what it is for)` : ""}.`,
        names: l.tokens,
      })
    else
      out.push({
        id: `add ${l.kind} ${l.value}`,
        short: `${l.value}: ${l.kind === "colour" ? "a new variable" : "onto the scale"}`,
        swatches,
        title: `${l.value} is written out in ${rules(l.rules)}, and no variable says it`,
        detail: l.where.join(" · "),
        say: `${rules(l.rules)} write the ${WORDS[l.kind]} ${code(l.value)} literally (${eg}) and no variable has that value: ${l.kind === "colour" ? "add a variable for it, named as the others are, and use it there" : "put it on the scale (a new step, or the nearest one if the difference is not meant) and use the variable there"}.`,
        names: [],
      })
  }
  // Two variables, one colour (neither another's name for it), or nearly one: not two steps of a ramp.
  const colours = tokens.filter((t) => t.kind === "colour" && !t.local && t.set === undefined && !aliasOf(t)).slice(0, 400)
  const labs = colours.map((t) => {
    const c = rgbOf(cssOf(t))
    return c ? { ...toOklab(c), alpha: c.a } : null
  })
  let near = 0
  for (let i = 0; i < colours.length; i++)
    for (let j = i + 1; j < colours.length; j++) {
      const a = labs[i], b = labs[j]
      if (!a || !b || Math.abs(a.alpha - b.alpha) > 0.01) continue
      const d = Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b)
      const x = colours[i]!, y = colours[j]!
      if (d < 0.0015)
        out.push({
          id: `same ${x.name} ${y.name}`,
          short: `${x.name} = ${y.name}`,
          swatches: [cssOf(x)],
          title: `${x.name} and ${y.name} are the same colour`,
          detail: x.value,
          say: `${code(x.name)} and ${code(y.name)} are the same colour (${code(x.value)}): keep one, or make one refer to the other with var().`,
          names: [x.name, y.name],
        })
      else if (d < 0.02 && familyOf(x) !== familyOf(y) && near++ < 12)
        out.push({
          id: `near ${x.name} ${y.name}`,
          short: `${x.name} ≈ ${y.name}`,
          swatches: [cssOf(x), cssOf(y)],
          title: `${x.name} and ${y.name} are almost the same colour`,
          detail: `${x.value} · ${y.value}`,
          say: `${code(x.name)} (${code(x.value)}) and ${code(y.name)} (${code(y.value)}) are almost the same colour: make them one if the difference is not meant.`,
          names: [x.name, y.name],
        })
    }
  const unused = tokens.filter((t) => !t.uses && !t.local && t.where.length > 0)
  if (unused.length)
    out.push({
      id: "unused",
      short: `${unused.length} unused`,
      swatches: [],
      title: `No rule uses ${unused.length === 1 ? unused[0]!.name : `${unused.length} variables`}`,
      detail: unused.map((t) => t.name).join(" · "),
      say: `No rule on the page uses ${unused.slice(0, 40).map((t) => code(t.name)).join(", ")}${unused.length > 40 ? ` and ${unused.length - 40} more` : ""}: remove ${unused.length === 1 ? "it" : "those"} that nothing else (a script, another page) uses either.`,
      names: unused.slice(0, 40).map((t) => t.name),
    })
  return out
}

// ── the picker ──────────────────────────────────────────────────────────────────────────────────
/** A colour's picker: its notation, the colour large (and what it was), three sliders in OKLCH
 *  and the alpha, and the value as text. `bare`: the variable holds a colour's numbers only
 *  (`0 0% 100%`), and is written that way. */
function Picker(props: { token: Token; onSet: (value: string) => void }) {
  const bare = () => (props.token.css ? (props.token.css.startsWith("hsl") ? "hsl" : "rgb") : undefined)
  const [o, setO] = createSignal<Oklch>({ l: 0.5, c: 0, h: 0 })
  const [alpha, setAlpha] = createSignal(1)
  const [notation, setNotation] = createSignal<Notation>("hex")
  /** What this picker last wrote: the value coming back as that is no reason to read it again
   *  (a grey would lose its hue, and every round trip would move the sliders a hair). */
  let wrote = ""
  const read = (t: Token) => {
    const c = rgbOf(cssOf(t))
    if (!c) return
    const next = toOklch(c)
    // (A grey keeps the hue the sliders had.)
    setO(next.c === 0 ? { ...next, h: untrack(o).h } : next)
    setAlpha(c.a)
    setNotation(bare() ?? notationOf(t.set ?? t.where[0]?.value ?? t.value))
  }
  createEffect(
    on(
      () => [props.token.name, props.token.set ?? props.token.value] as const,
      ([, value]) => {
        if (value === wrote) return
        wrote = ""
        read(props.token)
      },
    ),
  )
  const said = () => {
    const text = write(notation(), o(), alpha())
    const b = bare()
    return b ? text.slice(b.length + 1, -1) : text
  }
  const emit = () => {
    wrote = said()
    props.onSet(wrote)
  }
  const change = (part: Partial<Oklch>) => {
    setO({ ...o(), ...part })
    emit()
  }
  const now = () => write("oklch", o(), alpha())
  const shown = () => intoSrgb(o(), alpha())
  const out = () => !inSrgb(fromOklch(o()))
  const stops = (f: (x: number) => string, steps = 8) => Array.from({ length: steps + 1 }, (_, i) => f(i / steps)).join(", ")
  const track = {
    l: () => `linear-gradient(to right, ${stops((x) => write("hex", { ...o(), l: x }))})`,
    c: () => `linear-gradient(to right, ${stops((x) => write("hex", { ...o(), c: x * 0.37 }))})`,
    h: () => `linear-gradient(to right, ${stops((x) => write("hex", { ...o(), c: Math.max(o().c, 0.08), h: x * 360 }), 24)})`,
    a: () => `linear-gradient(to right, transparent, ${write("hex", o())})`,
  }
  const was = () => (props.token.set !== undefined && props.token.was ? (props.token.css ? `${bare()}(${props.token.was})` : props.token.was) : undefined)
  return (
    <div class="ds-picker">
      <Show when={!bare()}>
        <div class="ds-notations" role="radiogroup" aria-label="Written as">
          <For each={NOTATIONS}>
            {(nt) => (
              <button
                type="button"
                class="ds-chip"
                role="radio"
                aria-checked={notation() === nt}
                onClick={() => {
                  setNotation(nt)
                  emit()
                }}
              >
                {nt}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="ds-big">
        <Show when={was()}>
          {(w) => (
            <button type="button" class="ds-big-half ds-big-was" style={{ background: w(), color: inkOn(w()) }} title="Put it back" onClick={() => props.onSet("")}>
              <span class="ds-big-label">was</span>
              <span class="ds-big-value">{props.token.was}</span>
            </button>
          )}
        </Show>
        <div class="ds-big-half" style={{ background: now(), color: inkOn(write("hex", o(), alpha())) }}>
          <span class="ds-big-label">{bare() ?? notation()}</span>
          <span class="ds-big-value">{said()}</span>
        </div>
      </div>
      <Slider label="Lightness" short="L" value={o().l} max={1} step={0.001} said={(o().l * 100).toFixed(1)} track={track.l()} onInput={(l) => change({ l })} />
      <Slider
        label="Chroma"
        short="C"
        value={o().c}
        max={0.37}
        step={0.001}
        said={o().c.toFixed(3)}
        track={track.c()}
        mark={maxChroma(o().l, o().h) / 0.37}
        onInput={(c) => change({ c })}
      />
      <Slider label="Hue" short="H" value={o().h} max={360} step={0.5} said={o().h.toFixed(0)} track={track.h()} onInput={(h) => change({ h })} />
      <Slider
        label="Alpha"
        short="A"
        value={alpha()}
        max={1}
        step={0.01}
        said={alpha().toFixed(2)}
        track={track.a()}
        chequer
        onInput={(a) => {
          setAlpha(a)
          emit()
        }}
      />
      <Show when={out()}>
        <p class="ds-note">
          Outside sRGB. {notation() === "oklch" || notation() === "oklab" ? "A wide-gamut screen shows it; others the nearest they can." : `Written as the nearest ${notation()} can say.`}
        </p>
      </Show>
      <p class="ds-contrast">
        <span style={{ background: write("hex", o(), 1), color: "#fff" }}>Aa</span>
        {contrast({ ...shown(), a: 1 }, { r: 1, g: 1, b: 1, a: 1 }).toFixed(1)} with white
        <span style={{ background: write("hex", o(), 1), color: "#000" }}>Aa</span>
        {contrast({ ...shown(), a: 1 }, { r: 0, g: 0, b: 0, a: 1 }).toFixed(1)} with black
      </p>
    </div>
  )
}

function Slider(props: {
  label: string
  short: string
  value: number
  max: number
  step: number
  said: string
  track: string
  /** Where sRGB ends on the track, 0…1. */
  mark?: number
  chequer?: boolean
  onInput: (value: number) => void
}) {
  return (
    <label class="ds-slider">
      <span class="ds-slider-name" title={props.label}>
        {props.short}
      </span>
      <span class="ds-slider-track" classList={{ chequer: props.chequer }} style={{ "--track": props.track }}>
        <input type="range" aria-label={props.label} min="0" max={props.max} step={props.step} value={props.value} onInput={(e) => props.onInput(Number(e.currentTarget.value))} />
        <Show when={props.mark !== undefined && props.mark < 0.995}>
          <i class="ds-slider-mark" style={{ left: `${props.mark! * 100}%` }} title="sRGB ends here" />
        </Show>
      </span>
      <output class="ds-slider-said">{props.said}</output>
    </label>
  )
}

// ── the view ────────────────────────────────────────────────────────────────────────────────────
export function DsSpace() {
  const view = () => dockViews.tokens
  onMount(() => {
    send({ type: "view" })
    if (dockViews.tokens === undefined) dockAct({ panel: "tokens", act: { type: "whole" } })
  })
  onCleanup(() => send({ type: "stop" }))
  // A new page's overlay reads nothing until asked again.
  createEffect(on(() => view() === null, (fresh) => fresh && send({ type: "view" }), { defer: true }))

  const [q, setQ] = createSignal("")
  const [chosen, setChosen] = createSignal<string>()
  const [error, setError] = createSignal("")
  /** What was said to the agent: name → the value it was told. */
  const [told, setTold] = createSignal<ReadonlyMap<string, string>>(new Map())

  const all = () => view()?.tokens ?? []
  const byName = createMemo(() => new Map(all().map((t) => [t.name, t])))
  const shown = createMemo(() => {
    const words = q().trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return all()
    return all().filter((t) => words.every((w) => t.name.toLowerCase().includes(w) || t.value.toLowerCase().includes(w)))
  })
  const sections = createMemo(() =>
    KINDS.map((k) => {
      const list = shown().filter((t) => t.kind === k.kind)
      // (Not colours: those of one name together, --space-* then --radius-*, a scale in its order.)
      const stem = (t: Token) => t.name.replace(/[-_][^-_]*$/, "")
      if (k.kind !== "colour") list.sort((a, b) => stem(a).localeCompare(stem(b)) || (a.size ?? Infinity) - (b.size ?? Infinity) || a.name.localeCompare(b.name, "en", { numeric: true }))
      return { ...k, list, ...families(list) }
    }).filter((s) => s.list.length),
  )
  /** Variables | Suggestions: what the list shows. */
  const [tab, setTab] = createSignal<"variables" | "suggestions">("variables")
  const suggestions = createMemo(() => suggest(all(), view()?.loose ?? []))
  /** The suggestions picked for the agent, by id; and those it was told. */
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set())
  const [said, setSaid] = createSignal<ReadonlySet<string>>(new Set())
  const toSay = () => suggestions().filter((x) => picked().has(x.id) && !said().has(x.id))
  const pick = (id: string) => {
    const next = new Set(picked())
    if (!next.delete(id)) next.add(id)
    setPicked(next)
  }
  const token = () => byName().get(chosen() ?? "")
  const changed = () => all().filter((t) => t.set !== undefined)
  const unsent = () => changed().filter((t) => told().get(t.name) !== t.set)

  // A value set: the page's at the next frame (a slider says sixty a second, the page one).
  const waiting = new Map<string, string>()
  let frame = 0
  const set = (name: string, value: string) => {
    waiting.set(name, value)
    frame ||= requestAnimationFrame(() => {
      frame = 0
      for (const [n, v] of waiting) send({ type: "set", name: n, value: v })
      waiting.clear()
    })
  }
  onCleanup(() => cancelAnimationFrame(frame))

  const scopes = (t: Token) => [...new Set(t.where.map((w) => w.scope))]
  function tell(words = "", pictures: PromptFile[] = []) {
    const list = unsent(), more = toSay()
    if (!list.length && !more.length) return
    const lines = list.map((t) => {
      const from = t.where.length === 1 ? t.where[0]!.value : (t.was ?? "")
      const at = scopes(t)
      return `- \`${t.name}\`: \`${from}\` → \`${t.set}\`${at.length ? ` (declared in ${at.map((s) => `\`${s}\``).join(", ")})` : ""}`
    })
    const parts: string[] = words.trim() ? [words.trim()] : []
    if (list.length)
      parts.push(
        `Change ${list.length === 1 ? "this CSS variable" : "these CSS variables"} in the code. I set ${list.length === 1 ? "it" : "them"} on the live page at ${state.page.url}; make the source say the same, where ${list.length === 1 ? "it is" : "they are"} declared.\n\n${lines.join("\n")}`,
      )
    if (more.length) parts.push(`${list.length ? "Also, about" : "About"} the design tokens of ${state.page.url}, as its stylesheets have them:\n\n${more.map((x) => `- ${x.say}`).join("\n")}`)
    setError("")
    return b42.invoke("send", parts.join("\n\n"), pictures).then(
      () => {
        setTold(new Map([...told(), ...list.map((t) => [t.name, t.set!] as const)]))
        setSaid(new Set([...said(), ...more.map((x) => x.id)]))
      },
      (err) => {
        setError(message(err))
        throw err
      },
    )
  }
  /** What waits to go: each changed value, then each suggestion added. It goes from the panel's
   *  message box (store.ts, offerPending), with what is typed there. */
  const items = (): PendingItem[] => [
    ...unsent().map((t) => ({
      id: t.name,
      label: `${t.name}: ${t.set}`,
      title: `${t.name}: ${t.was} → ${t.set}. × puts it back`,
      ...(t.kind === "colour" ? { swatch: cssOf(t) } : {}),
      remove: () => set(t.name, ""),
    })),
    ...toSay().map((x) => ({ id: x.id, label: x.short, title: x.title, ...(x.swatches[0] ? { swatch: x.swatches[0] } : {}), remove: () => pick(x.id) })),
  ]
  offerPending({ items, send: (words, _background, pictures) => tell(words, pictures) })
  const canTell = () => state.connection.status === "online" && !!state.session

  const Swatch = (p: { t: Token; label: string; class?: string }) => (
    <button
      type="button"
      class={`ds-swatch ${p.class ?? ""}`}
      classList={{ on: chosen() === p.t.name, set: p.t.set !== undefined }}
      style={{ "--c": cssOf(p.t), color: inkOn(cssOf(p.t)) }}
      title={`${p.t.name}: ${p.t.value}`}
      aria-pressed={chosen() === p.t.name}
      onClick={() => setChosen(p.t.name)}
    >
      <span class="ds-swatch-label">{p.label}</span>
    </button>
  )
  const Row = (p: { t: Token; children?: any }) => (
    <button type="button" class="ds-row" classList={{ on: chosen() === p.t.name, set: p.t.set !== undefined }} aria-pressed={chosen() === p.t.name} onClick={() => setChosen(p.t.name)}>
      <span class="ds-row-name">{p.t.name}</span>
      {p.children}
      <span class="ds-row-value">{p.t.set ?? p.t.where[0]?.value ?? p.t.value}</span>
    </button>
  )

  return (
    <div class="ds-view">
    <section class="ds" aria-label="Design system">
      <header class="ds-head">
        <h2 class="ds-title">
          Design system
          <Show when={view()}>
            <span class="ds-count">
              {all().length}
              {view()!.partial ? "+" : ""} variables
            </span>
          </Show>
        </h2>
        <div class="devices ds-tabs" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" class="device" aria-checked={tab() === "variables"} onClick={() => setTab("variables")}>
            Variables
          </button>
          <button type="button" role="radio" class="device" aria-checked={tab() === "suggestions"} onClick={() => setTab("suggestions")}>
            Suggestions
            <Show when={suggestions().length}>
              <span class="ds-count">{suggestions().length}</span>
            </Show>
          </button>
        </div>
        <label class="ds-find">
          <Icon name="search" />
          <input type="search" placeholder="Find a variable" aria-label="Find a variable" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
        </label>
        <button type="button" class="icon-btn" aria-label="Read the page again" title="Read the page again" onClick={() => send({ type: "refresh" })}>
          <Icon name="reload" />
        </button>
        {/* With the panel shut there is no message box to send from: sent from here, without words. */}
        <Show when={!composerUp() && items().length}>
          <button type="button" class="btn primary" disabled={!canTell()} title={canTell() ? "Send to the agent, which writes it into the code. Open the panel to add words" : "No agent to tell"} onClick={() => void tell()?.catch(() => {})}>
            <Icon name="send" />
            Send · {items().length}
          </button>
        </Show>
      </header>
      <Show when={error()}>
        <p class="form-error ds-error">{error()}</p>
      </Show>
      <div class="ds-body">
        <div class="ds-list">
          <Show when={tab() === "suggestions"}>
            <Show when={suggestions().length} fallback={<p class="ds-empty">Nothing to suggest: no value is written out where a variable would say it.</p>}>
              <ul class="ds-sugs">
                <For each={suggestions()}>
                  {(x) => (
                    <li class="ds-sug" classList={{ picked: picked().has(x.id) }}>
                      <span class="ds-sug-swatches">
                        <For each={x.swatches}>{(c) => <i style={{ "--c": c }} />}</For>
                      </span>
                      <div class="ds-sug-words">
                        <p class="ds-sug-title">{x.title}</p>
                        <Show when={x.names.length} fallback={<p class="ds-sug-detail">{x.detail}</p>}>
                          <p class="ds-sug-detail">
                            <For each={x.names}>
                              {(n) => (
                                <button type="button" class="ds-sug-name" onClick={() => setChosen(n)}>
                                  {n}
                                </button>
                              )}
                            </For>
                            <Show when={x.id.startsWith("use ")}>
                              <span>{x.detail}</span>
                            </Show>
                          </p>
                        </Show>
                      </div>
                      <Show when={!said().has(x.id)} fallback={<span class="ds-sug-sent">Sent</span>}>
                        <button
                          type="button"
                          class="icon-btn"
                          aria-pressed={picked().has(x.id)}
                          aria-label={picked().has(x.id) ? "Take out of what is sent" : "Add to what is sent"}
                          title={picked().has(x.id) ? "Take out of what is sent" : "Add to what is sent"}
                          onClick={() => pick(x.id)}
                        >
                          <Icon name={picked().has(x.id) ? "check" : "plus"} />
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
          <Show when={tab() === "variables"}>
          <Show when={view() && !all().length}>
            <div class="ds-empty">
              <p class="chat-empty-lead">This page declares no variables.</p>
              <p>
                Its stylesheets set no custom properties (<code>--name</code>).
                {view()!.unread ? ` ${view()!.unread} of them are from another address and can't be read.` : ""}
              </p>
            </div>
          </Show>
          <Show when={all().length && !shown().length}>
            <p class="ds-empty">Nothing is called that.</p>
          </Show>
          <For each={sections()}>
            {(s) => (
              <section class="ds-section">
                <h3 class="ds-section-title">
                  {s.title} <span class="ds-count">{s.list.length}</span>
                </h3>
                <Show
                  when={s.kind === "colour"}
                  fallback={
                    <div class="ds-rows">
                      <For each={s.list}>
                        {(t) => (
                          <Row t={t}>
                            <Show when={s.kind === "size"}>
                              <span class="ds-bar">
                                <i style={{ width: Number.isFinite(t.size) ? `${Math.max(1, t.size!)}px` : "0" }} />
                              </span>
                              <span class="ds-row-px">{t.size !== undefined && !/^-?[\d.]+px$/.test(t.value) ? `${Number(t.size.toFixed(2))} px` : ""}</span>
                            </Show>
                            <Show when={s.kind === "shadow"}>
                              <span class="ds-shadow">
                                <i style={{ "box-shadow": t.value }} />
                              </span>
                            </Show>
                            <Show when={s.kind === "font"}>
                              <span class="ds-font" style={{ "font-family": t.value }}>
                                Ag
                              </span>
                            </Show>
                          </Row>
                        )}
                      </For>
                    </div>
                  }
                >
                  <For each={s.ramps}>
                    {(f) => (
                      <div class="ds-ramp">
                        <span class="ds-ramp-name">{f.base}</span>
                        <div class="ds-ramp-steps">
                          <For each={f.tokens}>{(t) => <Swatch t={t} label={stepOf(t, f.base)} class="step" />}</For>
                        </div>
                      </div>
                    )}
                  </For>
                  <div class="ds-cards">
                    <For each={s.rest}>
                      {(t) => (
                        <div class="ds-card">
                          <Swatch t={t} label="" />
                          <span class="ds-card-name">{t.name}</span>
                          <span class="ds-card-value">{t.set ?? t.where[0]?.value ?? t.value}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </section>
            )}
          </For>
          </Show>
          <Show when={view()?.unread && all().length}>
            <p class="ds-note ds-foot">
              {view()!.unread} {view()!.unread === 1 ? "stylesheet is" : "stylesheets are"} from another address: what {view()!.unread === 1 ? "it declares" : "they declare"} is listed with no rule to name.
            </p>
          </Show>
        </div>
        <Show when={token()}>
          {(t) => (
            <aside class="ds-detail" aria-label={t().name}>
              <header class="ds-detail-head">
                <h3 class="ds-detail-name">{t().name}</h3>
                <button type="button" class="icon-btn" aria-label="Close" onClick={() => setChosen(undefined)}>
                  <Icon name="close" />
                </button>
              </header>
              <p class="ds-detail-facts">
                {t().uses ? `Used by ${t().uses} ${t().uses === 1 ? "rule" : "rules"}` : "No rule uses it"}
                {t().local ? " · a component's own" : ""}
              </p>
              <Show when={t().kind === "colour" && rgbOf(cssOf(t()))}>
                <Picker token={t()} onSet={(v) => set(t().name, v)} />
              </Show>
              <label class="ds-field">
                <span class="ds-field-name">Value</span>
                <input
                  class="input ds-value"
                  spellcheck={false}
                  value={t().set ?? (t().where.length === 1 ? t().where[0]!.value : t().value)}
                  onChange={(e) => set(t().name, e.currentTarget.value.trim())}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
              </label>
              <Show when={t().set !== undefined}>
                <p class="ds-was">
                  was <code>{t().was}</code>
                  <button type="button" class="btn" onClick={() => set(t().name, "")}>
                    Put back
                  </button>
                </p>
              </Show>
              <Show when={t().where.length} fallback={<p class="ds-note">No rule this window can read declares it.</p>}>
                <h4 class="ds-field-name">Declared in</h4>
                <ul class="ds-where">
                  <For each={t().where}>
                    {(w) => {
                      const alias = () => /^var\(\s*(--[\w-]+)\s*\)$/.exec(w.value)?.[1]
                      return (
                        <li>
                          <span class="ds-where-scope">{w.scope}</span>
                          <Show when={alias() && byName().has(alias()!)} fallback={<span class="ds-where-value">{w.value}</span>}>
                            <button type="button" class="ds-where-value ds-alias" onClick={() => setChosen(alias())}>
                              <i style={{ background: byName().get(alias()!)!.kind === "colour" ? cssOf(byName().get(alias()!)!) : "transparent" }} />
                              {alias()}
                            </button>
                          </Show>
                        </li>
                      )
                    }}
                  </For>
                </ul>
              </Show>
            </aside>
          )}
        </Show>
      </div>
    </section>
    </div>
  )
}

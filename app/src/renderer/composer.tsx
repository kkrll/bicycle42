// The message box: text, pictures, the `/` and `@` menus, recall of earlier messages, and how a
// message is delivered while the agent is working.
//
// Mentions live beside the text as ranges. The textarea stays a plain textarea (selection, undo,
// IME and paste all keep working); a mirror behind it paints a tint under each `@name`, so a
// mention reads as a chip without the box becoming an editor of its own.
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js"
import type { Mention, MentionOption, ModelInfo, PromptFile, SendOptions, SlashCommand } from "../shared/types"
import { Icon, Kbd, type IconName } from "./icons"
import { SuggestMenu, type MenuItem } from "./menu"
import { act, chat, keys, mac, message, b42, recall, remember, setNotice, state } from "./store"

// ── a line of news under the box ────────────────────────────────────────────────────────────────

const [hint, setHint] = createSignal("")
let hintTimer = 0

/** Says something short under the message box for a few seconds: "Note 5 is out of the queue."
 *  Something that has to be read before acting (what /undo will take back) stays longer. */
export function announce(words: string, ms = 4000): void {
  setHint(words)
  clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => setHint(""), ms)
}

/** The "Enter waits, mod+Enter interrupts" line teaches; after three uses it has done its job. */
const KEYS_TAUGHT = 3
const [keysUsed, setKeysUsed] = createSignal(Number(recall("busy-keys.used")) || 0)
function usedBusyKey() {
  setKeysUsed(keysUsed() + 1)
  remember("busy-keys.used", String(keysUsed()))
}

// ── model, effort ─────────────────────────────────────────────────────────────────────────

function Pickers() {
  const current = () => state.session?.model ?? state.defaultModel
  const info = createMemo(() => {
    const c = current()
    return c && state.models.find((m) => m.providerID === c.providerID && m.id === c.id)
  })
  const groups = createMemo(() => {
    const by = new Map<string, { model: ModelInfo; index: number }[]>()
    state.models.forEach((model, index) => {
      const list = by.get(model.providerID)
      if (list) list.push({ model, index })
      else by.set(model.providerID, [{ model, index }])
    })
    return [...by]
  })
  // A <select> shows what the reviewer picked, at once. If main then refuses, state never changes
  // and nothing would put the control back, so a failed command resets it to what state says.
  const request = (el: HTMLSelectElement, shown: () => string, call: Promise<void>) =>
    call.catch((err) => {
      setNotice(message(err))
      el.value = shown()
      if (el.selectedIndex < 0) el.selectedIndex = 0
    })
  const modelValue = () => String(state.models.indexOf(info() as ModelInfo))
  const choose = (el: HTMLSelectElement) => {
    const m = state.models[Number(el.value)]
    if (!m) return
    // Keep the effort level when the new model has the same one.
    const variant = current()?.variant
    const model = { providerID: m.providerID, id: m.id, ...(variant && m.variants.includes(variant) ? { variant } : {}) }
    void request(el, modelValue, b42.invoke("setModel", model))
  }
  const variant = () => current()?.variant ?? ""
  return (
    <div class="pickers">
      <Show when={state.models.length}>
        <Pick
          class="model"
          value={info()?.name ?? "Model"}
          help={`Model: ${info()?.name ?? "none chosen"}. The AI that does the work. Models marked "no screenshots" only read the notes' words.`}
        >
          <select class="pick-native" aria-label="Model" disabled={!state.session} onChange={(e) => choose(e.currentTarget)}>
            <Show when={!info()}>
              <option selected disabled>
                Model
              </option>
            </Show>
            <For each={groups()}>
              {([provider, models]) => (
                <optgroup label={provider}>
                  <For each={models}>
                    {(entry) => (
                      <option value={entry.index} selected={entry.model === info()}>
                        {entry.model.name}
                        {entry.model.images ? "" : " (no screenshots)"}
                      </option>
                    )}
                  </For>
                </optgroup>
              )}
            </For>
          </select>
        </Pick>
      </Show>
      <Show when={info()?.variants.length}>
        <Pick
          class="effort"
          prefix="Effort"
          value={variant() || "default"}
          short={short(variant() || "default")}
          help={`Effort: ${variant() || "the model's default"}. How long the model thinks before it acts: more is slower and more careful.`}
        >
          <select
            class="pick-native"
            aria-label="Effort"
            disabled={!state.session}
            onChange={(e) => {
              const c = current()
              const v = e.currentTarget.value
              const model = c && { providerID: c.providerID, id: c.id, ...(v ? { variant: v } : {}) }
              if (model) void request(e.currentTarget, variant, b42.invoke("setModel", model))
            }}
          >
            <option value="" selected={!variant()}>
              default
            </option>
            <For each={info()!.variants}>{(v) => <option value={v} selected={v === variant()}>{v}</option>}</For>
          </select>
        </Pick>
      </Show>
    </div>
  )
}

/** "Med" for "medium", "Low" for "low": the effort level when the box is narrow. */
const short = (word: string) => {
  const w = word.charAt(0).toUpperCase() + word.slice(1)
  return w.length <= 4 ? w : w.slice(0, 3)
}

/** A native <select>, invisible, over a label that reads in plain words: "Effort medium", or
 *  "Med" when the box is narrow. The select still takes the clicks and the keys. */
function Pick(props: { class: string; prefix?: string; value: string; short?: string; help: string; children: JSX.Element }) {
  return (
    <label class={`pick ${props.class}`} classList={{ off: !state.session }} title={state.session ? props.help : "Open a conversation first"}>
      <span class="pick-text">
        <Show when={props.prefix}>
          <span class="pick-prefix">{props.prefix}</span>
        </Show>
        <span class="pick-long">{props.value}</span>
        <span class="pick-short">{props.short ?? props.value}</span>
      </span>
      <Icon name="down" />
      {props.children}
    </label>
  )
}

/** Why the composer cannot send right now, or "" when it can. */
function blocked(): string {
  if (state.session) return ""
  const c = state.connection.status
  if (c === "offline") return "Not connected to the server."
  if (c !== "online") return "Connecting…"
  if (!state.site) return "Open your site to start."
  if (!state.site.directory) return "Choose where this site's code lives first."
  // Main explains a conversation that would not open with a marker in the (session-less) transcript.
  return chat.items.length ? "No conversation is open." : "Starting a conversation…"
}

// ── pictures ────────────────────────────────────────────────────────────────────────────────────

const MAX_IMAGES = 4

/** A picture as a JPEG data URI, at most 1600 px on its long side. */
async function shrink(file: File): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(file)
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
    const c = document.createElement("canvas")
    c.width = Math.max(1, Math.round(bmp.width * k))
    c.height = Math.max(1, Math.round(bmp.height * k))
    const g = c.getContext("2d")!
    g.fillStyle = "white" // JPEG has no transparency
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(bmp, 0, 0, c.width, c.height)
    return c.toDataURL("image/jpeg", 0.85)
  } catch {
    return undefined
  }
}

const isImage = (f: File) => f.type.startsWith("image/")
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files")
const jpegName = (name: string) => (name.replace(/\.[^.]*$/, "") || "image") + ".jpg"

// ── mentions ────────────────────────────────────────────────────────────────────────────────────

type Tracked = Mention & { label: string }

/** Characters that would make `@name` part of a longer word. */
const WORDISH = /[\w.\-/]/

/** The text changed from `before` to `after`: move the mentions behind the edit, drop the ones it
 *  touched, and drop any whose text no longer reads `@label`. One contiguous edit is assumed,
 *  which is what typing, deleting, pasting and undo produce. */
function follow(before: string, after: string, list: Tracked[]): Tracked[] {
  if (!list.length || before === after) return list
  const max = Math.min(before.length, after.length)
  let p = 0
  while (p < max && before[p] === after[p]) p++
  let s = 0
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++
  const editEnd = before.length - s
  const delta = after.length - before.length
  return list
    .flatMap((m) => (m.end <= p ? [m] : m.start >= editEnd ? [{ ...m, start: m.start + delta, end: m.end + delta }] : []))
    .filter((m) => after.slice(m.start, m.end) === `@${m.label}` && !WORDISH.test(after[m.end] ?? ""))
}

const GROUPS: Record<MentionOption["kind"], { name: string; icon: IconName; order: number }> = {
  file: { name: "Files", icon: "file", order: 0 },
  folder: { name: "Files", icon: "folder", order: 0 },
  skill: { name: "Skills", icon: "skill", order: 1 },
  agent: { name: "Agents", icon: "agent", order: 2 },
}

/** "src/components" for "src/components/Hero.tsx"; files at the top have none. */
const folderOf = (path: string) => path.replace(/\/+$/, "").replace(/\/?[^/]*$/, "") || undefined

type Trigger = { kind: "slash" | "mention"; start: number; end: number; query: string }

/** Earlier messages typed in this conversation, newest first, for the arrow keys. */
function recallable(): string[] {
  const out: string[] = []
  for (let i = chat.items.length - 1; i >= 0; i--) {
    const item = chat.items[i]!
    if (item.kind !== "user" || item.note || !item.text.trim()) continue
    if (out[out.length - 1] !== item.text) out.push(item.text)
  }
  return out
}

// ── the box ─────────────────────────────────────────────────────────────────────────────────────

export function Composer(props: { ref: (el: HTMLTextAreaElement) => void; onSent: () => void }) {
  const [text, setText] = createSignal("")
  const [caret, setCaret] = createSignal(0)
  const [mentions, setMentions] = createSignal<Tracked[]>([])
  const [error, setError] = createSignal("")
  const [images, setImages] = createSignal<PromptFile[]>([])
  const [dropping, setDropping] = createSignal(false)
  const [commands, setCommands] = createSignal<SlashCommand[]>([])
  const [options, setOptions] = createSignal<MentionOption[]>([])
  /** The query the mention options answer. */
  const [answered, setAnswered] = createSignal<string | null>(null)
  const [active, setActive] = createSignal(0)
  /** The menu the reviewer closed with Esc, as "kind:start", so it stays closed while they type on. */
  const [dismissed, setDismissed] = createSignal("")
  /** Which earlier message the arrows recalled, -1 when the box holds a draft. */
  let browsing = -1
  let field!: HTMLTextAreaElement
  let mirror!: HTMLDivElement
  let picker!: HTMLInputElement

  const say = announce

  /** Every change to the text goes through here, so the mentions follow it. */
  const draft = (next: string, at = next.length, focus = false) => {
    setMentions(follow(text(), next, mentions()))
    setText(next)
    // The textarea's value is bound to text(); the caret is placed once it has the new value.
    field.value = next
    field.setSelectionRange(at, at)
    setCaret(at)
    if (focus) field.focus()
  }

  // ── the server's commands, once per conversation ──
  createEffect(
    on(
      () => state.session?.id,
      (id) => {
        setCommands([])
        if (id)
          b42
            .invoke("commands")
            .then((list) => state.session?.id === id && setCommands(list))
            .catch(() => setCommands([]))
      },
    ),
  )

  // ── what the text before the caret asks for ──
  const trigger = createMemo<Trigger | null>(() => {
    const t = text()
    const c = caret()
    const before = t.slice(0, c)
    const slash = /^\/(\S*)$/.exec(before)
    if (slash && commands().length) return { kind: "slash", start: 0, end: c, query: slash[1]! }
    const at = /(?:^|\s)@([^\s@]*)$/.exec(before)
    if (!at) return null
    const start = c - at[1]!.length - 1
    // Right behind a mention that is already made: nothing to ask.
    if (mentions().some((m) => m.start === start)) return null
    return { kind: "mention", start, end: c, query: at[1]! }
  })

  // Mention lookups: one in flight per pause in typing, and only the newest answer counts.
  let asked = 0
  let wait = 0
  onCleanup(() => clearTimeout(wait))
  createEffect(
    on(
      () => (trigger()?.kind === "mention" ? trigger()!.query : null),
      (query) => {
        clearTimeout(wait)
        if (query === null) return
        const ticket = ++asked
        wait = window.setTimeout(() => {
          b42
            .invoke("mentions", query)
            .then((list) => ticket === asked && (setOptions(list), setAnswered(query)))
            .catch(() => ticket === asked && (setOptions([]), setAnswered(query)))
        }, 120)
      },
    ),
  )

  const items = createMemo<MenuItem[]>(() => {
    const t = trigger()
    if (!t) return []
    if (t.kind === "slash") {
      const q = t.query.toLowerCase()
      const starts = commands().filter((c) => c.name.toLowerCase().startsWith(q))
      const rest = commands().filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q))
      // The app's own commands stay above the server's, each group best match first.
      const own = (c: SlashCommand) => (c.builtin ? 0 : 1)
      return [...starts, ...rest]
        .map((c, i) => ({ c, i }))
        .sort((a, b) => own(a.c) - own(b.c) || a.i - b.i)
        .map(({ c }) => ({ key: c.name, label: `/${c.name}`, detail: c.description, group: c.builtin ? "Built in" : "From this project" }))
    }
    return options()
      .map((o, i) => ({ o, i }))
      .sort((a, b) => GROUPS[a.o.kind].order - GROUPS[b.o.kind].order || a.i - b.i)
      .map(({ o }) => ({
        key: `${o.kind}:${o.id}`,
        label: o.label,
        detail: o.detail ?? (o.kind === "file" || o.kind === "folder" ? folderOf(o.id) : undefined),
        path: !o.detail && (o.kind === "file" || o.kind === "folder"),
        icon: GROUPS[o.kind].icon,
        group: GROUPS[o.kind].name,
      }))
  })
  /** The mention options in the order `items` shows them. */
  const sortedOptions = createMemo(() =>
    options()
      .map((o, i) => ({ o, i }))
      .sort((a, b) => GROUPS[a.o.kind].order - GROUPS[b.o.kind].order || a.i - b.i)
      .map(({ o }) => o),
  )

  const menu = createMemo(() => {
    const t = trigger()
    if (!t || dismissed() === `${t.kind}:${t.start}` || blocked()) return null
    return t
  })
  // A new list starts at its first row.
  createEffect(on(() => items().map((i) => i.key).join("\n"), () => setActive(0)))
  // Esc closes a menu until the reviewer starts another one somewhere else.
  createEffect(on(() => (trigger() ? `${trigger()!.kind}:${trigger()!.start}` : ""), (key) => key !== dismissed() && setDismissed("")))

  const pick = (index: number) => {
    const t = menu()
    if (!t) return
    const t0 = text()
    if (t.kind === "slash") {
      const name = commands().find((c) => `/${c.name}` === items()[index]?.label)?.name
      if (!name) return
      const rest = t0.slice(t.end).replace(/^\S*\s*/, "")
      draft(`/${name} ${rest}`, name.length + 2)
      return
    }
    const option = sortedOptions()[index]
    if (!option) return
    const after = t0.slice(t.end).replace(/^[^\s@]*/, "")
    const spaced = /^\s/.test(after) ? after : ` ${after}`
    const token = `@${option.label}`
    draft(t0.slice(0, t.start) + token + spaced, t.start + token.length + 1)
    setMentions([...mentions(), { kind: option.kind, id: option.id, start: t.start, end: t.start + token.length, label: option.label }].sort((a, b) => a.start - b.start))
  }

  // ── the tint under each mention ──
  const segments = createMemo(() => {
    const t = text()
    const out: { text: string; mention: boolean }[] = []
    let at = 0
    for (const m of mentions()) {
      if (m.start > at) out.push({ text: t.slice(at, m.start), mention: false })
      out.push({ text: t.slice(m.start, m.end), mention: true })
      at = m.end
    }
    // A trailing newline needs something after it, or the mirror is a line short.
    out.push({ text: t.slice(at) + "​", mention: false })
    return out
  })

  // ── sending ──
  const busy = () => !!state.session?.busy
  const send = (steer: boolean) => {
    const raw = text()
    const body = raw.trim()
    if (!body || blocked()) return
    const lead = raw.length - raw.trimStart().length
    const marks = mentions().map((m) => ({ kind: m.kind, id: m.id, start: m.start - lead, end: m.end - lead, label: m.label }))
    const pictures = images()
    const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(body)
    const known = command ? commands().find((c) => c.name === command[1]) : undefined
    const name = known?.name ?? ""
    const args = command?.[2] ?? ""
    const delivery = busy() ? (steer ? "steer" : "queue") : undefined
    if (delivery) usedBusyKey()
    const options = (shift: number): SendOptions => {
      const list: Mention[] = marks
        .filter((m) => m.start >= shift)
        .map((m) => ({ kind: m.kind, id: m.id, start: m.start - shift, end: m.end - shift }))
      return { ...(list.length ? { mentions: list } : {}), ...(delivery ? { delivery } : {}) }
    }
    const saved = mentions()
    browsing = -1
    draft("")
    setImages([])
    setError("")
    props.onSent()
    // Sending while the agent works is fine: the message queues. If it fails, the words come back.
    const call = name
      ? b42.invoke("runCommand", name, args, pictures, options(body.length - args.length))
      : b42.invoke("send", body, pictures, options(0))
    call.then(
      (result) => {
        // A built-in's answer: what it did, and maybe words for the box (the message /undo took
        // back, or the confirmation to send next), unless something was typed meanwhile.
        if (!result || typeof result !== "object") return
        if (result.say) say(result.say, result.draft ? 30_000 : 6000)
        if (result.draft && !text()) draft(result.draft, result.draft.length, true)
      },
      (err) => {
        // One of the app's own commands that the server would not do ("nothing to redo", "the
        // agent is working"): its reason is news, not a failed message to send again.
        if (known?.builtin) return say(message(err), 8000)
        fail(err)
      },
    )
    const fail = (err: unknown) => {
      setError(message(err))
      if (!text()) {
        draft(raw)
        setMentions(saved)
      }
      if (!images().length) setImages(pictures)
    }
  }

  // ── pictures ──
  const attach = (files: File[]) => {
    const pictures = files.filter(isImage)
    if (files.length && !pictures.length) return say("Only pictures can be attached.")
    const room = MAX_IMAGES - images().length
    if (pictures.length > room) say(`Up to ${MAX_IMAGES} pictures per message.`)
    for (const f of pictures.slice(0, Math.max(0, room)))
      void shrink(f).then((uri) => {
        if (!uri) return say(`Couldn't read ${f.name || "that picture"}.`)
        if (images().length < MAX_IMAGES) setImages([...images(), { name: jpegName(f.name || "image"), uri }])
      })
  }
  const paste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])].filter(isImage)
    if (!files.length) return // plain text pastes as usual
    e.preventDefault()
    attach(files)
  }
  // Leaving a child of the box fires dragleave too; count the way in and out.
  let depth = 0
  const dragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth++
    setDropping(true)
  }
  const dragLeave = () => {
    depth = Math.max(0, depth - 1)
    if (!depth) setDropping(false)
  }
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = 0
    setDropping(false)
    if (blocked()) return
    attach([...(e.dataTransfer?.files ?? [])])
    field.focus()
  }

  // ── keys ──
  const mod = (e: KeyboardEvent) => (mac() ? e.metaKey : e.ctrlKey)
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return
    const m = menu()
    if (m) {
      const n = items().length
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        if (n) setActive((active() + (e.key === "ArrowDown" ? 1 : -1) + n) % n)
        return
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !mod(e) && n) {
        e.preventDefault()
        pick(active())
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        setDismissed(`${m.kind}:${m.start}`)
        return
      }
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const list = recallable()
      const t = text()
      const recalled = browsing >= 0 && t === list[browsing]
      if (!(t === "" && browsing < 0 && e.key === "ArrowUp") && !recalled) return
      // Inside a recalled message of several lines the arrows move the caret first.
      const up = e.key === "ArrowUp"
      if (recalled && (up ? t.slice(0, field.selectionStart).includes("\n") : t.slice(field.selectionEnd).includes("\n"))) return
      const next = browsing + (up ? 1 : -1)
      if (next >= list.length) return
      e.preventDefault()
      browsing = next
      draft(next < 0 ? "" : list[next]!)
      return
    }
    if (e.key === "Escape" && browsing >= 0) {
      e.preventDefault()
      e.stopPropagation()
      browsing = -1
      draft("")
      return
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send(mod(e))
    }
  }

  const blind = () => {
    const m = state.session?.model ?? state.defaultModel
    const found = m && state.models.find((x) => x.providerID === m.providerID && x.id === m.id)
    return !!found && !found.images
  }
  const menuId = "composer-menu"

  return (
    <div class="composer">
      <Show when={error()}>
        <p class="form-error">{error()}</p>
      </Show>
      <div
        class="composer-box"
        classList={{ dropping: dropping() }}
        onDragEnter={dragEnter}
        onDragOver={(e) => hasFiles(e) && e.preventDefault()}
        onDragLeave={dragLeave}
        onDrop={drop}
      >
        <Show when={menu()}>
          {(m) => (
            <SuggestMenu
              id={menuId}
              label={m().kind === "slash" ? "Commands" : "Files, skills and agents"}
              items={items()}
              active={active()}
              empty={m().kind === "slash" ? "No command by that name." : answered() === m().query ? "Nothing by that name." : "Looking…"}
              onActive={setActive}
              onPick={(i) => {
                pick(i)
                field.focus()
              }}
            />
          )}
        </Show>
        <div class="composer-field">
          <div class="composer-mirror" aria-hidden="true" ref={mirror}>
            <For each={segments()}>{(s) => (s.mention ? <mark>{s.text}</mark> : s.text)}</For>
          </div>
          <textarea
            ref={(el) => {
              field = el
              props.ref(el)
            }}
            rows="3"
            aria-label="Message to the agent"
            aria-autocomplete="list"
            aria-controls={menu() ? menuId : undefined}
            aria-activedescendant={menu() && items().length ? `${menuId}-${active()}` : undefined}
            placeholder={blocked() || "Ask anything. / for commands, @ for files"}
            disabled={!!blocked()}
            value={text()}
            onInput={(e) => {
              browsing = -1
              const el = e.currentTarget
              setMentions(follow(text(), el.value, mentions()))
              setText(el.value)
              setCaret(el.selectionStart)
            }}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
            onMouseUp={(e) => setCaret(e.currentTarget.selectionStart)}
            onBlur={() => setDismissed(trigger() ? `${trigger()!.kind}:${trigger()!.start}` : "")}
            onFocus={() => setDismissed("")}
            onScroll={(e) => (mirror.scrollTop = e.currentTarget.scrollTop)}
            onPaste={paste}
            onKeyDown={onKeyDown}
          />
        </div>
        <Show when={images().length}>
          <div class="composer-images">
            <For each={images()}>
              {(im, i) => (
                <button
                  class="composer-image"
                  title="Remove this picture"
                  aria-label={`Remove picture ${i() + 1}`}
                  onClick={() => {
                    setImages(images().filter((x) => x !== im))
                    field.focus()
                  }}
                >
                  <img src={im.uri} alt="" />
                  <span class="composer-image-x">
                    <Icon name="close" />
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="composer-row">
          <button
            class="icon-btn"
            title="Attach pictures"
            aria-label="Attach pictures"
            disabled={!!blocked() || images().length >= MAX_IMAGES}
            onClick={() => picker.click()}
          >
            <Icon name="attach" />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              attach([...(e.currentTarget.files ?? [])])
              e.currentTarget.value = ""
              field.focus()
            }}
          />
          <Pickers />
          {/* While the agent works and there is nothing to send, Send gives its place to Stop. */}
          <Show
            when={!(busy() && !text().trim() && !images().length)}
            fallback={
              <button class="btn stop-btn" title="Stop the agent" onClick={() => act("stop")}>
                <Icon name="stop" />
                Stop
              </button>
            }
          >
          <button
            class="icon-btn send"
            title={busy() ? `Send when it's free (${keys("enter")})` : `Send (${keys("enter")})`}
            aria-label="Send"
            disabled={!text().trim() || !!blocked()}
            onClick={() => {
              send(false)
              field.focus()
            }}
          >
            <Icon name="send" />
          </button>
          </Show>
        </div>
        <Show when={dropping()}>
          <div class="composer-drop" aria-hidden="true">
            <Icon name="attach" />
            Drop pictures to attach them
          </div>
        </Show>
      </div>
      {/* Shown above the box (CSS order) and only while there is a hint, so the box stays at the
          bottom of the panel and no empty line is kept under it. */}
      <div class="composer-hints" role="status">
        <Show
          when={hint()}
          fallback={
            <Show when={busy() && !blocked() && keysUsed() < KEYS_TAUGHT}>
              <p class="composer-hint composer-keys">
                <Kbd keys={keys("enter")} /> waits its turn<span class="composer-keys-gap" />
                <Kbd keys={keys("mod", "enter")} /> interrupts now
              </p>
            </Show>
          }
        >
          <p class="composer-hint">{hint()}</p>
        </Show>
      </div>
      <Show when={blind()}>
        <p class="composer-hint">This model cannot see screenshots, so notes reach it as text only.</p>
      </Show>
    </div>
  )
}

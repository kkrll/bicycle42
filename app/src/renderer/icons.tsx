// Every icon in the app: stroked paths on a 24 grid, drawn at 16 or 20. One component, one table,
// so there is no icon font, no glyph character and no per-icon file.
import { For, Show, createEffect, type JSX } from "solid-js"
import type { AgentKind } from "../shared/types"

const PATHS = {
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  reload: "M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5",
  spinner: "M12 3a9 9 0 1 0 9 9",
  panel: "M4 5h16v14H4zM9.5 5v14",
  // The page as a desktop's, and as a phone's: a screen on its stand, a handset with its home line.
  desktop: "M3 5h18v11H3zM8.5 20h7M12 16v4",
  // The page's design system: three swatches and a round one.
  tokens: "M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM16.75 13.5a3.25 3.25 0 1 1 0 6.5 3.25 3.25 0 0 1 0-6.5z",
  phone: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM10.5 18h3",
  server: "M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01",
  down: "M6 9l6 6 6-6",
  right: "M9 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  // Send is the key that sends: ↵, the same drawing as on the keys.
  send: "M20 5v6a4 4 0 0 1-4 4H4M8.5 10.5L4 15l4.5 4.5",
  stop: "M7 7h10v10H7z",
  pencil: "M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1zM14.5 6.5l3 3",
  terminal: "M4 5h16v14H4zM8 10l3 2.5L8 15M13 15h3",
  file: "M7 3h7l4 4v14H7zM14 3v4h4",
  download: "M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM16 16l4.5 4.5",
  globe: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z",
  tool: "M14.5 6.5a4 4 0 0 0 5 5L11 20a2.1 2.1 0 0 1-3-3l8.5-8.5a4 4 0 0 0-2-2z",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 4l9 16H3zM12 10v4.5M12 17.5h.01",
  folder: "M3 6h6l2 2.5h10V19H3z",
  jump: "M12 5v14M6 13l6 6 6-6",
  thought: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
  up: "M6 15l6-6 6 6",
  pin: "M9 4h6l-1 6 3 3v2H7v-2l3-3zM12 15v6",
  branch: "M7 5v14M17 5v3a5 5 0 0 1-5 5H7",
  flag: "M6 21V4M6 5h11l-2 4 2 4H6",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v5M14 11v5",
  archive: "M4 5h16v4H4zM6 9v10h12V9M10 13h4",
  restore: "M4 5h16v4H4zM6 9v10h12V9M12 17v-5M9.5 14.5L12 12l2.5 2.5",
  attach: "M19 11.5l-7.4 7.4a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3 3 0 0 1 4.3 4.3l-7.8 7.8a1.5 1.5 0 0 1-2.1-2.1L14.5 7.5",
  copy: "M9 9h11v11H9zM15 9V4H4v11h5",
  skill: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6",
  agent: "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 21a7.5 7.5 0 0 1 15 0",
  slash: "M15 4L9 20",
  gauge: "M4.5 17a8.5 8.5 0 1 1 15 0M12 13.5l3.5-4.5M12 15a1.5 1.5 0 1 0 0-3",
  mode: "M4 7h10M18 7h2M4 17h2M10 17h10M16 4.5v5M8 14.5v5",
  // The settings: a gear of six teeth (eight blur to a ring at 16 px).
  gear: "M9.99 5.82L10.28 3.17L13.72 3.17L14.01 5.82A6.5 6.5 0 0 1 16.35 7.17L18.79 6.1L20.51 9.07L18.36 10.65A6.5 6.5 0 0 1 18.36 13.35L20.51 14.93L18.79 17.9L16.35 16.83A6.5 6.5 0 0 1 14.01 18.18L13.72 20.83L10.28 20.83L9.99 18.18A6.5 6.5 0 0 1 7.65 16.83L5.21 17.9L3.49 14.93L5.64 13.35A6.5 6.5 0 0 1 5.64 10.65L3.49 9.07L5.21 6.1L7.65 7.17A6.5 6.5 0 0 1 9.99 5.82zM14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  note: "M4 5h16v11H10.5L6 20v-4H4z",
  // Drawing on the page: a pencil at the end of the line it drew (the plain pencil above is the
  // agent's file edit). Edit mode: a frame with its handles, and the code it turns into.
  draw: "M13 7C11 3.5 5 3.5 4.5 6.5 4 9.5 10.5 9 10.5 12 10.5 14.5 6 13.5 5 16M9 21l1-3.5 8-8a1.77 1.77 0 0 1 2.5 2.5l-8 8zM16.5 11l2.5 2.5",
  frame: "M3.5 3.5h3v3h-3zM15.5 3.5h3v3h-3zM3.5 15.5h3v3h-3zM6.5 5h9M5 6.5v9M17 6.5v4M6.5 17h2M14.5 13.5L11 17l3.5 3.5M17.5 13.5L21 17l-3.5 3.5",
  // Copy to Figma: its mark drawn as the app's icons are (two halves, a half, a dot, a drop). Copy
  // to Paper: its mark, filled (paint, below), two Ls locked together: its 39 square drawn at 15, as tall as Figma's mark, from 4.5.
  figma: "M12 4.5H9.5a2.5 2.5 0 0 0 0 5H12zM12 4.5h2.5a2.5 2.5 0 0 1 0 5H12zM12 9.5H9.5a2.5 2.5 0 0 0 0 5H12zM17 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM12 14.5H9.5a2.5 2.5 0 1 0 2.5 2.5z",
  paper: "M6.81 4.5H19.5V13.73H13.73V6.81H6.81ZM4.5 6.81H6.81V13.73H13.73V19.5H4.5Z",
  // Motion mode, and a motion note: a ball, and the lines it leaves behind.
  motion: "M16.5 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zM3 9.5h6.5M1.5 12h7M3 14.5h6.5",
  sound: "M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10",
  muted: "M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9.5l5 5M21 9.5l-5 5",
  // The facts pane's marks on the page: a viewfinder's corners around what is marked.
  marks: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M10 10h4v4h-4z",
  // A note that is lost: the same corners, and no element in them.
  lost: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M10 10l4 4M14 10l-4 4",
} as const

export type IconName = keyof typeof PATHS

/** Icons drawn as a filled shape: stop's square with the stroke around it, Paper's mark as its own
 *  shape exactly (no stroke, which would round its corners and fatten it). */
const paint = (name: IconName) =>
  name === "paper" ? { fill: "currentColor", stroke: "none" } : { fill: name === "stop" ? "currentColor" : "none", stroke: "currentColor" }

/** Every spinner turns in step with every other: its turn is counted from the start of the
 *  document's timeline, not from when it came. Two side by side (a turn at work, a tool it runs)
 *  are one rhythm, never two out of phase. */
function inStep(el: Element, again = true) {
  const turning = el.getAnimations()
  for (const a of turning) a.startTime = 0
  // (Not drawn yet, it has no animation: it is put in step on the next frame.)
  if (!turning.length && again) requestAnimationFrame(() => inStep(el, false))
}

/** `spin` turns any icon (the thought, say) while something is under way; the spinner always does. */
export function Icon(props: { name: IconName; size?: 16 | 20 | 24; class?: string; spin?: boolean }): JSX.Element {
  const size = () => props.size ?? 16
  const spinning = () => props.spin ?? props.name === "spinner"
  let el!: SVGSVGElement
  createEffect(() => spinning() && inStep(el))
  return (
    <svg
      ref={el}
      class={props.class}
      classList={{ icon: true, spin: spinning() }}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill={paint(props.name).fill}
      stroke={paint(props.name).stroke}
      stroke-width={size() === 16 ? 2 : 1.75}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[props.name]} />
    </svg>
  )
}

/** The same drawing as <Icon>, for markup built outside Solid (a code block's Copy). */
export function iconElement(name: IconName, size: 16 | 20 | 24 = 16): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg"
  const svg = document.createElementNS(ns, "svg")
  const attrs: Record<string, string> = {
    class: "icon",
    width: String(size),
    height: String(size),
    viewBox: "0 0 24 24",
    ...paint(name),
    "stroke-width": size === 16 ? "2" : "1.75",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v)
  const path = document.createElementNS(ns, "path")
  path.setAttribute("d", PATHS[name])
  svg.append(path)
  return svg
}

// ── the agents' marks ──────────────────────────────────────────────────────────────────────────
// Filled, one colour (currentColor), on the same 24 grid. Path data from simple-icons (CC0):
// claude, googlegemini and opencode from 16.38.0; OpenAI's, for Codex, from 15.0.0 (16 left it
// out). A custom ACP agent is a terminal, drawn like the other icons.

const MARKS = {
  claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  codex: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  gemini: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  opencode: "M22 24H2V0h20zM17 4.8H7v14.4h10z",
} as const

/** Which mark an agent has: one of the four known agents', a terminal for any other command,
 *  the server icon while it is not known. */
export function AgentMark(props: { kind?: AgentKind; size?: 16 | 20; class?: string }): JSX.Element {
  const size = () => props.size ?? 16
  const d = () => {
    const k = props.kind
    return k && k in MARKS ? MARKS[k as keyof typeof MARKS] : undefined
  }
  return (
    <Show when={d()} fallback={<Icon name={props.kind === "custom" ? "terminal" : "server"} size={size()} class={`mark ${props.class ?? ""}`} />}>
      {(path) => (
        <svg class={`mark ${props.class ?? ""}`} width={size()} height={size()} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d={path()} />
        </svg>
      )}
    </Show>
  )
}

// The Mac's key symbols, drawn: neither face we ship has them, and the fallback fonts draw them
// as specks next to the letters. Same 24 grid and stroke as the icons, sized to the capitals.
const KEY_PATHS: Record<string, { d: string; name: string }> = {
  "⌘": { name: "Command", d: "M9 9V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" },
  "⇧": { name: "Shift", d: "M12 4l8 8h-4.5v8h-7v-8H4z" },
  "⌥": { name: "Option", d: "M3 5h5.5l7 14H21M14.5 5H21" },
  "↵": { name: "Return", d: "M20 5v6a4 4 0 0 1-4 4H4M8.5 10.5L4 15l4.5 4.5" },
  "↑": { name: "Up", d: "M12 19V5M6 11l6-6 6 6" }, // kkrll-ignore: the key's name in this table; Kbd draws it as the path beside it, not as type
  "↓": { name: "Down", d: "M12 5v14M6 13l6 6 6-6" }, // kkrll-ignore: the key's name in this table; Kbd draws it as the path beside it, not as type
}

/** A key or a chord, "⌘⇧M" or "Ctrl+Enter": symbols drawn, everything else as type. */
export function Kbd(props: { keys: string }): JSX.Element {
  const parts = () => props.keys.split(/([⌘⇧⌥↵↑↓])/).filter(Boolean)
  return (
    <kbd>
      <For each={parts()}>
        {(p) =>
          KEY_PATHS[p] ? (
            <svg /* kkrll-ignore: a key symbol is a letter of 12px type, not an icon; it stands as tall as the capitals */
              class="key-glyph"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-label={KEY_PATHS[p].name}
              role="img"
            >
              <path d={KEY_PATHS[p].d} />
            </svg>
          ) : (
            <span>{p}</span>
          )
        }
      </For>
    </kbd>
  )
}

/** Which icon stands for a tool, from its backend name. Unknown tools get the generic one. */
export function toolIcon(name: string): IconName {
  const n = name.toLowerCase()
  if (/edit|write|patch/.test(n)) return "pencil"
  if (/bash|shell|exec|run/.test(n)) return "terminal"
  if (/grep|glob|search|find|ls|list/.test(n)) return "search"
  if (/read|view|open/.test(n)) return "file"
  if (/web|fetch|http/.test(n)) return "globe"
  if (/todo|task|plan/.test(n)) return "list"
  return "tool"
}

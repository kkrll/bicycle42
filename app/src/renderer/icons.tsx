// Every icon in the app: stroked paths on a 24 grid, drawn at 16 or 20. One component, one table,
// so there is no icon font, no glyph character and no per-icon file.
import { For, type JSX } from "solid-js"

const PATHS = {
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  reload: "M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5",
  spinner: "M12 3a9 9 0 1 0 9 9",
  panel: "M4 5h16v14H4zM14.5 5v14",
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
  attach: "M19 11.5l-7.4 7.4a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3 3 0 0 1 4.3 4.3l-7.8 7.8a1.5 1.5 0 0 1-2.1-2.1L14.5 7.5",
  copy: "M9 9h11v11H9zM15 9V4H4v11h5",
  skill: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6",
  agent: "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 21a7.5 7.5 0 0 1 15 0",
  slash: "M15 4L9 20",
  gauge: "M4.5 17a8.5 8.5 0 1 1 15 0M12 13.5l3.5-4.5M12 15a1.5 1.5 0 1 0 0-3",
  mode: "M4 7h10M18 7h2M4 17h2M10 17h10M16 4.5v5M8 14.5v5",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  note: "M4 5h16v11H10.5L6 20v-4H4z",
  // Drawing on the page: a pencil at the end of the line it drew (the plain pencil above is the
  // agent's file edit). Edit mode: a frame with its handles, and the code it turns into.
  draw: "M13 7C11 3.5 5 3.5 4.5 6.5 4 9.5 10.5 9 10.5 12 10.5 14.5 6 13.5 5 16M9 21l1-3.5 8-8a1.77 1.77 0 0 1 2.5 2.5l-8 8zM16.5 11l2.5 2.5",
  frame: "M3.5 3.5h3v3h-3zM15.5 3.5h3v3h-3zM3.5 15.5h3v3h-3zM6.5 5h9M5 6.5v9M17 6.5v4M6.5 17h2M14.5 13.5L11 17l3.5 3.5M17.5 13.5L21 17l-3.5 3.5",
  sound: "M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10",
  muted: "M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9.5l5 5M21 9.5l-5 5",
} as const

export type IconName = keyof typeof PATHS

/** `spin` turns any icon (the thought, say) while something is under way; the spinner always does. */
export function Icon(props: { name: IconName; size?: 16 | 20 | 24; class?: string; spin?: boolean }): JSX.Element {
  const size = () => props.size ?? 16
  return (
    <svg
      class={props.class}
      classList={{ icon: true, spin: props.spin ?? props.name === "spinner" }}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill={props.name === "stop" ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width={size() === 16 ? 2 : 1.75}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[props.name]} />
    </svg>
  )
}

// The Mac's key symbols, drawn: neither face we ship has them, and the fallback fonts draw them
// as specks next to the letters. Same 24 grid and stroke as the icons, sized to the capitals.
const KEY_PATHS: Record<string, { d: string; name: string }> = {
  "⌘": { name: "Command", d: "M9 9V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" },
  "⇧": { name: "Shift", d: "M12 4l8 8h-4.5v8h-7v-8H4z" },
  "⌥": { name: "Option", d: "M3 5h5.5l7 14H21M14.5 5H21" },
  "↵": { name: "Return", d: "M20 5v6a4 4 0 0 1-4 4H4M8.5 10.5L4 15l4.5 4.5" },
}

/** A key or a chord, "⌘⇧M" or "Ctrl+Enter": symbols drawn, everything else as type. */
export function Kbd(props: { keys: string }): JSX.Element {
  const parts = () => props.keys.split(/([⌘⇧⌥↵])/).filter(Boolean)
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

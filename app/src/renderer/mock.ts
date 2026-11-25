// A stand-in for main, for working on the window without Electron's other half and for the
// screenshots (scripts/shot.mjs). Loaded only when `window.b42` is missing or the address has
// ?mock; it is its own chunk, so the real app never downloads it.
//
//   ?mock=connect | empty | folder | fresh | review | busy | permission | question |
//         noconversation | nocommands | offline | pageerror | stress | stress-code
//   &context=0.62 fills the conversation's context that far, for the meter in the message box
//
// It behaves enough like main to click through: commands change the state, sending a message
// streams a reply, and the "page" is a painted box placed by setPageBounds exactly as the native
// view would be (so a wrong rectangle shows up in a screenshot).
import type {
  AgentKind,
  ModelRef,
  ServerInfo,
  AppState,
  Bridge,
  ChatAssistant,
  ChatEvent,
  ChatItem,
  ChatUser,
  CommandName,
  Commands,
  FileChange,
  LocalAgent,
  MentionOption,
  NoteRow,
  PanelAct,
  PanelMessage,
  PromptFile,
  Rect,
  SendOptions,
  SessionSummary,
  Shortcut,
  SlashCommand,
} from "../shared/types"
import { PHONE, phoneEdge, phoneOf, type PhoneSurround } from "../shared/types"
import { canvasView } from "./mock-canvas"
import { setFocusedNote } from "./store"
import type { MotionView } from "../../../overlay/protocol-motion"
import type { FactsView } from "../../../overlay/protocol-facts"
import type { Token, TokensView } from "../../../overlay/protocol-tokens"

const SESSION = "s-main"
const ORIGIN = "http://localhost:3000"
const HOUR = 3_600_000
const DIRECTORY = "/home/dev/code/acme/storefront"

const PATCH_HERO = `--- a/src/components/Hero.tsx
+++ b/src/components/Hero.tsx
@@ -12,9 +12,9 @@ export function Hero({ title, lead }: HeroProps) {
   return (
-    <section className="hero pl-4">
+    <section className="hero pl-8">
       <h1 className="hero-title">{title}</h1>
-      <p className="hero-lead">{lead}</p>
+      <p className="hero-lead max-w-prose">{lead}</p>
       <Button variant="primary">Start free</Button>
     </section>
   )
`

const PATCH_NAV = `--- a/src/components/marketing/navigation/PrimaryNavigation.tsx
+++ b/src/components/marketing/navigation/PrimaryNavigation.tsx
@@ -31,7 +31,7 @@ export function PrimaryNavigation() {
       <Logo />
-      <ul className="nav-links">
+      <ul className="nav-links hidden md:flex">
         {links.map((link) => (
           <NavLink key={link.href} {...link} />
         ))}
`

const change = (file: string, patch: string): FileChange => ({
  file,
  patch,
  additions: (patch.match(/^\+(?!\+\+)/gm) ?? []).length,
  deletions: (patch.match(/^-(?!--)/gm) ?? []).length,
})

const REPLY = `I changed two things:

1. The hero's left padding is now \`pl-8\`, which lines it up with the navigation above it.
2. The lead paragraph is capped at a readable width, so it no longer runs under the illustration.

The footer links were already correct. If you want the same spacing on the pricing cards, the class to change is in \`PricingCard.tsx\`:

\`\`\`tsx
<article className="card pl-8 pr-6">
  {children}
</article>
\`\`\`

See the [Tailwind spacing scale](https://tailwindcss.com/docs/padding) for the other steps.`

// ── the message box: commands and things to mention ─────────────────────────────────────────────

const COMMANDS: SlashCommand[] = [
  // The app's own, as main lists them.
  { name: "compact", description: "Summarise the conversation to free up context", builtin: true },
  { name: "new", description: "Start a new conversation", builtin: true },
  { name: "undo", description: "Take back your last message and what the agent did after it", builtin: true },
  { name: "redo", description: "Bring back what /undo took away", builtin: true },
  { name: "rename", description: "Name this conversation: /rename new name", builtin: true },
  { name: "fork", description: "Go on in a copy of this conversation", builtin: true },
  // The agent's, for the site's folder.
  { name: "review", description: "Look over the changes since the last commit" },
  { name: "test", description: "Run the tests and fix what fails" },
  { name: "explain", description: "Explain how a part of the site works" },
  { name: "init", description: "Write an AGENTS.md that describes this project" },
]

/** What the agent says while it is still at work (the busy scenario). */
const WORKING = `The heading and its paragraph sit 32px apart, while the cards below use 16px. I'm changing the hero's \`mb-8\` to \`mb-4\` so the two match.

While that reloads, I'm checking the mobile layout, where the cards stack. The [Tailwind breakpoints](https://tailwindcss.com/docs/responsive-design) put the switch at \`md\`, which matches the navigation.

After that, the cards' own spacing is next in line.`

/** The answer to a message sent with mod+Enter while the agent was busy. */
const STEERED = `Switching to that now. I've left the card order as it was and moved on to the green: the primary buttons use \`brand-600\`, the same token as the logo.`

const COMMAND_REPLY: Record<string, string> = {
  review: "I looked over the **3 files** changed since the last commit:\n\n- `Hero.tsx`: the padding change is consistent with the navigation.\n- `PrimaryNavigation.tsx`: hidden below `md`, as asked.\n- `Footer.tsx`: one unused variable, `year`. Worth removing.",
  test: "Ran `npm test`: **42 passed**, none failed. Nothing to fix.",
  explain: "The pricing page is `src/pages/pricing.tsx`. It renders three `PricingCard`s from `src/data/plans.ts`; the highlighted card is the one with `featured: true`.",
  undo: "Put back `src/components/Hero.tsx` as it was before my last edit.",
  compact: "Summarised the conversation so far. Earlier messages are folded into that summary.",
  init: "Wrote `AGENTS.md` with the build and test commands, the folder layout and the styling conventions (Tailwind, no CSS modules).",
}

const FILES = [
  "src/components/Hero.tsx",
  "src/components/Header.tsx",
  "src/components/Footer.tsx",
  "src/components/Button.tsx",
  "src/components/PricingCard.tsx",
  "src/components/marketing/navigation/PrimaryNavigation.tsx",
  "src/pages/index.tsx",
  "src/pages/pricing.tsx",
  "src/data/plans.ts",
  "src/styles/globals.css",
  "tailwind.config.ts",
  "public/logo.svg",
]
const FOLDERS = ["src/components", "src/pages", "src/styles", "public"]

const SKILLS: MentionOption[] = [
  { kind: "skill", id: "frontend-design", label: "frontend-design", detail: "Distinctive, intentional visual design" },
  { kind: "skill", id: "accessibility", label: "accessibility", detail: "Contrast, focus order and labels" },
  { kind: "skill", id: "copy-editing", label: "copy-editing", detail: "Tightens interface copy" },
]
const AGENTS: MentionOption[] = [
  { kind: "agent", id: "explore", label: "explore", detail: "Reads the code to answer a question" },
  { kind: "agent", id: "general", label: "general", detail: "Takes on a multi-step task by itself" },
]

/** Letters of `query` in order inside `text`, like a file finder. */
// The known agents' adapters as main pins them (agents.ts); "Always the newest" turned on here.
const mockLatest = new Set<string>()
function mockAgent(id: string, latest: boolean): LocalAgent {
  const [name, pkg, version, tested] = id === "codex" ? ["Codex", "@agentclientprotocol/codex-acp", "2.9.0", false] : ["Claude Code", "@agentclientprotocol/claude-agent-acp", "0.109.1", true]
  const v = latest ? "latest" : version
  return { id, name, command: `npx -y ${pkg}@${v}`, installed: true, adapter: { version: v, tested: !latest && tested, latest, own: false } }
}

const fuzzy = (text: string, query: string) => {
  let at = 0
  for (const ch of text.toLowerCase()) if (ch === query[at]) at++
  return at === query.length
}

function mentionOptions(query: string): MentionOption[] {
  const q = query.toLowerCase()
  if (!q) return [...SKILLS, ...AGENTS]
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1)
  const files: MentionOption[] = [
    ...FOLDERS.filter((f) => fuzzy(f, q)).map((f): MentionOption => ({ kind: "folder", id: f, label: `${base(f)}/` })),
    ...FILES.filter((f) => fuzzy(f, q)).map((f): MentionOption => ({ kind: "file", id: f, label: base(f) })),
  ].sort((a, b) => Number(!a.label.toLowerCase().includes(q)) - Number(!b.label.toLowerCase().includes(q)))
  return [...files, ...[...SKILLS, ...AGENTS].filter((o) => fuzzy(o.id, q))].slice(0, 20)
}

/** A stand-in screenshot: a small drawn rectangle as a data: URL (the window's CSP allows no
 *  other image source). */
function thumb(hue: number): string {
  const c = document.createElement("canvas")
  c.width = 192
  c.height = 80
  const g = c.getContext("2d")!
  g.fillStyle = `hsl(${hue} 20% 94%)`
  g.fillRect(0, 0, 192, 80)
  g.fillStyle = `hsl(${hue} 25% 80%)`
  g.fillRect(12, 14, 90, 12)
  g.fillRect(12, 34, 150, 6)
  g.fillRect(12, 46, 120, 6)
  g.fillStyle = `hsl(${hue} 45% 45%)`
  g.fillRect(12, 60, 44, 12)
  return c.toDataURL("image/png")
}

function notes(): NoteRow[] {
  const row = (n: number, text: string, status: NoteRow["status"], extra: Partial<NoteRow> = {}): NoteRow => ({
    id: `n${n}`,
    n,
    text,
    status,
    lane: "main",
    // A conversation has taken every note that waits, is worked on or is done.
    ...(status === "queued" || status === "working" || status === "done" ? { sent: true as const, session: extra.lane === "bg" ? "s-bg" : SESSION } : {}),
    ...extra,
  })
  return [
    row(1, "pl-8", "done", { pictures: "both" }),
    row(2, "hide on mobile", "done", { pictures: "before", takenBack: "asked" }),
    row(3, "make this the primary button style", "done", { pictures: "both" }),
    row(4, "too much space between the heading and the paragraph, should match the cards below", "working"),
    row(5, "swap these two", "queued", { lost: true }),
    row(6, "logo is blurry on retina", "failed", { error: "The agent stopped answering (timeout after 30 s)." }),
    row(7, "use the brand green here", "queued", { lost: true }),
    row(8, "align with the grid", "working", { lane: "bg" }),
    row(9, "this link goes nowhere", "queued", { lane: "bg" }),
    row(10, "tighter", "queued"),
    row(11, "copy: “Start free” not “Get started”", "sending"),
    row(12, "round these corners like the cards", "capturing"),
  ]
}

/** The same list with two canvas notes in it: one the reviewer put words to, one named by its
 *  edits. (`?mock=canvas`; the first one's pin counts as clicked, so its edits are listed.) */
function canvasNotes(): NoteRow[] {
  const list = notes()
  list[4] = {
    ...list[4]!,
    text: "pricing first, and give the cards room",
    edits: [
      'Moved "Card · Pricing" to before "Card · Features" in "Section · Plans" (flex row), from position 2 to 1.',
      'Gap in "Section · Plans": 16px → 32px.',
      '"Heading · Simple pricing": width 320px → 400px.',
    ],
  }
  list[6] = {
    ...list[6]!,
    text: '4 canvas edits: styled "Card · Pricing", classes of "Link · Docs", removed "Badge · New", 1 new CSS rule',
    edits: [
      'Styled "Card · Pricing": padding-top: 16px → 24px; gap: 16px → 32px.',
      '"Link · Docs": class "docs" → "docs bg-stripes".',
      'Removed "Badge · New".',
      "1 new CSS rule.",
    ],
  }
  return list
}

function transcript(): ChatItem[] {
  const t = Date.now() - 6 * 60_000
  const user = (id: string, n: number, text: string, extra: Partial<ChatUser> = {}): ChatUser => ({
    kind: "user",
    id,
    time: t,
    text: `Review note ${n}\n\n${text}\n\n[element: section.hero > h1, 1440x900, screenshot attached]`,
    images: [
      { name: "element.png", src: thumb(260) },
      { name: "page.png", src: thumb(30) },
    ],
    note: { n, text },
    ...extra,
  })
  return [
    user("u1", 1, "pl-8"),
    {
      kind: "assistant",
      id: "a1",
      time: t,
      done: true,
      parts: [
        {
          kind: "reasoning",
          key: "r1",
          text: "The note points at the hero section. It currently has pl-4; the reviewer wants pl-8.\nThe lead paragraph also overflows at this width, worth capping while I am here.",
        },
        { kind: "tool", key: "t1", name: "read", status: "done", title: "read src/components/Hero.tsx", detail: "42 lines" },
        {
          kind: "tool",
          key: "t2",
          name: "edit",
          status: "done",
          title: "edit src/components/Hero.tsx",
          changes: [change("src/components/Hero.tsx", PATCH_HERO)],
        },
        { kind: "text", key: "x1", text: "The hero now uses `pl-8`, and its lead paragraph is capped at a readable width." },
      ],
    },
    user("u2", 2, "hide on mobile"),
    {
      kind: "assistant",
      id: "a2",
      time: t,
      done: true,
      parts: [
        {
          kind: "tool",
          key: "t1",
          name: "edit",
          status: "done",
          title: "edit src/components/marketing/navigation/PrimaryNavigation.tsx",
          changes: [change("src/components/marketing/navigation/PrimaryNavigation.tsx", PATCH_NAV)],
        },
        {
          kind: "tool",
          key: "t2",
          name: "bash",
          status: "error",
          title: "run npm run lint",
          detail: "> acme-store@0.4.0 lint\n> eslint src\n\nsrc/components/Footer.tsx\n  18:7  error  'year' is assigned a value but never used  no-unused-vars\n\n1 problem (1 error, 0 warnings)",
          error: "Exit code 1",
        },
        {
          kind: "text",
          key: "x1",
          text: "The navigation links are hidden below the `md` breakpoint.\n\nLint reports one **unrelated** error in `Footer.tsx` (an unused variable). I left it alone:\n\n- it predates this review\n- fixing it changes the copyright line",
        },
      ],
    },
    { kind: "marker", id: "m1", time: t, text: "Model changed to Sonnet 4.5", tone: "info" },
    { kind: "user", id: "u3", time: t, text: "Can you also check that the footer links still line up?", images: [] },
    {
      kind: "assistant",
      id: "a3",
      time: t,
      done: true,
      parts: [{ kind: "text", key: "x1", text: "They do. The footer links share the navigation's grid, so the hero change moved them too." }],
    },
    user("u-n3", 3, "make this the primary button style"),
    {
      kind: "assistant",
      id: "a-n3",
      time: t,
      done: true,
      parts: [
        { kind: "tool", key: "t1", name: "edit", status: "done", title: "edit src/components/Hero.tsx" },
        { kind: "text", key: "x1", text: "The button uses the `primary` variant now, like the one in the header." },
      ],
    },
    // Note 4 is the one the agent is working on (see notes()), and 5, 7 and 10 wait their turn.
    user("u-n4", 4, "too much space between the heading and the paragraph, should match the cards below"),
    {
      kind: "assistant",
      id: TURN,
      time: t,
      done: false,
      parts: [
        { kind: "tool", key: "t1", name: "read", status: "done", title: "read src/components/Hero.tsx", detail: "42 lines" },
        { kind: "tool", key: "t2", name: "grep", status: "running", title: "search gap- in src/components" },
      ],
    },
    user("u-n5", 5, "swap these two", { pending: true, images: [{ name: "element.png", src: thumb(120) }] }),
    user("u-n7", 7, "use the brand green here", { pending: true, images: [] }),
    user("u-n10", 10, "tighter", { pending: true, images: [] }),
  ]
}

/** The turn in progress when the mock starts. */
const TURN = "a-n4"

/** What the agent answers to each waiting note, when its turn comes. */
const NOTE_REPLY: Record<number, string> = {
  5: "Swapped the two cards. Their order comes from `src/data/plans.ts`, so it was a one-line change.",
  7: "The button uses `brand-600` now, the same green as the logo.",
  10: "Tightened the gap between the cards from `gap-6` to `gap-4`.",
}

/** What `opencode acp` offered in the incident this was made for (Nov 2026): two providers with
 *  a model of one name (one of them with a key that no longer works), and OpenCode's own free
 *  models, some of them text only and one an alpha, its default. As main names them (acp.ts:
 *  modelList): no provider before the name, no "Free" after it, the labels apart. */
const OPENCODE_MODELS: AppState["models"] = [
  { providerID: "claude-agent", id: "claude-agent/opus", name: "Opus 5.5", images: true, variants: ["low", "medium", "high"] },
  { providerID: "claude-agent", id: "claude-agent/sonnet", name: "Sonnet 5.5", images: true, variants: ["low", "medium", "high"] },
  { providerID: "kimi-code-plan-global", id: "kimi-code-plan-global/k3.1-pro", name: "Kimi K3.1 Pro", images: true, variants: ["low", "medium", "high"] },
  { providerID: "kimi-code-plan-global", id: "kimi-code-plan-global/k3", name: "Kimi K3", images: true, variants: [] },
  { providerID: "moonshotai", id: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1 Pro", images: true, variants: ["low", "medium", "high"] },
  { providerID: "moonshotai", id: "moonshotai/kimi-k3", name: "Kimi K3", images: true, variants: [] },
  { providerID: "opencode", id: "opencode/big-pickle", name: "Big Pickle", images: false, variants: [], tags: ["free"] },
  { providerID: "opencode", id: "opencode/deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash", images: true, variants: [], tags: ["free"] },
  { providerID: "opencode", id: "opencode/tidepool-alpha-free", name: "Tidepool Alpha", images: false, variants: ["low", "medium", "high"], tags: ["free", "alpha"] },
]

/** `&agent=claude` (or codex, gemini, opencode, custom) in the address: that agent on this
 *  computer, over ACP, with the models it says; `&agent` alone is Claude Code. Without it, Claude
 *  Code on dev-box, over ssh. */
function agentOf(): { connection: AppState["connection"]; harness: AppState["harness"]; models?: AppState["models"]; model?: ModelRef } {
  const q = new URLSearchParams(location.search)
  if (!q.has("agent")) return { connection: { status: "online", url: "acp://claude@dev-box", version: "0.12.0" }, harness: { kind: "claude", name: "Claude Code", here: false, host: "dev-box" } }
  const id = q.get("agent") || "claude"
  if (id === "custom") return { connection: { status: "online", url: "acp://custom-1a2b3c4d", version: "0.3.0" }, harness: { kind: "custom", name: "my-agent", here: true } }
  const name = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", opencode: "OpenCode" }[id] ?? id
  // What each says in its session's options: Claude Code's ids are plain words, grouped under
  // the agent's name; Codex's carry the effort after a "/".
  const models: AppState["models"] =
    id === "opencode"
      ? OPENCODE_MODELS
      : id === "claude"
      ? [
          // Its "Default (recommended)" names the model it is (acp.ts: models).
          { providerID: name, id: "default", name: "Default · Opus 5.5", images: true, variants: [] },
          { providerID: name, id: "opus", name: "Opus 5.5", images: true, variants: [] },
          { providerID: name, id: "sonnet", name: "Sonnet 5.5", images: true, variants: [] },
          { providerID: name, id: "haiku", name: "Haiku 5.5", images: true, variants: [] },
        ]
      : [
          { providerID: name, id: "gpt-5.1-codex", name: "gpt-5.1-codex", images: true, variants: ["low", "medium", "high"] },
          { providerID: name, id: "gpt-5.1-codex-mini", name: "gpt-5.1-codex-mini", images: true, variants: ["medium", "high"] },
        ]
  return {
    connection: { status: "online", url: `acp://${id}`, version: "0.12.0" },
    harness: { kind: id as AgentKind, name, here: true },
    models,
    // &model=moonshotai/kimi-k3.1-pro: the conversation is on that one. OpenCode's starts on its
    // own default, as it did in the incident.
    model: (() => {
      const m = models.find((x) => x.id === (q.get("model") ?? (id === "opencode" ? "opencode/tidepool-alpha-free" : models[0]!.id))) ?? models[0]!
      return { providerID: m.providerID, id: m.id, ...(id === "claude" ? {} : { variant: "medium" }) }
    })(),
  }
}

function base(): AppState {
  const now = Date.now()
  const agent = agentOf()
  return {
    connection: agent.connection,
    harness: agent.harness,
    home: "/home/dev",
    page: { url: `${ORIGIN}/pricing`, loading: false, canGoBack: true, canGoForward: false, hmr: false, device: "desktop", phone: PHONE.id },
    review: { enabled: true, mode: "notes", brush: false, autoReload: true, notes: notes(), unplaced: 2, docks: [] },
    capture: { on: ["figma", "paper"] },
    site: { origin: ORIGIN, directory: DIRECTORY },
    repo: {
      branch: "pricing-polish",
      changes: [
        { file: "src/components/pricing/PlanCard.tsx", additions: 3, deletions: 2, status: "modified" },
        { file: "src/styles/buttons.css", additions: 4, deletions: 0, status: "modified" },
        { file: "src/components/pricing/Faq.tsx", additions: 18, deletions: 0, status: "added" },
      ],
      total: 3,
    },
    session: { id: SESSION, title: "Pricing page review", updated: now, busy: false, agent: "build", directory: DIRECTORY, ...(agent.model ? { model: agent.model } : {}) },
    sessions: [
      { id: "s-3", title: "Homepage spacing", updated: now - 26 * HOUR, busy: false, directory: DIRECTORY, pinned: true, notes: 4, said: "more air under the hero\nthe logos row is too tight" },
      { id: SESSION, title: "Pricing page review", updated: now, busy: false, directory: DIRECTORY, notes: 7, said: "make this button bigger\nalign the plan cards" },
      { id: "s-2", title: "Checkout: mobile pass with a deliberately long title that has to be cut", updated: now - 2 * HOUR, busy: true, directory: DIRECTORY, notes: 1, said: "the pay button is under the keyboard" },
      { id: "s-4", title: "Dark mode contrast", updated: now - 12 * 24 * HOUR, busy: false, directory: DIRECTORY },
    ],
    models: agent.models ?? [
      { providerID: "anthropic", id: "sonnet-4-5", name: "Sonnet 4.5", images: true, variants: ["low", "medium", "high"], context: 200_000 },
      { providerID: "anthropic", id: "haiku-4-5", name: "Haiku 4.5", images: true, variants: [], context: 200_000 },
      { providerID: "openai", id: "gpt-5", name: "GPT-5", images: true, variants: ["minimal", "high"], context: 400_000 },
      { providerID: "local", id: "qwen-coder", name: "Qwen Coder 32B", images: false, variants: [] },
    ],
    agents: [
      { id: "build", name: "Build" },
      { id: "plan", name: "Plan" },
    ],
    defaultModel: agent.model ?? { providerID: "anthropic", id: "sonnet-4-5", variant: "medium" },
    permissions: [],
    questions: [],
    // `&agent` in the address: one that offers no /compact and can't archive. Without, Claude
    // Code on dev-box, which does both.
    can: new URLSearchParams(location.search).has("agent") ? { queue: true, steer: true, fork: true } : { queue: true, steer: true, compact: true, fork: true, archive: true },
  }
}

const TREE: Record<string, string[]> = {
  "/": ["home", "srv", "var"],
  "/home": ["k"],
  "/home/dev": ["code", "notes", "sandbox"],
  "/home/dev/code": ["acme", "blog", "sketches"],
  "/home/dev/code/acme": ["api", "design-tokens", "infrastructure", "marketing-site", "storefront"],
}

// ── the painted page ────────────────────────────────────────────────────────────────────────────
// Neutral greys on purpose: it stands for someone else's site, not for this app's design.

/** `pins`: the review has notes, so their pins are on the page (in Annotate, Edit and Motion:
 *  Preview is the page alone, as the overlay draws it; `[data-pins]` is shown by the bridge). */
function fakePage(pins: boolean): HTMLElement {
  const el = document.createElement("div")
  el.style.cssText =
    "position:fixed;z-index:2147483647;overflow:hidden;display:none;background:Canvas;color:CanvasText;color-scheme:light;font:14px/1.5 system-ui"
  const block = (css: string) => `<div style="${css}"></div>`
  /** A pin as the overlay draws it (overlay/src/styles.css, .pin): the list's badge, on any page:
   *  outlined waits, a thicker outline is being worked on, filled is done, red failed, and a
   *  background note's is filled grey. */
  const pin = (n: number, status: "queued" | "working" | "done" | "failed", x: number, y: number, bg = false) => {
    const ring = status === "failed" ? "#dc2626" : "#171717"
    const fill = status === "done" ? "#171717" : bg ? "#d4d4d4" : "#fff"
    const ink = status === "done" ? "#fff" : status === "failed" ? "#b91c1c" : "#171717"
    return `<div style="position:absolute;left:${x}px;top:${y}px;box-sizing:border-box;min-width:20px;height:20px;padding:0 5px;border-radius:10px;text-align:center;background:${fill};color:${ink};box-shadow:inset 0 0 0 ${status === "working" ? 2 : 1}px ${ring},0 0 0 1px #fff,0 1px 3px rgba(0,0,0,.3);font:700 12px/20px ui-monospace,monospace">${n}</div>`
  }
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:24px;height:56px;padding:0 32px;border-bottom:1px solid GrayText">
      <b>acme</b><span>Product</span><span>Pricing</span><span>Docs</span>
    </div>
    <div style="position:relative;padding:56px 32px;max-width:860px">
      <h1 style="margin:0 0 12px;font-size:40px;line-height:1.1">Simple pricing for teams that ship</h1>
      <p style="margin:0 0 24px;max-width:52ch;opacity:.7">One plan, every feature. Pay for the seats you use and nothing else.</p>
      ${block("width:120px;height:40px;border-radius:8px;background:CanvasText;outline:2px solid var(--accent);outline-offset:3px")}
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:48px">
        ${block("height:180px;border:1px solid GrayText;border-radius:12px").repeat(3)}
      </div>
      <div data-pins>${pins ? pin(1, "done", 12, 44) + pin(4, "working", 12, 104) + pin(5, "queued", 164, 150) + pin(6, "failed", 300, 250) + pin(8, "working", 590, 250, true) : ""}</div>
    </div>`
  document.body.append(el)
  return el
}

// ── the bridge ──────────────────────────────────────────────────────────────────────────────────

export function install(scenario: string, params: URLSearchParams): Bridge {
  const state = base()
  let items: ChatItem[] = transcript()
  const stateFns = new Set<(s: AppState) => void>()
  const chatFns = new Set<(e: ChatEvent) => void>()
  const push = () => {
    const pins = document.querySelector<HTMLElement>("[data-pins]")
    if (pins) pins.hidden = !state.review.enabled
    stateFns.forEach((fn) => fn(structuredClone(state)))
  }
  const emit = (e: ChatEvent) => chatFns.forEach((fn) => fn(e))
  const panelFns = new Set<(m: PanelMessage) => void>()
  const sid = () => state.session?.id ?? ""
  let serial = 0
  /** The conversations put away. */
  let put: SessionSummary[] = [{ id: "s-9", title: "Footer links", updated: Date.now() - 40 * 24 * HOUR, busy: false, directory: DIRECTORY, archived: true }]

  /** Streams `text` into a new assistant item the way the agent does: small deltas over time. */
  function stream(text: string, done: () => void = () => {}, pace = 16) {
    const id = `a-${++serial}`
    const item: ChatAssistant = { kind: "assistant", id, time: Date.now(), done: false, parts: [{ kind: "text", key: "x", text: "" }] }
    emit({ type: "item", session: sid(), item })
    state.session && (state.session.busy = true)
    push()
    let at = 0
    const timer = setInterval(() => {
      // A few words at a time, as a model streams.
      const space = text.indexOf(" ", at + 8)
      const end = space < 0 ? text.length : space + 1
      const chunk = text.slice(at, end)
      at = end
      if (chunk) return emit({ type: "delta", session: sid(), item: id, key: "x", text: chunk })
      clearInterval(timer)
      emit({ type: "item", session: sid(), item: { ...item, done: true, parts: [{ kind: "text", key: "x", text }] } })
      stop = () => {}
      settle()
      done()
      next()
    }, pace)
    stop = (why = "Stopped", proceed = true) => {
      stop = () => {}
      clearInterval(timer)
      emit({ type: "item", session: sid(), item: { ...item, done: true, parts: [{ kind: "text", key: "x", text: text.slice(0, at) }] } })
      emit({ type: "item", session: sid(), item: { kind: "marker", id: `m-${++serial}`, time: Date.now(), text: why, tone: "info" } })
      settle(why === "Redirected" ? "Set aside for your newer message." : "Stopped before it finished.")
      if (proceed) next()
      else push()
    }
  }
  /** Ends the turn in progress with `why` ("Stopped", "Redirected"); `proceed` starts the next. */
  let stop: (why?: string, proceed?: boolean) => void = () => {}

  // ── turns: one at a time, the rest wait. Every count on screen comes from state.review.notes,
  //    so each step below changes the notes and the chat together. ──
  type Waiting = { id: string; n?: number; reply: string }
  const queue: Waiting[] = []
  /** The main-lane note being worked on is finished (or stopped, with the reason). */
  function settle(error?: string) {
    for (const note of state.review.notes)
      if (note.lane === "main" && note.status === "working") {
        if (error) Object.assign(note, { status: "failed", error, stopped: true })
        else note.status = "done"
      }
  }
  /** As main decides it: a note of an idle conversation is restored from the app's snapshots
   *  (here: the newest, and every other one); for any other the agent is asked. */
  function takeBackWay(id: string): "restored" | "asked" {
    const note = state.review.notes.find((n) => n.id === id)
    const newest = state.review.notes.filter((n) => n.session === note?.session && n.status === "done").at(-1)
    const busy = note?.session === state.session?.id ? state.session?.busy : state.sessions.find((s) => s.id === note?.session)?.busy
    return !note || busy ? "asked" : note === newest || note.n % 2 ? "restored" : "asked"
  }
  /** The next waiting message gets its turn, or the agent goes idle. */
  function next() {
    const w = queue.shift()
    if (!w) {
      if (state.session) state.session.busy = false
      push()
      return
    }
    const note = w.n ? state.review.notes.find((x) => x.n === w.n) : undefined
    if (note) note.status = "working"
    emit({ type: "delivered", session: sid(), item: w.id, time: Date.now() })
    stream(w.reply)
  }

  /** A message from the box, the way main delivers it: at once when the agent is free; waiting
   *  for its turn when busy; or, steered, by interrupting what runs now. */
  function deliver(text: string, images: PromptFile[] = [], options: SendOptions = {}, reply = REPLY) {
    const item: ChatUser = {
      kind: "user",
      id: `u-${++serial}`,
      time: Date.now(),
      text,
      images: images.map((f) => ({ name: f.name, src: f.uri })),
      // (What main reads back from its own requests, asks.ts: here there is the one.)
      ...(text.startsWith("Get this project's site running") ? { ask: { title: "Get the site running" } } : {}),
    }
    if (state.session?.busy && options.delivery === "steer") {
      stop("Redirected", false)
      emit({ type: "item", session: sid(), item })
      stream(reply)
      return
    }
    if (state.session?.busy) {
      emit({ type: "item", session: sid(), item: { ...item, pending: true } })
      queue.push({ id: item.id, reply })
      return
    }
    emit({ type: "item", session: sid(), item })
    stream(reply)
  }

  // ?context=0.62: the open conversation's context is that full, of the model's 200k window.
  const full = Number(params.get("context"))
  if (full > 0) state.context = { used: Math.round(full * 200_000), limit: 200_000 }
  switch (scenario) {
    // `&status=manual`: a copy that can't replace itself.
    case "update":
      state.update = { version: "0.2.0", status: params.get("status") === "manual" ? "manual" : "ready" }
      break
    case "connect":
      Object.assign(state, { ...base(), connection: { status: "unconfigured" }, site: null, session: null, sessions: [] })
      // `&retired`: OpenCode servers saved by an earlier version were just put aside.
      if (params.has("retired")) state.serversRetired = true
      delete state.harness
      state.page.url = ""
      state.review.notes = []
      items = []
      break
    case "repo":
      // Connected, a model chosen, nothing else yet: which repo?
      Object.assign(state, { site: null, session: null, sessions: [] })
      state.page = { url: "", loading: false, canGoBack: false, canGoForward: false, hmr: false, device: "desktop", phone: PHONE.id }
      state.review = { enabled: false, mode: "preview", brush: false, autoReload: false, notes: [], unplaced: 0, docks: [] }
      items = []
      break
    case "empty":
      // The repo is open, with its conversation; no page yet.
      Object.assign(state, { site: { origin: "", directory: DIRECTORY } })
      state.page = { url: "", loading: false, canGoBack: false, canGoForward: false, hmr: false, device: "desktop", phone: PHONE.id }
      state.review = { enabled: false, mode: "preview", brush: false, autoReload: false, notes: [], unplaced: 0, docks: [] }
      items = []
      break
    case "folder":
      Object.assign(state, { site: { origin: ORIGIN }, session: null, sessions: [] })
      state.review = { enabled: false, mode: "preview", brush: false, autoReload: false, notes: [], unplaced: 0, docks: [] }
      items = []
      break
    case "model-choice":
      // Just connected to an agent with a long list: which model should conversations start with?
      Object.assign(state, { site: null, session: null, sessions: [] })
      state.page = { url: "", loading: false, canGoBack: false, canGoForward: false, hmr: false, device: "desktop", phone: PHONE.id }
      state.review = { enabled: false, mode: "preview", brush: false, autoReload: false, notes: [], unplaced: 0, docks: [] }
      state.models = [
        { providerID: "anthropic", id: "opus-4-5", name: "Opus 4.5", images: true, variants: ["low", "medium", "high"] },
        { providerID: "anthropic", id: "sonnet-4-5", name: "Sonnet 4.5", images: true, variants: ["low", "medium", "high"] },
        { providerID: "anthropic", id: "haiku-4-5", name: "Haiku 4.5", images: true, variants: [] },
        { providerID: "openai", id: "gpt-5", name: "GPT-5", images: true, variants: ["minimal", "high"] },
        { providerID: "openai", id: "gpt-5-mini", name: "GPT-5 mini", images: true, variants: [] },
        { providerID: "openai", id: "gpt-5-codex", name: "GPT-5 Codex", images: false, variants: ["low", "high"] },
        { providerID: "google", id: "gemini-2-5-pro", name: "Gemini 2.5 Pro", images: true, variants: [] },
        { providerID: "google", id: "gemini-2-5-flash", name: "Gemini 2.5 Flash", images: true, variants: [] },
        { providerID: "local", id: "qwen-coder", name: "Qwen Coder 32B", images: false, variants: [] },
        { providerID: "local", id: "llama-3-3", name: "Llama 3.3 70B", images: false, variants: [] },
        { providerID: "local", id: "deepseek-coder", name: "DeepSeek Coder 33B", images: false, variants: [] },
        { providerID: "local", id: "mistral-small", name: "Mistral Small 24B", images: true, variants: [] },
        { providerID: "local", id: "phi-4", name: "Phi-4 14B", images: false, variants: [] },
      ]
      state.defaultModel = { providerID: "anthropic", id: "opus-4-5" }
      state.modelChoice = { suggested: { providerID: "anthropic", id: "opus-4-5" }, ...(params.has("previous") ? { previous: { providerID: "anthropic", id: "sonnet-4" } } : {}) }
      // &opencode: OpenCode's list, two providers with a "Kimi K3.1 Pro" each, its free ones.
      if (params.has("opencode")) {
        state.models = OPENCODE_MODELS
        state.defaultModel = state.modelChoice.suggested = { providerID: "moonshotai", id: "moonshotai/kimi-k3.1-pro" }
      }
      items = []
      break
    case "honest": {
      // What the conversation says of its models (use with &agent=opencode): a note whose
      // screenshots the free alpha did not see, its turn with the model that answered, a reply
      // with no steps, and a turn its provider refused.
      const t = Date.now() - 9 * 60_000
      const pics = [
        { name: "element.png", src: thumb(260) },
        { name: "page.png", src: thumb(30) },
      ]
      items = [
        { kind: "user", id: "h-u1", time: t, text: "Review note 3\n\nmatch the card radius to the button", images: pics, note: { n: 3, text: "match the card radius to the button" }, unseen: { by: "Tidepool Alpha" } },
        {
          kind: "assistant",
          id: "h-a1",
          time: t,
          ended: t + 128_000,
          done: true,
          model: "Tidepool Alpha",
          parts: [
            { kind: "tool", key: "t1", name: "read", status: "done", title: "read src/components/pricing/PlanCard.tsx", detail: "64 lines" },
            { kind: "tool", key: "t2", name: "edit", status: "done", title: "edit src/components/pricing/PlanCard.tsx", changes: [change("src/components/pricing/PlanCard.tsx", PATCH_HERO)] },
            { kind: "text", key: "x1", text: "The images attached to this note could not be read by the model (it does not support image input), so I went by the note's words: the cards now use `rounded-lg`, the button's radius." },
          ],
        },
        { kind: "user", id: "h-u2", time: t + 200_000, text: "Which file sets the button radius?", images: [] },
        { kind: "assistant", id: "h-a2", time: t + 200_000, ended: t + 209_000, done: true, model: "Kimi K3.1 Pro · Moonshot AI", parts: [{ kind: "text", key: "x1", text: "`src/styles/buttons.css`, as `--radius-button`." }] },
        { kind: "user", id: "h-u3", time: t + 300_000, text: "Review note 4\n\nless space above the plans", images: [pics[0]!], note: { n: 4, text: "less space above the plans" } },
        {
          kind: "marker",
          id: "end_h-u3",
          time: t + 302_000,
          tone: "error",
          failed: true,
          text: "Failed: kimi-code-plan-global refused the key OpenCode has for it, so Kimi K3.1 Pro could not answer. OpenCode itself is signed in. Choose another model, or add a key in a terminal: opencode auth login.",
          refused: { model: "Kimi K3.1 Pro", provider: "kimi-code-plan-global", agent: "OpenCode", fix: "opencode auth login" },
        },
      ]
      const refused = (items.at(-1) as { text: string }).text.replace(/^Failed: /, "")
      state.review.notes = state.review.notes.flatMap((n) =>
        n.n === 3 ? [{ ...n, text: "match the card radius to the button" }] : n.n === 4 ? [{ ...n, text: "less space above the plans", status: "failed" as const, error: refused }] : [],
      )
      state.review.unplaced = 0
      break
    }
    case "canvas":
      state.review.notes = canvasNotes()
      // The chat calls a note what the list calls it.
      items = items.map((i) => {
        const row = i.kind === "user" && i.note ? state.review.notes.find((n) => n.n === i.note!.n) : undefined
        return row && i.kind === "user" && i.note ? { ...i, note: { ...i.note, text: row.text } } : i
      })
      break
    case "fresh":
      state.review = { enabled: true, mode: "notes", brush: false, autoReload: false, notes: [], unplaced: 0, docks: [] }
      state.page.hmr = true
      items = []
      break
    case "busy":
      // Note 4's reply streams in (see begin) instead of standing still.
      state.page.loading = true
      items = items.filter((i) => i.id !== TURN)
      break
    case "permission":
      state.permissions = [
        {
          id: "p1",
          session: SESSION,
          action: "edit",
          resources: ["src/components/marketing/navigation/PrimaryNavigation.tsx"],
          changes: [change("src/components/marketing/navigation/PrimaryNavigation.tsx", PATCH_NAV)],
        },
        { id: "p2", session: "s-bg", action: "bash", resources: ["npm run build -- --filter=storefront"], message: "Checks that the page still builds." },
      ]
      break
    case "long": {
      const log = Array.from({ length: 46 }, (_, i) =>
        i % 9 === 0 ? `\n src/components/${["Hero", "Footer", "PricingCard", "Header", "Button", "Nav"][i % 6]}.test.tsx` : `   ✓ renders the ${["heading", "lead", "button", "links", "card", "price"][i % 6]} at ${320 + i * 40}px (${3 + (i % 7)} ms)`,
      ).join("\n")
      const code = Array.from({ length: 34 }, (_, i) => `  { name: "${["Starter", "Team", "Business"][i % 3]}", price: ${(i + 1) * 4}, seats: ${i + 2}, featured: ${i % 3 === 1} },`).join("\n")
      items = items.filter((i) => i.id !== TURN && !(i.kind === "user" && i.pending))
      const longLine = `--- a/src/pages/pricing.tsx
+++ b/src/pages/pricing.tsx
@@ -8,4 +8,4 @@ export default function Pricing() {
   return (
-    <section className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-16 sm:grid-cols-2 lg:grid-cols-3">
+    <section className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-8 py-24 sm:grid-cols-2 lg:grid-cols-3 xl:gap-10">
       {plans.map((plan) => <PricingCard key={plan.name} {...plan} />)}
`
      items.push(
        { kind: "user", id: "u-long", time: Date.now(), text: "Run the tests, then show me the plans file", images: [] },
        {
          kind: "assistant",
          id: "a-long",
          time: Date.now(),
          done: true,
          parts: [
            { kind: "tool", key: "t1", name: "bash", status: "done", title: "run npm test", detail: log + "\n\n Tests  46 passed (46)" },
            { kind: "tool", key: "t2", name: "edit", status: "done", title: "edit src/pages/pricing.tsx", changes: [change("src/pages/pricing.tsx", longLine)] },
            { kind: "text", key: "x1", text: "All 46 tests pass. Here is `src/data/plans.ts`:\n\n```ts\nexport const plans = [\n" + code + "\n]\n```\n\nThe featured plan is the one in the middle." },
          ],
        },
      )
      break
    }
    case "question":
      state.questions = [
        {
          id: "q1",
          session: SESSION,
          title: "Which green should the button use?",
          fields: [
            {
              key: "colour",
              type: "string",
              title: "Brand green",
              required: true,
              custom: true,
              placeholder: "Another token or hex value",
              options: [
                { value: "brand-600", label: "brand-600", description: "The one the logo uses" },
                { value: "brand-500", label: "brand-500", description: "Lighter; used for hover today" },
              ],
            },
            {
              key: "where",
              type: "multiselect",
              title: "Apply it to",
              options: [
                { value: "primary", label: "Primary buttons" },
                { value: "links", label: "Text links" },
              ],
            },
          ],
        },
      ]
      break
    case "noconversation":
      // What main sends when a conversation cannot be opened: no session, one error marker.
      Object.assign(state, { session: null, sessions: [] })
      state.review.notes = []
      state.review.unplaced = 0
      items = [{ kind: "marker", id: "m-open", time: Date.now(), text: "Can't open a conversation: the folder /home/dev/code/acme/storefront no longer exists.", tone: "error" }]
      break
    case "offline":
      state.connection = { status: "offline", url: "acp://claude@dev-box", error: "dev-box can't be reached: the connection was refused.", away: true }
      break
    case "elsewhere":
      // The agent on dev-box said its site is at an address that is not on dev-box: asked, not opened.
      Object.assign(state, { site: { origin: "", directory: DIRECTORY } })
      state.page = { url: "", loading: false, canGoBack: false, canGoForward: false, hmr: false, device: "desktop", phone: PHONE.id, elsewhere: { url: "http://localtest.me:3000/", computer: "dev-box" } }
      state.review = { enabled: false, mode: "preview", brush: false, autoReload: false, notes: [], unplaced: 0, docks: [] }
      items = []
      break
    case "download":
      // The page started a download: held, and asked about.
      state.page.download = { id: "d1", site: "localhost:5173", file: "orders-2026-11.csv", from: "files.example.com", size: 12_480 }
      break
    case "refused":
      // The page tried to open an app's link, and was stopped.
      state.page.refused = "zoommtg:"
      break
    case "pageerror":
      state.page.url = "http://a-very-long-development-hostname.some-team.example:3000/products/category/shoes?sort=price&direction=ascending&page=4"
      state.page.error = "The connection was refused (ERR_CONNECTION_REFUSED)."
      break
    case "stress-code":
      items = []
      break
    case "stress":
      items = []
      state.review.notes = Array.from({ length: 200 }, (_, i) => ({
        id: `n${i + 1}`,
        n: i + 1,
        text: `note ${i + 1}: nudge this a little`,
        status: (["done", "queued", "working", "failed"] as const)[i % 4]!,
        lane: i % 7 ? "main" : "bg",
        ...(i % 4 === 3 ? { error: "The agent stopped answering (timeout after 30 s)." } : {}),
      }))
      break
  }

  // The conversation and the notes tell one story: a turn is in progress exactly while a
  // main-lane note is working, and every waiting note has its waiting message.
  const live = items.some((i) => i.kind === "assistant" && !i.done) || (scenario === "busy" && items.length > 0)
  if (live && state.session) {
    for (const i of items)
      if (i.kind === "user" && i.pending) queue.push({ id: i.id, n: i.note?.n, reply: (i.note && NOTE_REPLY[i.note.n]) ?? REPLY })
    state.session.busy = true
    const still = items.find((i): i is ChatAssistant => i.id === TURN && i.kind === "assistant")
    if (still)
      stop = (why = "Stopped", proceed = true) => {
        stop = () => {}
        const parts = still.parts.map((p) => (p.kind === "tool" && p.status === "running" ? { ...p, status: "done" as const } : p))
        emit({ type: "item", session: sid(), item: { ...still, done: true, parts } })
        emit({ type: "item", session: sid(), item: { kind: "marker", id: `m-${++serial}`, time: Date.now(), text: why, tone: "info" } })
        settle(why === "Redirected" ? "Set aside for your newer message." : "Stopped before it finished.")
        if (proceed) next()
        else push()
      }
  } else {
    items = items.filter((i) => i.id !== TURN && !(i.kind === "user" && i.pending))
    for (const note of state.review.notes)
      if (note.lane === "main" && (note.status === "working" || note.status === "queued")) note.status = "done"
  }

  // &device=phone and &docks=motion,canvas: the page as a phone's, and docks the window draws.
  // (&phone=iphone-se: which phone.)
  if (params.get("device") === "phone") state.page.device = "phone"
  // &device=ds: the page's design system in its place (ds-space.tsx).
  if (params.get("device") === "ds") state.page.device = "ds"
  state.page.phone = phoneOf(params.get("phone")).id
  // (The facts pane beside a phone's page in Preview and Annotate is always the window's, as in
  // HOSTED_PANES; &facts=clear: a page that fits the phone.)
  state.review.docks = [...(params.get("docks") ?? "").split(",").filter((d): d is "motion" | "canvas" => d === "motion" || d === "canvas"), "facts", "tokens"]
  if (params.get("mode") === "edit" || params.get("mode") === "motion") state.review.mode = params.get("mode") as "edit" | "motion"
  if (params.get("mode") === "preview") (state.review.enabled = false), (state.review.mode = "preview")

  // &page=dark: the page dark by its own color-scheme, and the status bar as main would find it.
  // &theme=…: the page's theme-color.
  const darkPage = params.get("page") === "dark"
  state.page.tint = params.get("theme") ? `#${params.get("theme")}` : darkPage ? "#121212" : "#ffffff"
  const page = fakePage(state.review.notes.length > 0)
  if (darkPage) page.style.colorScheme = "dark"
  // (A page with a theme-color has its header in it, as such a page has.)
  if (params.get("theme")) page.querySelector<HTMLElement>(":scope > div")!.style.background = state.page.tint
  page.querySelector<HTMLElement>("[data-pins]")!.hidden = !state.review.enabled

  // What the page's overlay draws over a phone's page (overlay/src/device.js), drawn here as it
  // does, with its styles: the screen's bottom corners and the home indicator, at the size the
  // page is drawn (the fake page is in the window's px).
  let surround: PhoneSurround | undefined
  const edgeEl = document.createElement("div")
  edgeEl.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:0;pointer-events:none"
  page.append(edgeEl)
  const drawPhoneEdge = (bounds: Rect | null) => {
    const phone = phoneOf(state.page.phone)
    const k = bounds ? Math.min(1, bounds.width / phone.width) : 1
    const edge = state.page.device === "phone" && bounds ? phoneEdge(phone, k, surround) : null
    edgeEl.innerHTML = ""
    if (!edge) return
    const r = edge.radius * k
    if (r > 0 && edge.ring !== undefined && bounds)
      edgeEl.insertAdjacentHTML("beforeend", `<i style="position:absolute;left:0;bottom:0;width:${bounds.width}px;height:${bounds.height}px;border-radius:0 0 ${r}px ${r}px;corner-shape:${edge.shape};box-shadow:0 0 0 ${edge.ring * k}px ${edge.ringColour}, 0 0 0 4000px ${edge.around}"></i>`)
    if (edge.home) {
      const { width, height, bottom } = edge.home
      edgeEl.insertAdjacentHTML("beforeend", `<i style="position:absolute;left:50%;bottom:${bottom * k}px;width:${width * k}px;height:${height * k}px;margin-left:${(-width * k) / 2}px;border-radius:${(height * k) / 2}px;backdrop-filter:blur(4px) grayscale(1) invert(1) brightness(0.926) contrast(1000)"></i>`)
    }
  }

  const commands: { [K in CommandName]: (...args: Parameters<Commands[K]>) => ReturnType<Commands[K]> | Promise<ReturnType<Commands[K]>> } = {
    navigate(url) {
      state.page = { ...state.page, url: /^https?:/.test(url) ? url : `http://${url}`, error: undefined, canGoBack: true }
      state.site ??= { origin: ORIGIN }
      push()
    },
    reload() {
      state.page.loading = true
      push()
      setTimeout(() => ((state.page.loading = false), push()), 700)
    },
    back() {},
    forward() {},
    saveDownload(id) {
      const d = state.page.download
      if (d?.id !== id) return
      delete state.page.download
      // Saved: a line of how much has come, until it is all there.
      const size = d.size ?? 4_000_000
      state.page.saving = [...(state.page.saving ?? []), { id, file: d.file, received: 0, ...(d.size !== undefined ? { size: d.size } : {}) }]
      push()
      const tick = setInterval(() => {
        const line = state.page.saving?.find((s) => s.id === id)
        if (line && line.received < size) line.received = Math.min(size, line.received + size / 8)
        else (clearInterval(tick), (state.page.saving = state.page.saving?.filter((s) => s.id !== id)))
        push()
      }, 400)
    },
    dropDownload(id) {
      if (state.page.download?.id === id) delete state.page.download
      state.page.saving = state.page.saving?.filter((s) => s.id !== id)
      push()
    },
    setDevice(device) {
      state.page.device = device
      push()
    },
    setPhone(id) {
      state.page.phone = phoneOf(id).id
      push()
    },
    panel(act) {
      motionAct(act as PanelAct, (msg) => panelFns.forEach((fn) => fn(msg)))
      factsAct(act as PanelAct, (msg) => panelFns.forEach((fn) => fn(msg)))
      tokensAct(act as PanelAct, (msg) => panelFns.forEach((fn) => fn(msg)))
      canvasAct(act as PanelAct, (msg) => panelFns.forEach((fn) => fn(msg)))
    },
    setPageBounds(bounds: Rect | null) {
      page.style.display = bounds ? "block" : "none"
      // Rounded like the real page view (PAGE_RADIUS in main/page.ts; a phone's square).
      const radius = state.page.device === "phone" ? 0 : 9
      if (bounds) Object.assign(page.style, { left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, borderRadius: `${radius}px`, overflow: "hidden" })
      calls.push(bounds)
      drawPhoneEdge(bounds)
    },
    setPhoneSurround(around) {
      surround = around
      drawPhoneEdge(calls.at(-1) ?? null)
    },
    // The mock's page is part of this window, not a view drawn over it: no picture of it is taken,
    // and the surface stands in for it while it is away.
    pageStill() {
      return null
    },
    toggleReview() {
      state.review.enabled = !state.review.enabled
      state.review.mode = state.review.enabled ? "notes" : "preview"
      if (!state.review.enabled) state.review.brush = false
      push()
    },
    setMode(mode: AppState["review"]["mode"]) {
      state.review.enabled = mode !== "preview"
      state.review.mode = mode
      if (mode !== "notes") state.review.brush = false
      push()
    },
    toggleBrush() {
      state.review.brush = !state.review.brush
      if (state.review.brush) Object.assign(state.review, { enabled: true, mode: "notes" })
      push()
    },
    capture() {
      Object.assign(state.review, { enabled: false, mode: "preview", brush: false })
      push()
    },
    setCapture(kind, on) {
      const was = state.capture!.on
      state.capture!.on = (["figma", "paper"] as const).filter((k) => (k === kind ? on : was.includes(k)))
      push()
    },
    toggleAutoReload() {
      state.review.autoReload = !state.review.autoReload
      push()
    },
    clearNotes() {
      state.review.notes = state.review.notes.filter((n) => n.status !== "done")
      push()
    },
    retryNote(id) {
      const note = state.review.notes.find((n) => n.id === id)
      if (!note) return
      note.status = "queued"
      delete note.error
      push()
    },
    removeNote(id) {
      state.review.notes = state.review.notes.filter((n) => n.id !== id)
      push()
    },
    showNote() {},
    // One of each: ready, not signed in, not installed, ready (and in use with `&agent=opencode`).
    localAgents: () => [
      mockAgent("claude", mockLatest.has("claude")),
      { ...mockAgent("codex", mockLatest.has("codex")), signIn: "codex login" },
      { id: "gemini", name: "Gemini CLI", command: "gemini --experimental-acp", installed: false, needs: "Install Gemini CLI and sign in: npm install -g @google/gemini-cli, then gemini", install: "npm install -g @google/gemini-cli" },
      { id: "opencode", name: "OpenCode", command: "opencode acp", installed: true },
    ],
    setAgentLatest({ id, latest }) {
      if (latest) mockLatest.add(id)
      else mockLatest.delete(id)
      return mockAgent(id, latest)
    },
    async connectAgent(agent) {
      await new Promise((r) => setTimeout(r, 600))
      const known = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", opencode: "OpenCode" }[agent.id]
      const id = known ? agent.id : "custom-1a2b3c4d"
      Object.assign(state, base(), {
        connection: { status: "online", url: agent.host ? `acp://${id}@${encodeURIComponent(agent.host)}` : `acp://${id}`, version: "0.109.1" },
        harness: { kind: known ? agent.id : "custom", name: known ?? agent.command?.split(" ")[0]?.split("/").pop() ?? "agent", here: !agent.host, ...(agent.host ? { host: agent.host } : {}) },
        ...(agent.host ? { home: "/home/dev" } : {}),
        can: { queue: true, steer: true, fork: true },
      })
      push()
    },
    leaveSsh() {},
    // Another computer over ssh: "dev-box" answers, with Claude Code ready and Codex not installed; any other name is not known.
    async connectSsh(host) {
      await new Promise((r) => setTimeout(r, 700))
      if (!/dev-box$/.test(host)) throw new Error(`There is no computer called ${host} that this one can find. Check the name, or the Host in your ~/.ssh/config.`)
      return {
        host,
        computer: "dev-box",
        home: "/home/dev",
        agents: [
          { id: "claude", name: "Claude Code", command: "claude-agent-acp", installed: true },
          { id: "codex", name: "Codex", command: "npx -y @agentclientprotocol/codex-acp", installed: false, needs: "Install Codex and sign in: npm install -g @openai/codex, then codex login", install: "npm install -g @openai/codex" },
          { id: "gemini", name: "Gemini CLI", command: "gemini --experimental-acp", installed: false, needs: "Install Gemini CLI and sign in: npm install -g @google/gemini-cli, then gemini", install: "npm install -g @google/gemini-cli" },
          { id: "opencode", name: "OpenCode", command: "opencode acp", installed: true },
        ],
      }
    },
    // `&returning`: no agent is known any more but these were connected to before.
    servers: () => {
      // The first launch has nothing saved; `&returning` is someone who disconnected.
      if (scenario === "connect" && !params.has("returning")) return []
      const url = "url" in state.connection ? state.connection.url : ""
      const all: Omit<ServerInfo, "current">[] = [
        { id: "srv_0", name: "Claude Code", agent: "claude", command: "claude-agent-acp", host: "dev-box", kind: "claude", here: false },
        { id: "srv_4", name: "Claude Code", agent: "claude", command: "npx -y @agentclientprotocol/claude-agent-acp", kind: "claude", here: true },
        { id: "srv_2", name: "OpenCode", agent: "opencode", command: "opencode acp", host: "studio-mac", kind: "opencode", here: false },
        { id: "srv_5", name: "my-agent", agent: "custom-1a2b3c4d", command: "/opt/my-agent/bin/my-agent --acp", kind: "custom", here: true },
        { id: "srv_3", name: "Codex", agent: "codex", command: "npx -y @agentclientprotocol/codex-acp", host: "omarchy", kind: "codex", here: false },
      ]
      const at = (x: Omit<ServerInfo, "current">) => (x.host ? `acp://${x.agent}@${encodeURIComponent(x.host)}` : `acp://${x.agent}`)
      return all.map((x) => ({ ...x, current: at(x) === url })).sort((a, b) => Number(b.current) - Number(a.current))
    },
    useServer() {},
    forgetServer() {},
    reconnect() {},
    disconnect() {
      state.connection = { status: "unconfigured" }
      push()
    },
    projects: () => ["/home/dev/code/acme/storefront", "/home/dev/code/acme/marketing-site", "/home/dev/code/blog", "/srv/www/a-rather-long-organisation-name/internal-tools/design-review-playground"],
    async listFolders(path) {
      await new Promise((r) => setTimeout(r, 150))
      const names = TREE[path]
      if (!names) return []
      return names.map((name) => ({ name, path: `${path === "/" ? "" : path}/${name}` }))
    },
    allProjects: () => {
      const h = state.harness
      const mine = { on: h?.name ?? "Claude Code", kind: h?.kind ?? ("claude" as const), ...(h?.here ? { here: true as const } : {}) }
      return [
        { directory: "/home/dev/code/acme/storefront", ...mine, open: true as const },
        { directory: "/home/dev/code/acme/marketing-site", ...mine },
        { directory: "/home/dev/code/blog", ...mine },
        ...(h?.kind === "claude" ? [] : [{ directory: "/home/dev/cde/bicycle42", server: "srv_4", on: "Claude Code", kind: "claude" as const, here: true as const }]),
        ...(h?.kind === "custom" ? [] : [{ directory: "/home/dev/sketches/motion-lab", server: "srv_5", on: "my-agent", kind: "custom" as const, here: true as const }]),
        { directory: "/Users/kiryl/Documents/cde/zing-social", server: "srv_2", on: "OpenCode", kind: "opencode" as const },
        { directory: "/srv/www/a-rather-long-organisation-name/internal-tools/design-review-playground", server: "srv_3", on: "Codex", kind: "codex" as const },
      ]
    },
    openProject(directory) {
      state.site = { origin: "", directory }
      state.page = { url: "", loading: false, canGoBack: false, canGoForward: false, hmr: false, device: "desktop", phone: PHONE.id }
      state.review.notes = []
      state.session = { id: SESSION, title: `Review · ${directory.split("/").pop()}`, updated: Date.now(), busy: false, directory }
      state.sessions = [state.session]
      push()
      emit({ type: "reset", session: SESSION, items: [] })
    },
    startSite() {
      state.startingSite = true
      push()
      deliver("Get this project's site running so I can review it in Bicycle42.\n\nRun it as a background command of your shell tool (not nohup, & or tmux), so I can stop it from here.\n\nWhen it answers, end your reply with one line: SITE: <address>", undefined, undefined, REPLY)
    },
    setDirectory(directory) {
      state.site = { origin: state.page.url ? ORIGIN : "", directory }
      state.session = { id: SESSION, title: "New conversation", updated: Date.now(), busy: false, directory }
      state.sessions = [state.session]
      push()
      emit({ type: "reset", session: SESSION, items: [] })
    },
    send(text, images, options) {
      deliver(text, images, options, options?.delivery === "steer" ? STEERED : REPLY)
    },
    commands: () => (scenario === "nocommands" ? [] : COMMANDS),
    runCommand(name, args, images, options) {
      if (!COMMANDS.some((c) => c.name === name)) throw new Error(`There is no /${name} command.`)
      // The app's own commands, roughly as main answers them.
      if (name === "compact") {
        // The agent's own /compact: a turn of its, which says what it did; what it counts next is what is left.
        deliver("/compact", images, options, COMMAND_REPLY.compact!)
        setTimeout(() => {
          delete state.context
          push()
        }, 700)
        return
      }
      if (name === "undo")
        return args === "yes"
          ? { say: 'Took back the agent\'s changes to files for note 7 ("tighter"). /redo brings them back; your next message makes it final.' }
          : { say: 'This takes back the changes the agent made to files for note 7 ("tighter"). The conversation stays as it is, and the agent is told with your next message. Press Enter to undo.', draft: "/undo yes" }
      if (name === "redo") throw new Error("Nothing to redo.")
      if (name === "new") return void this.newSession()
      if (name === "rename") {
        if (!args) throw new Error("Type the new name after /rename.")
        if (state.session) state.session = { ...state.session, title: args }
        push()
        return { say: `Renamed to ${JSON.stringify(args)}.` }
      }
      if (name === "fork") return { say: "This is a copy. The original is still in the list of conversations." }
      deliver(`/${name}${args ? ` ${args}` : ""}`, images, options, COMMAND_REPLY[name] ?? "Done.")
    },
    async mentions(query) {
      await new Promise((r) => setTimeout(r, 60))
      return mentionOptions(query)
    },
    cancelQueued(id) {
      const at = queue.findIndex((w) => w.id === id)
      if (at < 0) throw new Error("That message is no longer waiting.")
      const [w] = queue.splice(at, 1)
      // A note taken out of the queue leaves the list too (as main does).
      if (w!.n) state.review.notes = state.review.notes.filter((x) => x.n !== w!.n)
      emit({ type: "remove", session: sid(), item: id })
      push()
    },
    cancelNote(id) {
      const note = state.review.notes.find((x) => x.id === id)
      if (!note || note.status !== "queued") throw new Error("This note is no longer waiting.")
      const at = queue.findIndex((w) => w.n === note.n)
      if (at >= 0) emit({ type: "remove", session: sid(), item: queue.splice(at, 1)[0]!.id })
      // As main does: it stays on the list, stopped, with Retry.
      state.review.notes = state.review.notes.map((x) => (x.id === id ? { ...x, status: "failed" as const, error: "Cancelled.", stopped: true as const } : x))
      push()
    },
    stop: () => stop(),
    newSession() {
      state.session = { id: `s-${++serial}`, title: "New conversation", updated: Date.now(), busy: false, directory: state.site?.directory ?? DIRECTORY }
      push()
      emit({ type: "reset", session: sid(), items: [] })
    },
    openSession(id) {
      const found = state.sessions.find((s) => s.id === id)
      if (!found) throw new Error("That conversation no longer exists.")
      state.session = { ...found }
      push()
      emit({ type: "reset", session: id, items: id === SESSION ? transcript() : [] })
    },
    notePictures(id) {
      const note = state.review.notes.find((n) => n.id === id)
      const picture = (fill: string, pad: number) =>
        `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260"><rect width="480" height="260" fill="#f4f1ea"/><rect x="40" y="${40 + pad}" width="220" height="26" rx="4" fill="#222"/><rect x="40" y="${96 + pad * 2}" width="360" height="12" rx="3" fill="#999"/><rect x="40" y="${118 + pad * 2}" width="300" height="12" rx="3" fill="#999"/><rect x="40" y="${166 + pad * 2}" width="${120 + pad * 4}" height="${36 + pad}" rx="8" fill="${fill}"/></svg>`)}`
      return note?.pictures ? { before: picture("#2563eb", 0), ...(note.pictures === "both" ? { after: picture("#16a34a", 8) } : {}) } : {}
    },
    noteDiff: () => [
      { file: "src/components/pricing/PlanCard.tsx", additions: 3, deletions: 2, patch: "@@ -12,7 +12,8 @@ export function PlanCard(props) {\n   return (\n     <article class=\"plan\">\n-      <button class=\"btn\">Start free trial</button>\n-      <p class=\"fine\">No card needed</p>\n+      <button class=\"btn btn-lg\">Start free trial</button>\n+      <p class=\"fine\">No card needed.</p>\n+      <p class=\"fine\">Cancel any time.</p>\n     </article>\n   )" },
      { file: "src/styles/buttons.css", additions: 4, deletions: 0, patch: "@@ -40,3 +40,7 @@\n .btn:hover {\n   filter: brightness(1.05);\n }\n+.btn-lg {\n+  height: 48px;\n+  padding: 0 20px;\n+}" },
    ],
    takeBackWay: (id) => takeBackWay(id),
    takeBackPlan(id) {
      const how = takeBackWay(id)
      return how === "restored" ? { how, files: ["src/components/pricing/PlanCard.tsx", "src/styles/buttons.css"] } : { how }
    },
    takeBackNote(id) {
      const how = takeBackWay(id)
      state.review.notes = state.review.notes.map((n) => (n.id === id ? { ...n, takenBack: how } : n))
      push()
      return how
    },
    addCheckpoint(name) {
      emit({ type: "item", session: sid(), item: { kind: "marker", id: `checkpoint:c-${++serial}`, time: Date.now(), tone: "info", text: name || "Checkpoint", checkpoint: `c-${serial}` } })
    },
    removeCheckpoint(id) {
      emit({ type: "remove", session: sid(), item: `checkpoint:${id}` })
    },
    returnToCheckpoint: () => ({ taken: 3 }),
    refreshRepo() {},
    commitChanges() {
      delete state.repo
      push()
    },
    refreshSessions() {},
    archivedSessions: () => put,
    renameSession(id, title) {
      state.sessions = state.sessions.map((s) => (s.id === id ? { ...s, title } : s))
      if (state.session?.id === id) state.session = { ...state.session, title }
      push()
    },
    pinSession(id, pinned) {
      const all: SessionSummary[] = state.sessions.map((s) => {
        const { pinned: _was, ...rest } = s
        return s.id === id && pinned ? { ...rest, pinned: true as const } : s.id === id ? rest : s
      })
      state.sessions = [...all.filter((s) => s.pinned), ...all.filter((s) => !s.pinned)]
      push()
    },
    archiveSession(id, archived) {
      const from = archived ? state.sessions : put
      const found = from.find((s) => s.id === id)
      if (!found) return
      const { archived: _a, pinned: _p, ...rest } = found
      if (archived) (put = [{ ...rest, archived: true }, ...put]), (state.sessions = state.sessions.filter((s) => s.id !== id))
      else (put = put.filter((s) => s.id !== id)), (state.sessions = [...state.sessions, rest].sort((x, y) => y.updated - x.updated))
      if (archived && state.session?.id === id) return void (state.sessions[0] ? this.openSession(state.sessions[0].id) : this.newSession())
      push()
    },
    deleteSession(id) {
      put = put.filter((s) => s.id !== id)
      state.sessions = state.sessions.filter((s) => s.id !== id)
      if (state.session?.id === id) return void (state.sessions[0] ? this.openSession(state.sessions[0].id) : this.newSession())
      push()
    },
    setModel(model) {
      if (state.session) state.session.model = model
      push()
    },
    setServerName(name: string) {
      const clean = name.replace(/\s+/g, " ").trim().slice(0, 60)
      if (clean) state.serverName = clean
      else delete state.serverName
      push()
    },
    setDefaultModel(model) {
      state.defaultModel = model
      delete state.modelChoice
      push()
    },
    setAgent(id) {
      if (state.session) state.session.agent = id
      push()
    },
    replyPermission(id) {
      state.permissions = state.permissions.filter((p) => p.id !== id)
      push()
    },
    answerQuestion(id) {
      state.questions = state.questions.filter((q) => q.id !== id)
      push()
    },
    dismissQuestion(id) {
      state.questions = state.questions.filter((q) => q.id !== id)
      push()
    },
    installUpdate() {},
  }

  // What the window asked for, for the screenshot script to assert on.
  const calls: (Rect | null)[] = []
  const shortcutFns = new Set<(s: Shortcut) => void>()
  Object.assign(window, {
    __mock: {
      calls,
      state,
      shortcut: (s: Shortcut) => shortcutFns.forEach((fn) => fn(s)),
      // A pin clicked on the page, as main reports it.
      focusNote: (id: string) => setFocusedNote({ id, at: Date.now() }),
    },
  })

  // Scenes that move start once the window has subscribed.
  const begin = () => {
    if (scenario === "busy" && state.session?.busy) stream(WORKING, () => {}, 70)
    if (scenario === "stress" || params.has("stress")) void stress(emit, sid())
    if (scenario === "stress-code") void stressCode(emit, sid())
  }

  return {
    invoke: async (name, ...args) => (commands[name] as (...a: unknown[]) => never)(...args),
    onState(fn) {
      stateFns.add(fn)
      fn(structuredClone(state))
      return () => stateFns.delete(fn)
    },
    onChat(fn) {
      chatFns.add(fn)
      fn({ type: "reset", session: sid(), items: structuredClone(items) })
      setTimeout(begin, 50)
      return () => chatFns.delete(fn)
    },
    onNoteFocus: () => () => true,
    // A hosted dock's view, as the overlay would send it once the dock is shown.
    onPanel(fn) {
      panelFns.add(fn)
      if (state.review.docks.includes("motion")) fn({ panel: "motion", view: structuredClone(MOTION) })
      if (state.review.docks.includes("canvas")) setTimeout(() => fn({ panel: "canvas", view: canvasView() }))
      return () => panelFns.delete(fn)
    },
    onShortcut(fn) {
      shortcutFns.add(fn)
      return () => shortcutFns.delete(fn)
    },
    platform: params.get("platform") === "darwin" ? "darwin" : "linux",
  }
}

// ── stress: 2,000 deltas of 20 characters into one part ─────────────────────────────────────────
// Twice: paced (20 deltas per frame, a very fast model) to see frame times while it streams, then
// all at once in one task to see the worst case. Results go to window.__stress and into the chat.

async function stress(emit: (e: ChatEvent) => void, session: string) {
  const paragraph = "The spacing between the heading and its paragraph now follows the card rhythm below it. "
  const blocks = [
    paragraph.repeat(4),
    "- first point about the `hero` section\n- second point about **contrast**\n- third point, a little longer than the others so that it wraps",
    "```tsx\nexport function Card({ children }: Props) {\n  return <article className=\"card pl-8\">{children}</article>\n}\n```",
    paragraph.repeat(3),
  ]
  let source = ""
  while (source.length < 40_000) source += blocks[Math.floor(source.length / 331) % blocks.length] + "\n\n"
  source = source.slice(0, 40_000)
  const frame = () => new Promise<number>((r) => requestAnimationFrame(r))

  const run = async (id: string, perFrame: number) => {
    emit({ type: "item", session, item: { kind: "assistant", id, time: Date.now(), done: false, parts: [{ kind: "text", key: "x", text: "" }] } })
    const gaps: number[] = []
    let apply = 0
    let last = await frame()
    for (let at = 0; at < source.length; ) {
      const t0 = performance.now()
      for (let i = 0; i < perFrame && at < source.length; i++, at += 20)
        emit({ type: "delta", session, item: id, key: "x", text: source.slice(at, at + 20) })
      apply += performance.now() - t0
      const now = await frame()
      gaps.push(now - last)
      last = now
    }
    // One more frame so the last paint is inside the measurement.
    gaps.push((await frame()) - last)
    gaps.sort((a, b) => a - b)
    const round = (n: number) => Math.round(n * 10) / 10
    return {
      frames: gaps.length,
      applyMs: round(apply),
      meanFrameMs: round(gaps.reduce((a, b) => a + b, 0) / gaps.length),
      p95FrameMs: round(gaps[Math.floor(gaps.length * 0.95)] ?? 0),
      maxFrameMs: round(gaps[gaps.length - 1] ?? 0),
    }
  }
  const paced = await run("stress-paced", 20)
  const flood = await run("stress-flood", 2000)
  const t0 = performance.now()
  emit({ type: "item", session, item: { kind: "assistant", id: "stress-flood", time: Date.now(), done: true, parts: [{ kind: "text", key: "x", text: source }] } })
  await frame()
  const result = { deltas: 2000, chars: source.length, paced, flood, finalParseMs: Math.round((performance.now() - t0) * 10) / 10 }
  Object.assign(window, { __stress: result })
  // The numbers go to the console and to shot.mjs's report, never into the conversation.
  console.log("stress", JSON.stringify(result))
}

// ── stress-code: one 17 KB fenced code block in 4-character deltas, 5 every 8 ms ────────────────
// The case a block splitter alone handles worst: the fence stays open, so nothing can be frozen.
// shot.mjs adds the renderer's task and layout time from the debugger next to these numbers.

async function stressCode(emit: (e: ChatEvent) => void, session: string) {
  const lines = Array.from({ length: 300 }, (_, i) => `  const value${i} = compute(${i}, props.spacing) // line ${i}`)
  const source = "Here is the file:\n\n```tsx\n" + lines.join("\n") + "\n```\n\nThat is all of it."
  const id = "stress-code"
  emit({ type: "item", session, item: { kind: "assistant", id, time: Date.now(), done: false, parts: [{ kind: "text", key: "x", text: "" }] } })
  const gaps: number[] = []
  let running = true
  let last = performance.now()
  const tick = (now: number) => {
    gaps.push(now - last)
    last = now
    if (running) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  const t0 = performance.now()
  let at = 0
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      for (let i = 0; i < 5 && at < source.length; i++, at += 4)
        emit({ type: "delta", session, item: id, key: "x", text: source.slice(at, at + 4) })
      if (at < source.length) return
      clearInterval(timer)
      done()
    }, 8)
  })
  await new Promise((r) => requestAnimationFrame(r))
  const streamMs = performance.now() - t0
  running = false
  emit({ type: "item", session, item: { kind: "assistant", id, time: Date.now(), done: true, parts: [{ kind: "text", key: "x", text: source }] } })
  gaps.sort((a, b) => a - b)
  const round = (n: number) => Math.round(n * 10) / 10
  const result = {
    chars: source.length,
    deltas: Math.ceil(source.length / 4),
    streamMs: round(streamMs),
    frames: gaps.length,
    p95FrameMs: round(gaps[Math.floor(gaps.length * 0.95)] ?? 0),
    maxFrameMs: round(gaps[gaps.length - 1] ?? 0),
    framesOver20ms: gaps.filter((g) => g > 20).length,
  }
  Object.assign(window, { __stress: result })
  console.log("stress-code", JSON.stringify(result))
}

// ── motion mode's dock, as the overlay would describe it (&docks=motion&mode=motion) ───────────────
// The harness's motion page with the heading's "rise" open, its opacity keyframe at 100% selected
// and the playhead stopped at 42%. A few acts change it, enough to click through the dock.

const RISE = { duration: 700, delay: 120, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", count: "1", direction: "normal", fill: "both" }
const MOTION: MotionView = {
  on: true,
  rows: [
    { group: "In view" },
    { id: "css||nav > div > span.sync > i|spin", kind: "css", text: "spin", aside: ".spinner", duration: 900, on: false, sub: false, last: false, off: false, running: true, dirty: false },
    { id: "css|||rise", kind: "css", text: "rise", aside: "2 elements", duration: null, on: false, sub: false, last: false, off: false, running: false, dirty: true },
    { id: "css|rise|section > h2|Ship calmer interfaces", kind: "css", text: "Ship calmer interfaces", aside: "", duration: 900, on: true, sub: true, last: false, off: false, running: false, dirty: true },
    { id: "css|rise|section > p|A review layer for…", kind: "css", text: "A review layer for…", aside: "", duration: 700, on: false, sub: true, last: true, off: false, running: false, dirty: false },
    { id: "css||button.primary|pulse", kind: "css", text: "pulse", aside: "Start free trial", duration: 2400, on: false, sub: false, last: false, off: false, running: true, dirty: false },
    { id: "transition||button.ghost|Book a demo", kind: "transition", text: "Book a demo", aside: "background-color, translate", duration: 180, on: false, sub: false, last: false, off: false, running: false, dirty: false },
    { group: "Animations elsewhere" },
    { id: "css|||card-in", kind: "css", text: "card-in", aside: "3 elements", duration: null, on: false, sub: false, last: false, off: false, running: false, dirty: false },
    { group: "Scripts elsewhere" },
    { id: "script||.badge|bob", kind: "script", text: "bob", aside: "New", duration: 1200, on: false, sub: false, last: false, off: false, running: true, dirty: false },
    { id: "frames||.meter > i|.meter i", kind: "frames", text: ".meter i", aside: "per frame", duration: null, on: false, sub: false, last: false, off: false, running: true, dirty: false },
    { group: "Unused" },
    { id: "unused|||wiggle", kind: "unused", text: "wiggle", aside: "", duration: null, on: false, sub: false, last: false, off: true, running: false, dirty: false },
  ],
  partial: false,
  sel: "Heading · Ship calmer interfaces",
  open: {
    kind: "css",
    name: "rise",
    readOnly: false,
    timed: true,
    states: [],
    state: null,
    triggers: [],
    above: [],
    recording: false,
    renamable: false,
    removable: false,
    shared: 2,
    from: null,
    timing: { ...RISE, duration: 900, delay: 240 },
    starts: "asnow",
    T: 900,
    frames: [0, 60, 100],
    lanes: [
      { prop: "opacity", keys: [{ at: 0, value: "0" }, { at: 60, value: "1" }, { at: 100, value: "1", implied: true }], eases: ["", ""] },
      { prop: "transform", keys: [{ at: 0, value: "translateY(18px)" }, { at: 100, value: "none" }], eases: [""] },
    ],
    key: { at: 60, prop: "opacity", value: "1", ease: "", dflt: RISE.easing, last: false, editable: true, props: 1 },
    css: "@keyframes rise {\n  0% { opacity: 0; transform: translateY(18px); }\n  60% { opacity: 1; }\n  100% { transform: none; }\n}",
    score: [
      { id: "a", text: "Ship calmer interfaces", name: "rise", delay: 240, duration: 900, on: true },
      { id: "b", text: "A review layer for…", name: "rise", delay: 360, duration: 700, on: false },
      { id: "c", text: "Start free trial", name: "pulse", delay: 400, duration: 2400, on: false },
    ],
    cssError: "",
    seen: null,
    dirty: true,
  },
  names: [],
  view: "keys",
  rate: 1,
  loop: false,
  isolate: false,
  backdrop: "light",
  undo: true,
  redo: false,
  note: "",
  msg: "",
  status: "",
  clock: { pos: 0.42, playing: false, on: false, wait: null },
  choices: {
    easings: ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "cubic-bezier(0.2, 0.8, 0.2, 1)", "cubic-bezier(0.34, 1.56, 0.64, 1)", "steps(4, end)"], // kkrll-ignore: CSS easings the page is offered, as data
    props: ["translate", "scale", "rotate", "background-color", "color", "filter", "clip-path", "width", "height"],
    starts: [["asnow", "As now"], ["load", "On load"], ["view", "In view"], ["hover", "On hover"], ["click", "On click"], ["appear", "On appear"], ["scroll", "On scroll"]],
    count: [["1", "Once", "1"], ["2", "2×", "2"], ["3", "3×", "3"], ["infinite", "Forever", "infinite"]],
    direction: [["normal", "Forward", "normal"], ["reverse", "Backward", "From the last keyframe to the first"], ["alternate", "Alternate", "Forward, then backward, and so on"], ["alternate-reverse", "Alt. reverse", "Backward, then forward, and so on"]],
    fill: [["none", "None", "Before it starts and after it ends, the element looks as it does without it"], ["forwards", "Hold end", "After it ends, it stays on the last keyframe"], ["backwards", "Hold start", "During the delay, it waits on the first keyframe"], ["both", "Hold both", "Waits on the first keyframe, stays on the last"]],
    rates: [[1, "1×"], [0.5, "½×"], [0.25, "¼×"], [0.1, "⅒×"]],
  },
}

/** The button's transition, opened by its row: two states the page's CSS says, and one named. */
const TRANSITION: NonNullable<MotionView["open"]> = {
  ...MOTION.open!,
  kind: "transition",
  name: "transition",
  readOnly: true,
  states: ["hover", "active", ".open on section.hero"],
  state: ".open on section.hero",
  triggers: [".open on section.hero"],
  above: [
    { path: "section > div", text: "Start free trial Book a demo", aside: "div.cta" },
    { path: "section", text: "Ship calmer interfaces", aside: "section.hero" },
    { path: "body", text: "body", aside: "body" },
    { path: "html", text: "html", aside: "html" },
  ],
  shared: 1,
  timing: { duration: 180, delay: 0, easing: "ease", count: "1", direction: "normal", fill: "none" },
  starts: null,
  T: 180,
  frames: [0, 100],
  lanes: [
    { prop: "background-color", keys: [{ at: 0, value: "rgb(233, 233, 236)" }, { at: 100, value: "rgb(207, 207, 214)" }], eases: ["ease"] }, // kkrll-ignore: the page's colours, as data
    { prop: "translate", keys: [{ at: 0, value: "none" }, { at: 100, value: "0px 8px" }], eases: ["ease"] },
  ],
  key: null,
  css: "button.ghost {\n  transition: background-color 180ms ease,\n    translate 180ms ease;\n}",
  score: [],
  dirty: false,
}

/** A few of the dock's acts, done to the sample view; the rest change nothing. */
// ── "This page on this phone", as the overlay would work it out for the pricing page ───────────
const FACTS: FactsView = {
  viewport: { w: 390, h: 844 },
  doc: { w: 524, h: 3880 },
  meta: true,
  partial: false,
  marks: true,
  wide: { items: [{ id: 1, label: "table.compare", detail: "+134 px" }, { id: 2, label: "div.card", detail: "+46 px" }], total: 2 },
  taps: {
    items: [
      { id: 3, label: "Monthly", detail: "64 × 32" },
      { id: 4, label: "Yearly", detail: "56 × 32" },
      { id: 5, label: "Close", detail: "24 × 24" },
      { id: 6, label: "a.footer-link", detail: "38 × 20" },
      { id: 7, label: "Compare every feature in detail", detail: "212 × 22" },
    ],
    total: 5,
  },
  small: { items: [{ id: 8, label: "Work email", detail: "14 px" }, { id: 9, label: "Team size", detail: "13 px" }], total: 2 },
}
const FACTS_CLEAR: FactsView = { ...FACTS, doc: { w: 360, h: 3240 }, wide: { items: [], total: 0 }, taps: { items: [], total: 0 }, small: { items: [], total: 0 } }
let factsMarks = false
/** The sample, at the size of the phone the mock shows. */
function factsView(): FactsView {
  const q = new URLSearchParams(location.search)
  const phone = phoneOf(q.get("phone"))
  const sample = structuredClone(q.get("facts") === "clear" ? FACTS_CLEAR : FACTS)
  return { ...sample, viewport: { w: phone.width, h: phone.height }, marks: factsMarks }
}

/** What the facts pane asks: its view when it is shown, nothing once it goes. */
function factsAct(a: PanelAct, out: (m: PanelMessage) => void): void {
  if (a.panel !== "facts") return
  const act = a.act
  if (act.type === "ping") out({ panel: "facts", pong: act.id })
  else if (act.type === "view" || act.type === "refresh") {
    if (act.type === "view" && act.marks !== undefined) factsMarks = act.marks
    setTimeout(() => out({ panel: "facts", view: factsView() }))
  } else if (act.type === "marks") {
    factsMarks = act.on
    out({ panel: "facts", view: factsView() })
  } else if (act.type === "stop") out({ panel: "facts", view: null })
}

/** What the window's inspector asks that the screenshots show: the footer's list of edits. */
function canvasAct(a: PanelAct, out: (m: PanelMessage) => void): void {
  if (a.panel !== "canvas") return
  const act = a.act
  if (act.type === "edits") out({ panel: "canvas", view: canvasView(act.open) })
}

function motionAct(a: PanelAct, out: (m: PanelMessage) => void): void {
  if (a.panel !== "motion") return
  const act = a.act
  const o = MOTION.open!
  if (act.type === "ping") return out({ panel: "motion", pong: act.id })
  if (act.type === "view") MOTION.view = act.view
  else if (act.type === "rate") MOTION.rate = act.rate
  else if (act.type === "loop") MOTION.loop = act.on
  else if (act.type === "isolate") MOTION.isolate = act.on
  else if (act.type === "backdrop") MOTION.backdrop = act.value
  else if (act.type === "row" && act.id.startsWith("transition")) MOTION.open = structuredClone(TRANSITION)
  else if (act.type === "state") o.state = act.value
  else if (act.type === "record") o.recording = act.on
  else if (act.type === "trigger") (o.states.push(act.text), o.triggers.push(act.text), (o.state = act.text))
  else if (act.type === "untrigger") (o.states = o.states.filter((s) => s !== act.value), o.triggers = o.triggers.filter((s) => s !== act.value), (o.state = o.states[0] ?? null))
  else if (act.type === "play") MOTION.clock.playing = !MOTION.clock.playing
  else if (act.type === "seek") MOTION.clock.pos = act.p
  else if (act.type === "note") MOTION.note = act.text
  else if (act.type === "timing" && act.what !== "how") (o.timing as Record<string, unknown>)[act.what] = act.what === "duration" || act.what === "delay" ? Number(act.value) : act.value
  else if (act.type === "select") {
    const lane = act.key && o.lanes.find((l) => l.prop === act.key!.prop)
    const k = act.key && lane?.keys.find((x) => x.at === act.key!.at)
    o.key = act.key && k ? { at: k.at, prop: lane!.prop, value: k.value, ease: "", dflt: o.timing.easing, last: k.at >= 100, editable: o.kind !== "transition" || k.at >= 100, props: 1 } : null
  } else if (act.type === "row" && act.id.startsWith("frames|")) {
    // (What a script moves frame by frame, opened: what was seen of it.)
    for (const r of MOTION.rows) if ("id" in r) r.on = r.id === act.id
    MOTION.sel = "Block · .meter i"
    Object.assign(o, { kind: "frames", name: "per frame", readOnly: true, timed: false, shared: 1, lanes: [], frames: [], score: [], key: null, css: "", dirty: false, T: 1, starts: null, timing: { duration: 4400, delay: 0, easing: "linear", count: "1", direction: "normal", fill: "none" }, seen: { props: [{ prop: "width", range: "0…100%" }, { prop: "transform", range: "translate3d(0…40px, 3px, 0px)" }], cycle: 4400, over: 9000, watching: false } })
  } else if (act.type !== "resend") return
  out({ panel: "motion", view: structuredClone(MOTION) })
}

// ── the page's design system (ds-space.tsx): a made-up one, with every kind of variable ─────────
const ramp = (base: string, hue: number, chroma: number, steps: number[]): Token[] =>
  steps.map((n, i) => {
    const value = `oklch(${(0.97 - (i / (steps.length - 1)) * 0.8).toFixed(3)} ${(chroma * Math.sin(((i + 1) / (steps.length + 1)) * Math.PI)).toFixed(3)} ${hue})`
    return { name: `--${base}-${n}`, kind: "colour", value, where: [{ scope: ":root", value }], uses: (i * 7) % 5 }
  })
const TONES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const one = (name: string, kind: Token["kind"], value: string, more: Partial<Token> = {}): Token => ({ name, kind, value, where: [{ scope: ":root", value }], uses: 3, ...more })
const TOKENS: Token[] = [
  ...ramp("sand", 70, 0.05, [0, 100, 200, 300, 400]),
  ...ramp("gray", 260, 0.02, TONES),
  ...ramp("brand", 145, 0.19, TONES),
  ...ramp("red", 25, 0.22, TONES),
  one("--ink", "colour", "oklch(0.25 0.02 260)", { where: [{ scope: ":root", value: "var(--gray-900)" }, { scope: ".dark", value: "var(--gray-50)" }], uses: 41 }),
  one("--surface", "colour", "#ffffff", { where: [{ scope: ":root", value: "#ffffff" }, { scope: ".dark", value: "var(--gray-950)" }], uses: 28 }),
  one("--accent", "colour", "oklch(0.62 0.19 145)", { where: [{ scope: ":root", value: "var(--brand-500)" }], uses: 17 }),
  one("--overlay", "colour", "rgb(0 0 0 / 0.4)", { uses: 2 }),
  one("--background", "colour", "0 0% 100%", { css: "hsl(0 0% 100%)", where: [{ scope: ":root", value: "0 0% 100%" }, { scope: "@media (prefers-color-scheme: dark) :root", value: "240 10% 3.9%" }], uses: 9 }),
  one("--ring", "colour", "#b1a79f", { uses: 0 }),
  one("--paper", "colour", "#fefefe", { uses: 4 }),
  ...[1, 2, 3, 4, 6, 8, 12, 16].map((n) => one(`--space-${n}`, "size", `${n * 0.25}rem`, { size: n * 4, uses: n })),
  one("--radius-sm", "size", "4px", { size: 4 }),
  one("--radius-md", "size", "8px", { size: 8 }),
  one("--radius-lg", "size", "12px", { size: 12 }),
  one("--container", "size", "72rem", { size: 1152 }),
  one("--font-sans", "font", "Inter, system-ui, sans-serif", { uses: 2 }),
  one("--font-mono", "font", "ui-monospace, Menlo, monospace", { uses: 1 }),
  one("--shadow-sm", "shadow", "0 1px 2px rgb(0 0 0 / 0.12)"),
  one("--shadow-lg", "shadow", "0 12px 32px -8px rgb(0 0 0 / 0.3)"),
  one("--duration-fast", "time", "120ms"),
  one("--duration-slow", "time", "400ms"),
  one("--ease-out", "ease", "cubic-bezier(0.16, 1, 0.3, 1)"),
  one("--leading-tight", "number", "1.2", { size: 1.2 }),
  one("--btn-bg", "colour", "oklch(0.62 0.19 145)", { where: [{ scope: ".btn", value: "var(--accent)" }], uses: 1, local: true }),
]
const tokensSet = new Map<string, string>()
function tokensView(): TokensView {
  return {
    tokens: TOKENS.map((t) => {
      const set = tokensSet.get(t.name)
      if (set === undefined) return t
      const { css: _css, ...rest } = t
      return { ...rest, value: set, set, was: t.value, ...(t.css ? { css: `hsl(${set})` } : {}) }
    }),
    loose: [
      { kind: "colour", value: "#b1a79f", rules: 14, where: [".card", ".nav a", ".footer"], tokens: ["--ring"] },
      { kind: "colour", value: "#767584", rules: 6, where: [".hint", ".price small"], tokens: [] },
      { kind: "space", value: "18px", rules: 5, where: [".hero", ".plan"], tokens: [] },
      { kind: "radius", value: "8px", rules: 4, where: [".btn", ".input"], tokens: ["--radius-md"] },
    ],
    unread: 1,
    partial: false,
  }
}
function tokensAct(a: PanelAct, out: (m: PanelMessage) => void): void {
  if (a.panel !== "tokens") return
  const act = a.act
  if (act.type === "ping") return out({ panel: "tokens", pong: act.id })
  if (act.type === "stop") return out({ panel: "tokens", view: null })
  if (act.type === "set") act.value ? tokensSet.set(act.name, act.value) : tokensSet.delete(act.name)
  if (act.type === "reset") tokensSet.clear()
  setTimeout(() => out({ panel: "tokens", view: tokensView() }))
}

// What the overlay would tell the window's inspector (CanvasView in overlay/protocol-canvas.ts)
// about the mock's pricing page with its middle card selected: for the mock (mock.ts) and the
// screenshots (scripts/shot.mjs, "canvas-dock" and "phone-dock"; "canvas-dock-edits" with the
// footer's list of edits open: the mock answers the "edits" act). A rejected declaration is in
// Element styles, so the underline and the error line show too.
import type { CanvasEdit, CanvasRow, CanvasView } from "../../../overlay/protocol-canvas"

let next = 1
const row = (depth: number, tag: string, kids: CanvasRow["kids"], extra: Partial<CanvasRow> = {}): CanvasRow => ({
  id: next++,
  depth,
  tag,
  idName: "",
  cls: "",
  text: "",
  kids,
  ...extra,
})

const ROWS: CanvasRow[] = [
  row(0, "body", "open", { cls: ".antialiased" }),
  row(1, "header", "shut", { cls: ".site-header.sticky" }),
  row(1, "main", "open", { idName: "#content" }),
  row(2, "section", "shut", { cls: ".hero" }),
  row(2, "section", "open", { idName: "#plans", cls: ".plans.grid.gap-4" }),
  row(3, "h2", "none", { cls: ".plans-title", text: "Pick a plan" }),
  row(3, "article", "shut", { cls: ".card", ed: true }),
  row(3, "article", "open", { cls: ".card.card-pro" }),
  row(4, "h3", "none", { cls: ".card-title", text: "Pro" }),
  row(4, "p", "none", { cls: ".card-lead", text: "For small teams" }),
  row(4, "ul", "shut", { cls: ".features" }),
  row(4, "a", "none", { cls: ".btn.btn-primary", text: "Start free trial" }),
  row(3, "article", "shut", { cls: ".card", hid: true }),
  row(2, "section", "shut", { cls: ".faq" }),
  row(2, "section", "shut", { cls: ".cta" }),
  row(1, "footer", "shut", { cls: ".site-footer" }),
]
const SELECTED = ROWS[7]!

const CSS = "padding: 24px;\nborder-radius: var(--radius-lg);\ngap: 12px;\ncolor: brand;"

/** The batch's three edits, as the footer's list has them once it is opened ("edits"). */
const EDITS: CanvasEdit[] = [
  { key: `css 1`, label: "Card · Pro For small teams", text: "padding 16 → 24, border-radius 8 → 12, gap 8 → 12", id: SELECTED.id },
  { key: `op 0 hide 2`, label: "Card · Enterprise Talk to us", text: "hidden", id: ROWS[12]!.id },
  { key: "sheet", label: "Stylesheet", text: "1 rule" },
]

export function canvasView(list = false): CanvasView {
  return {
    force: 1,
    // (What it is, never what it says: its component's name, the tree's name in the title.)
    sel: { id: SELECTED.id, label: "PricingCard", tag: "article.card.card-pro", hidden: false },
    global: false,
    classes: { text: "card card-pro", long: false },
    css: { text: CSS, marks: [{ s: CSS.indexOf("color"), e: CSS.length - 1, why: "invalid value for color" }], error: "Not applied: invalid value for color" },
    sheet: { text: ".card-pro .btn { width: 100%; }", marks: [], error: "" },
    computed: [
      { prop: "display", value: "flex" },
      { prop: "flex-direction", value: "column" },
      { prop: "align-items", value: "stretch" },
      { prop: "justify-content", value: "normal" },
      { prop: "gap", value: "12px", tokens: ["--space-3"], tokenTitle: "The page's variable with this value · click to write gap: var(--space-3)", mine: true },
      { prop: "width", value: "268px" },
      { prop: "height", value: "312.5px" },
      { prop: "padding", value: "24px", tokens: ["--space-6"], tokenTitle: "The page's variable with this value · click to write padding: var(--space-6)", mine: true },
      { prop: "margin", value: "0px" },
      { prop: "font-family", value: "Inter, system-ui, sans-serif", tokens: ["--font-sans"], tokenTitle: "The page's variable with this value · click to write font-family: var(--font-sans)" },
      { prop: "font-size", value: "16px", tokens: ["--text-base"], tokenTitle: "The page's variable with this value · click to write font-size: var(--text-base)" },
      { prop: "font-weight", value: "400" },
      { prop: "line-height", value: "24px" },
      { prop: "letter-spacing", value: "normal" },
      { prop: "color", value: "#1c1c1a", tokens: ["--ink"], tokenTitle: "The page's variable with this value · click to write color: var(--ink)" },
      { prop: "background-color", value: "#ffffff", tokens: ["--surface"], tokenTitle: "The page's variable with this value · click to write background-color: var(--surface)" },
      { prop: "border-radius", value: "12px", tokens: ["--radius-lg"], tokenTitle: "The page's variable with this value · click to write border-radius: var(--radius-lg)", mine: true },
    ],
    tokens: [
      { name: "--brand", value: "#2a6df4" },
      { name: "--font-sans", value: "Inter, system-ui, sans-serif" },
      { name: "--ink", value: "#1c1c1a" },
      { name: "--radius-lg", value: "12px", size: 12 },
      { name: "--radius-md", value: "8px", size: 8 },
      { name: "--radius-sm", value: "4px", size: 4 },
      { name: "--space-1", value: "4px", size: 4 },
      { name: "--space-2", value: ".5rem", size: 8 },
      { name: "--space-3", value: "12px", size: 12 },
      { name: "--space-4", value: "16px", size: 16 },
      { name: "--space-6", value: "24px", size: 24 },
      { name: "--surface", value: "#ffffff" },
      { name: "--text-base", value: "16px", size: 16 },
    ],
    tree: { total: ROWS.length, first: 0, rows: ROWS, sel: 7, hover: ROWS[11]!.id },
    batch: { edits: 3, undo: true, redo: false, note: "", msg: "", status: "", ...(list ? { list: EDITS } : {}) },
  }
}

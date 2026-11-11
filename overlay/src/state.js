const VERSION = "0.1.0";
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);
const DRAG_PX = 5;
const CAPTURE_TIMEOUT_MS = 2000;

// ── host bridge ─────────────────────────────────────────────────────────────────────────────
const send = (msg) => {
  const fn = window.__review;
  if (typeof fn !== "function") return;
  try {
    fn(JSON.stringify(msg));
  } catch (err) {
    console.warn("[b42] send failed", err);
  }
};

// ── state (transient only) ──────────────────────────────────────────────────────────────────
const S = {
  enabled: false,
  hover: null, // Element
  sel: [], // Element[]
  area: null, // {x,y,w,h} document coords
  strokes: [], // [[[x,y],…]] document coords
  drag: null, // {x0,y0,x,y,mode,pts,shift}
  card: false,
  brush: false, // the host's brush is on: a plain drag draws
  pending: null, // note id awaiting "captured"
  quiet: null, // that id when it is a canvas note: the bar says "Sent", not a chip over the page
  buffered: null, // a click made while pending: {x,y,shift}
  pins: [], // [{id,n,status,selector?,at?,el?}]
  images: [], // [{name,uri}] pictures pasted into the note
  templates: [], // [{name,hint}] from the host; empty when the host has none
  template: null, // name of the template chosen for this note
  menu: null, // templates matching what is typed after "/", while that list is open
  menuAt: 0,
  undo: null, // a note dropped with Esc, restorable for a few seconds
  unplaced: "",
};

let corner, bar, insp, cv, cnote, treeEl, trows, tspace, clsEl, cssEl, freeEl, compEl, ipath, bandEl, ghostEl, insEl, labEl, dimEl, handles, edges, hitEl, gzEl, shieldEl;
let hostEl, root, ink, strokesEl, pencil, boxes, pinsEl, card, what, refs, textarea, cursorStyle, tip, sentEl, chip, menuEl, variantsEl, variantStyle;
const PLACEHOLDER = "Note…"; // what else the card does (/, a pasted picture) is behind its "?"
// The card's keys: behind its "?", shown while the pointer (or focus) is on it. The card itself
// carries no instructions, only what is being noted and the ↵ that sends it.
const CARD_KEYS = [
  ["↵", "send"],
  [isMac ? "⌥↵" : "alt+↵", "send, to work in parallel"],
  ["/", "templates"],
  [isMac ? "⌘V" : "ctrl+V", "attach a copied picture"],
  ["↑ ↓", "parent, child (note empty)"],
  [isMac ? "⌘Z" : "ctrl+Z", "undo a stroke"],
  ["esc", "cancel the note"],
];
let cardAt = null; // where the note card last sat: the "Sent" chip appears there
let sentTimer = 0;
let raf = 0;
let draftTimer = 0;
let domVersion = 0; // bumped on every DOM mutation; pins re-search only when it changes


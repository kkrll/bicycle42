// ── stand-ins ───────────────────────────────────────────────────────────────────────────────
// Names motion mode still calls as they were before notes mode was a module. Each is a stand-in
// until motion mode asks Notes for it directly, and goes then.
const hasDraft = () => Notes.hasDraft(); // stand-in: motion/draw.js
const clearDraft = () => Notes.clearDraft(); // stand-in: motion/draw.js
const hideSent = () => Notes.hideSent(); // stand-in: motion/draw.js

/*
 * bicycle 42 overlay: the in-page review layer.
 *
 * One dependency-free script. A host (the Electron app, or the test harness) injects
 * it into the page under review. The overlay draws outlines, strokes, the note card and pins, and
 * reports notes to the host. It keeps NO durable state: drafts and pins live in the host, so a hot
 * reload of the page loses nothing (the host sends them back on "ready").
 *
 * ── Protocol ────────────────────────────────────────────────────────────────────────────────────
 * page → host   window.__review(JSON.stringify(msg))      (a CDP Runtime.addBinding, or a shim)
 * host → page   window.__b42.receive(msg)
 * host → page, sync  window.__b42.busy()                true while the reviewer is mid-note
 * Every message of both directions, and what a note, a draft and a pin carry, are types in
 * ../protocol.ts (PageMessage, HostMessage, PageNote, Draft, Pin), shared with the app.
 *
 * Modes: mod+U Preview (pressed again, back to the mode it left) · mod+P Annotate (notes) · mod+shift+P
 * the brush · mod+O Edit (canvas) · mod+I Motion. By the key's place (KeyU…), so any layout has them.
 * Inside the page they are the overlay's.
 *
 * Gestures (review mode on): hover outlines · click selects · shift+click adds · drag selects an
 * area · alt+drag draws (a closed loop selects what it encloses) · ↑/↓ parent/child (when the note
 * is empty, or with alt) · Enter sends · alt+Enter sends to the background · Esc cancels, then exits · mod+Z undoes a stroke (empty note).
 * The host's brush makes a plain drag draw, as alt+drag does, until the note is sent or cancelled.
 *
 * Canvas mode ("Edit" to the reviewer; mod+O, or the host's switch; review mode on): the page's real elements are edited and
 * the batch goes out as one note. An inspector docks at the bottom: DOM tree, class line, "Element
 * styles" (declarations for the selected element), "Stylesheet" (new rules), computed values.
 * click selects · drag reorders inside a flex or grid parent · drag an edge or corner resizes ·
 * drag the space between flex/grid items changes the gap (mod: no snapping) · double-click edits
 * text · Delete hides · mod+Z / mod+shift+Z undo, redo · Enter sends (mod+Enter from the
 * inspector's fields) · Esc: leave the field, deselect, then back to notes.
 * The bar's count opens the list of edits in the batch (a row selects its element, its × removes that
 * edit); "?" lists these keys. After sending, the bar says the preview stays until the note is done.
 * Previews never touch the page's inline styles: styles, order and hiding are rules in constructed
 * stylesheets; class and text edits write the DOM and are re-applied when a framework re-renders.
 * An edited element without an id of its own carries a `data-b42e` attribute while a batch names
 * it: the edit's rules select by it, so the edit stays on its element when the page moves it.
 * A sent batch stays applied until its pin is done, failed or stopped, or the page reloads.
 *
 * Motion mode (mod+I, or the host's switch; review mode on): what moves on the page, listed in a dock at the
 * bottom (CSS animations, transitions, the Web Animations API, frame-by-frame scripts), and one
 * animation open in a timeline: a lane per property, a bar between two keyframes, a grip on each.
 * click an element or a row · drag a grip in time · press twice on a lane to add a keyframe ·
 * space plays · ←/→ steps · Delete removes the keyframe · mod+Z / mod+shift+Z undo, redo · Enter
 * sends the open animation as one note (with the words typed for it) · Esc: deselect, then back to
 * notes. Keyframes belong to their name and to every element that plays them; duration, delay,
 * easing and the rest belong to the element. Previews are rules in a constructed stylesheet, as in
 * canvas mode; a sent animation stays applied until its pin is done, failed or stopped.
 */

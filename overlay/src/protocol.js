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
 *   { type: "ready", url, viewport }                      overlay mounted; host replies with "state"
 *   { type: "toggle", enabled? }                          mod+U (Preview: review off, or back on), or Esc
 *                                                         with nothing selected; enabled: true from mod+P/O/I
 *                                                         or mod+shift+P while review is off (the mode
 *                                                         follows once it is on)
 *   { type: "mode", mode: "notes"|"canvas"|"motion", brush }  the mode or the brush changed (also sent
 *                                                         after every "state"). The host has the
 *                                                         switch for both; the layer has none
 *   { type: "draft", draft | null }                       current unsent note, debounced
 *   { type: "note", note }                                submitted; card is hidden, outlines and
 *                                                         strokes stay drawn until "captured".
 *                                                         note.lane is "bg" when sent with alt+Enter
 *                                                         (to the host's background session)
 *   { type: "pins-placement", unplaced: [id] }            pins whose element can't be found (shown
 *                                                         at their stored position, if any, dimmed)
 *   { type: "pin", id }                                   a pin was clicked
 *   { type: "edits-shown", id, show }                     reply to "edits", two frames after the page
 *                                                         changed; id and show are echoed as received
 *
 *   A note made in canvas mode carries, besides the usual fields:
 *     note.edits?: Edit[]   at most 40. Kinds sent: "style" { css, changes: [{prop, from, to}] } (typed
 *                           declarations and resize/gap drags, one per element), "class" { from, to },
 *                           "move" { parent, fromIndex, toIndex, before }, "text" { from, to }, "hide".
 *                           Each has selector, tag, label, component?, repeated?.
 *     note.css?: string     the batch stylesheet (new rules), verbatim
 *     note.targets          the edited elements; note.bounds their rects before and after, united
 *   The draft carries the unsent batch as draft.edits (opaque: { els, sheet, ops }), draft.paths
 *   (where its elements were, to find them after a reload) and draft.note.
 *
 *   A note made in motion mode is about one animation, and carries:
 *     note.motion           { kind: "keyframes"|"transition"|"script", name, selector, label,
 *                             shared?, isNew?, from?, animation?: { to, from? }, keyframes?: { to, from? },
 *                             changes?: [{ prop, from, to }], starts?, current? } (see `Motion` in
 *                             app/src/main/review.ts). Its words may be empty when it changes something.
 *   The draft carries the unsent motion edits as draft.motion (opaque: { kf, use, note? }).
 *
 * host → page   window.__b42.receive(msg)
 *   { type: "state", enabled, draft?, pins?, templates? } templates: [{ name, hint }], offered after "/"
 *   { type: "enabled", enabled }
 *   { type: "mode", mode?: "notes"|"canvas"|"motion", brush? }  the host's switch. brush: true goes to notes
 *                                                         mode first: the brush belongs to it
 *   { type: "pins", pins: [Pin] }
 *       Pin = { id, n, status: queued|working|done|failed|paused|stopped, lane?: "bg", note?,
 *               selector?, tag?, text?, component?,      from the note's first target, for re-finding
 *               at?: [x, y] }                            document coords, the last-resort position
 *   { type: "captured", id }                              screenshot taken; clear the selection.
 *                                                         Clicks made before this are held, then applied
 *   { type: "captured", id, ok: false, why? }             the host did not take the note: nothing is
 *                                                         cleared, the card (or the canvas batch) comes
 *                                                         back and says why. A host answers every note
 *                                                         one way or the other; with no answer in 2 s
 *                                                         the note counts as taken (a slow screenshot)
 *   { type: "edits", id, show }                           hide (show: false) or show again everything
 *                                                         the sent canvas note `id` applied: styles,
 *                                                         classes, text, order, its stylesheet. While
 *                                                         any batch is hidden the layer's own chrome is
 *                                                         hidden too, as during a capture
 *
 * host → page, sync  window.__b42.busy()                true while the reviewer is mid-note (card
 *                                                         open, selection, drag, capture): a host
 *                                                         that reloads the page waits for false
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

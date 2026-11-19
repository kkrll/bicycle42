// Canvas mode's inspector when the host draws it (see Dock in protocol.ts): what the inspector
// shows, and what the reviewer can do in it. Types only.
//
// The overlay keeps everything that is the page's: the selection and its outlines, the handles
// and the drags, the bar over the page, the batch, its undo and its previews, sending the note.
// The host's inspector is a drawing of `CanvasView` and a source of `CanvasAct`s; it keeps
// nothing the overlay does not also have, so a reload of either side loses nothing.

/** Everything the inspector shows. (Not yet anything: the host draws no inspector.) */
export type CanvasView = Record<string, never>

/** One thing done in the inspector. (None yet.) */
export type CanvasAct = never

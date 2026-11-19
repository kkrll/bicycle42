// Motion mode's dock when the host draws it (see Dock in protocol.ts): what the dock shows, and
// what the reviewer can do in it. Types only.
//
// The overlay keeps everything that is the page's: finding what moves, the keyframes and the
// timing as the page has them, the edits and their undo, playing and seeking, sending the note.
// The host's dock is a drawing of `MotionView` and a source of `MotionAct`s; it keeps nothing
// the overlay does not also have, so a reload of either side loses nothing.

/** Everything the dock shows. (Not yet anything: the host draws no motion dock.) */
export type MotionView = Record<string, never>

/** One thing done in the dock. (None yet.) */
export type MotionAct = never

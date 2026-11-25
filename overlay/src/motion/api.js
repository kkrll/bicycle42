import { M } from "./model.js";
import { letGo, openCss, pause, play, position, seek, selectEl } from "./open.js";
import { rows, setKey, setTiming } from "./edit.js";
import { draft, dropFinished, finish, refuse, restore, submit } from "./send.js";
import { busyFrames, frame, resume, setOn, syncUi } from "./draw.js";
import { key, mount, pointerDown, pointerMove, pointerUp } from "./input.js";
import { unstage } from "./stage.js";

// ── what the rest of the overlay sees ───────────────────────────────────────────────────────
export { mount, setOn, resume, syncUi, letGo, unstage, frame, busyFrames, key, pointerDown, pointerMove, pointerUp, submit, refuse, finish, dropFinished, draft, restore };
export const on = () => M.on;
export const hasSent = () => M.sent.length > 0;
export { recording } from "./record.js";
export const busy = () => !!M.drag;
/** For tests: the engine's state and a few actions. */
export const debug = { M, seek, play, pause, position, select: selectEl, openCss, setTiming, setKey, rows };

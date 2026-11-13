// ── what the rest of the overlay sees ───────────────────────────────────────────────────────
const api = {
  on: () => M.on,
  mount, setOn, resume, syncUi, letGo, frame, busyFrames, key, pointerDown, pointerMove, pointerUp, submit, refuse, finish, dropFinished, draft, restore,
  hasSent: () => M.sent.length > 0,
  busy: () => !!M.drag,
  /** For tests: the engine's state and a few actions. */
  debug: { M, seek, play, pause, position, select: selectEl, openCss, setTiming, setKey, rows },
};

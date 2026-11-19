# overlay

The in-page review layer of bicycle 42: `overlay.js` (one dependency-free script that a host
injects into the page) and `prompt.js` (note → prompt text). The protocol between the overlay and
its host is in [`protocol.ts`](protocol.ts): the messages of both directions and what a note
carries, as types the overlay's files and the app both name. What it is for and its keys are in the
[root README](../README.md).

`overlay.js` is built, not written. [`src/`](src) is ES modules; `bun run build` has esbuild
follow the imports from `src/mount.js` and put every file into one scope, unminified, inside one
function whose first statement stops a second copy ([`scripts/build.mjs`](scripts/build.mjs)).
The result is a classic script with no imports of its own. The harness server builds it on every
request, the app's build and the benchmark build it themselves; it is not committed.

## Source

```
protocol.ts         the messages between the overlay and its host, and a note's shape: types only, shared with the app
protocol-motion.ts  motion's dock when the host draws it: what it shows, what is done in it (types only)
protocol-canvas.ts  the same for canvas's inspector
src/protocol.js     what the overlay is, its keys and its gestures (a comment: the built script starts with it)
src/state.js        the host bridge, the transient state
src/ui.js           the layer's icons, and words with key symbols drawn in them
src/component.js    what the page's framework calls an element, read from the page's own objects
src/page.js         geometry, element identity, picking, the rules previews adopt
src/draft.js        the draft the host keeps: the note in progress, canvas's batch, motion's animations
src/variants.js     the page's own variants, switched from a small bar
src/sent.js         the pins' tooltip; a note from any mode sent, and the host's answer
src/mode.js         which mode is on, the one switch between them, the host's switch, the brush
src/input.js        the page's pointer and keys: what every mode shares, then the mode that is on
src/render.js       one frame at a time: each mode's part, the outlines, the pins
src/picture.js      for the host's own picture: the layer out of it and the page scrolled, then back; a pin brought into view
src/room.js         the room under a dock: the page laid out as if the window ended where the dock begins
src/panel.js        the docks the host draws itself: which they are, their views out, their acts in
src/mount.js        the layer's elements and its shadow root, the host's API (window.__b42); the build starts here
src/styles.css      the layer's styles, imported as text
src/notes/          notes mode: a note about the page, its outlines, area and strokes, on a card
src/canvas/         canvas mode: the page's real elements edited, the batch sent as one note
src/motion/         motion mode: what moves on the page, one animation per note
src/lookup.js       the small second script (overlay-lookup.js): component.js and its listener
src/globals.d.ts    what the type check cannot read from the .js files
```

- **A mode is a folder, and the rest of the overlay sees only its `api.js`**, imported whole
  (`import * as Canvas from "./canvas/api.js"`). The files of a mode import each other freely.
- **A file can only assign what it declares.** What a mode's `mount` finds in the layer is
  declared in that mount's file and exported; the other files read it. State that many files
  change is a property of an object (`S`, canvas's `C`, motion's `M`), never a variable.
- **`component.js` stands alone**: it is also built into `overlay-lookup.js`, which a host that
  gives the overlay a script world of its own adds among the page's scripts (`buildLookup()`).
- **Function names are kept** (esbuild's `keepNames`) where one scope would rename them: the
  benchmark counts the overlay's frames by the name of the function asked for.
- **`src/canvas/css-data.js` is generated** by `scripts/css-data.mjs` (Chrome's CSS properties, their
  keyword values and popularity, from Blink and DevTools; licences in `css-data.NOTICE`). Re-run it
  after an Electron upgrade, with the Chromium tag and DevTools branch at the top of the script updated.

- **A dock can be the host's.** Canvas's inspector and motion's dock are drawn here, at the bottom
  of the page, unless the host says it draws one itself (`{ type: "docks", hosted }`, `Dock` in
  `protocol.ts`). For such a dock a mode asks `hosted(name)` (`src/panel.js`) wherever it would
  show its dock or measure it, sends the whole of what the dock shows with `sendView` (once a
  frame at most) and takes what the host's dock asks with `onAct`. Everything that is the page's
  stays here: the selection, the edits and their undo, playing, sending. Motion's side of it is
  `src/motion/host.js`: where the dock would be drawn a view is built instead, and each act calls
  what the in-page dock's gesture calls. In the harness,
  `__harness.hostDocks(["motion"])` plays such a host, `__harness.act(panel, act)` its dock, and
  `__harness.panel` holds what the overlay sent. Canvas's is `src/canvas/host.js`: the view is
  made in the frames the layer's inspector would be drawn in, the acts call what its fields, rows
  and keys call (`test/canvas-hosted.test.mjs`).
- **"facts" is a pane only the host draws** (`Pane` in `protocol.ts`, `protocol-facts.ts`,
  `src/facts/host.js`): what the page is at the size it is shown at (what sticks out past the
  right edge, tap targets under 44 px, fields under 16 px, the viewport tag), each fact an
  element the host's rows can outline ("hover"), bring into view ("show") or, in notes mode,
  select for a note ("note"). Nothing is worked out until the host's pane says "view", and
  nothing after "stop": in between, after load, on resize and after the page changed (400 ms
  apart at least, in idle time, 4000 elements at most), with review on or off. Scrolling only
  sends the new `scrollY`. A new document sends the view null, so a host whose pane is up asks
  again. `?page=facts` is its harness page (`test/facts-hosted.test.mjs`).

![harness](docs/harness.png)

## Harness

```bash
bun install          # esbuild for the build, typescript for the check, playwright-core for the tests (it uses your installed Chromium)
bun run harness      # http://127.0.0.1:4173/   (HOST=0.0.0.0 to reach it from another machine)
```

The harness plays the host: a sample page in an iframe, a fake agent queue (queued → working →
done, `?delay=1500` ms per note), the prompt each note would produce, device widths, and
**Reload page** / **Re-render** buttons to check that drafts and pins survive.
`harness/canvas.html` is the page the canvas-mode tests use, and `?page=motion` loads
`harness/motion-page.html` (animations, transitions, a script's `animate()`, a frame-by-frame
bar) for motion mode and its tests.

## Test

```bash
bun run check                          # tsc over src/: names and module members that resolve nowhere, messages that are not the protocol's; a few seconds
bun run test                           # end-to-end tests in headless Chromium, about a minute
CHROMIUM=/path/to/chrome bun run test  # when the tests do not find your Chromium
node scripts/screenshot.mjs        # regenerates docs/harness.png
```

## Benchmark

```bash
bun run bench                                  # the overlay as src/ has it, about six minutes
bun run bench -- path/to/overlay.js            # a built copy
bun run bench -- --json out.json               # also writes every window's numbers
bun run bench -- --cells strokes,selected      # only some states
BENCH_GPU=1 bun run bench                      # drawn by the graphics card, as in the app
git stash && bun run build -- /tmp/old.js && git stash pop && bun run bench -- --compare /tmp/old.js
```

What the overlay costs the page under review, state by state (`bench/cells.mjs`): review off
(still, with the pointer moving, the wheel, the page scrolling itself, the page changing), on
and idle, an element selected (on a still page and on one that changes), four strokes drawn,
strokes while scrolling, a stroke being drawn, typing in the note card, the pointer moving,
canvas mode (a selection, after a drag, during a resize drag), motion mode with an animation
open, pins that are missing, scrolled past (twenty, then two hundred) or working. The pages are
made in memory: `heavy` (5,000 elements) and `churn` (2,000, one text changing every frame).
Each state settles, then is measured over three windows of 3 s; the table shows the median, per
second: main-thread, script, layout, style-recalc, paint, raster and GPU milliseconds and counts
from Chromium, and four counts of the overlay's own: frames, timers fired, stroke path writes
and document searches.

The `none` states are the pages with no overlay at all (still, changing, under the pointer, the
wheel, with an animation): the page's own cost. Each other state's `own ms` is its busy ms less
that of the `none` state with the same page and gesture, so it is the overlay's own
milliseconds. `--cells` measures a state's baseline with it.

Below the table are the invariants, checked from counts only (milliseconds depend on the
machine): with review off and no pins there are no frames, no timers and no searches, whatever
the pointer, the wheel or the page does; idle is the 250 ms tick, with an element selected,
strokes drawn or a canvas selection too; a selection or drawn strokes cause no layout, no style
recalc and no path writes while nothing moves; strokes cause no layout and no path writes while
the page scrolls, and strokes and pins (20 or 200) are painted at most 5 times a second then; on
a page that changes there is one chain of frames, not two, and a changed text is no reason to
search the document; typing lays out once a key; missing pins add at most 10 searches a second.
`hover` has none: what one outline that follows the pointer costs is in its raster ms. One that
fails exits with code 1. With
`--compare` each state has two rows (a: the first file, b: the other) and both lists of
invariants; only the first file decides the exit code. To judge a change, compare the counts
first, then the milliseconds of rows a and b (they are taken minutes apart at most, on the same
machine; run it twice if other work was going on). Headless Chromium draws in software unless
`BENCH_GPU=1` is set: raster and GPU milliseconds differ a lot between the two, counts do not.
The `hover` state is the worst case, a different element under the pointer on every move.

## What the overlay does and doesn't do

- **Does:** picking, outlines, area and stroke selection, the note card, pins, canvas mode (the
  inspector and direct manipulation), motion mode (what moves on the page, one animation's
  timeline, its preview, playback through the Web Animations API), element identity (selector, text, attributes, React/Vue
  component names and dev source location when present), blocking page input while active,
  holding clicks made during a capture, re-finding pins after a re-render or an agent's edit
  (selector → tag + text → last position, dimmed).
- **Doesn't:** screenshots, storage, sending, status, or the switch between notes, canvas and
  motion mode and the brush (it tells the host which it is in, and takes `{ type: "mode" }` from it).
  Those belong to the host, so the overlay survives hot reloads without losing anything.

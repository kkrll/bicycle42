# overlay

The in-page review layer of bicycle 42: `overlay.js` (one dependency-free script that a host
injects into the page) and `prompt.js` (note → prompt text). The protocol between the overlay and
its host is at the top of [`overlay.js`](overlay.js). What it is for and its keys are in the
[root README](../README.md).

![harness](docs/harness.png)

## Harness

```bash
npm install          # only playwright-core, for the tests; it uses your installed Chromium
npm run harness      # http://127.0.0.1:4173/   (HOST=0.0.0.0 to reach it from another machine)
```

The harness plays the host: a sample page in an iframe, a fake agent queue (queued → working →
done, `?delay=1500` ms per note), the prompt each note would produce, device widths, and
**Reload page** / **Re-render** buttons to check that drafts and pins survive.
`harness/canvas.html` is the page the canvas-mode tests use.

## Test

```bash
npm test                           # end-to-end tests in headless Chromium, about a minute
CHROMIUM=/path/to/chrome npm test  # when the tests do not find your Chromium
node scripts/screenshot.mjs        # regenerates docs/harness.png
```

## Benchmark

```bash
npm run bench                                  # overlay.js as it is here, two to three minutes
npm run bench -- path/to/overlay.js            # another copy
npm run bench -- --json out.json               # also writes every window's numbers
npm run bench -- --cells strokes,selected      # only some states
BENCH_GPU=1 npm run bench                      # drawn by the graphics card, as in the app
git show main:overlay/overlay.js > /tmp/old.js && npm run bench -- --compare /tmp/old.js
```

What the overlay costs the page under review, in twelve states (`bench/cells.mjs`): review off,
on and idle, an element selected, four strokes drawn, strokes while scrolling, the pointer
moving, canvas mode, pins that are missing, scrolled past or working. The pages are made in
memory: `heavy` (5,000 elements) and `churn` (2,000, one text changing every frame). Each state
settles, then is measured over three windows of 3 s; the table shows the median, per second:
main-thread, script, layout, style-recalc, paint, raster and GPU milliseconds and counts from
Chromium, and four counts of the overlay's own: frames, timers fired, stroke path writes and
document searches.

Below the table are the invariants, checked from counts only (milliseconds depend on the
machine): off costs no frames and no timers; idle is the 250 ms tick; a selection or drawn
strokes cause no layout, no style recalc and no path writes while nothing moves; strokes cause
no layout and no path writes while the page scrolls; there is one chain of frames, not two;
missing pins add at most 10 searches a second. One that fails exits with code 1. With
`--compare` each state has two rows (a: the first file, b: the other) and both lists of
invariants; only the first file decides the exit code. To judge a change, compare the counts
first, then the milliseconds of rows a and b (they are taken minutes apart at most, on the same
machine; run it twice if other work was going on). Headless Chromium draws in software unless
`BENCH_GPU=1` is set: raster and GPU milliseconds differ a lot between the two, counts do not.
The `hover` state is the worst case, a different element under the pointer on every move.

## What the overlay does and doesn't do

- **Does:** picking, outlines, area and stroke selection, the note card, pins, canvas mode (the
  inspector and direct manipulation), element identity (selector, text, attributes, React/Vue
  component names and dev source location when present), blocking page input while active,
  holding clicks made during a capture, re-finding pins after a re-render or an agent's edit
  (selector → tag + text → last position, dimmed).
- **Doesn't:** screenshots, storage, sending, status. Those belong to the host, so the overlay
  survives hot reloads without losing anything.

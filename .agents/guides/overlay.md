# Overlay

`overlay/` is the in-page review layer every host injects. `overlay/README.md` ("Source") is the
map and holds the module rules. Dependency rules enforce two of them: the overlay imports nothing
from the app, and outside a mode's folder only its `api.js` is imported. This guide holds what no
check can.

## It runs in someone else's page

- The layer lives in a shadow root inside a popover in the top layer. The page sees nothing of its
  UI: pointer and focus events on the layer stop at the window. A new element of the layer goes
  inside the shadow root, never into the page's DOM.
- The page's own styles, globals and event handlers are hostile ground. Read layout from the page;
  change it only through a canvas batch or a sent animation, and undo that when the note is done,
  failed or stopped.
- `component.js` also ships alone in `overlay-lookup.js`, among the page's own scripts. It imports
  nothing.

## Plain JS, typed by JSDoc

`src/` is ES modules with `checkJs` and is not `strict` yet. Name the protocol types in JSDoc
(`@param {import("../protocol").PageNote} note`) at every send and receive. `strict` is on the
gardening list.

## Cycles

The modules meet in `mount.js` and `state.js`, so imports go both ways and cycles are not
checked here. State that many files change is a property of `S`, `C` or `M`, never a `let` another
file reassigns.

## Proof

`bun run test` drives the built overlay in headless Chromium against `harness/` pages. A change to
a gesture or a mode gets a test there. `bun run bench` guards frame time; run it when a change
touches `render.js`, `input.js` or a mode's frame code.

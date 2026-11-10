# app

The Electron app of bicycle 42. What it is, how to run it and its keys are in the
[root README](../README.md); this page is for working on it.

## Build and run

```bash
bun install          # or npm install
bun run start        # builds into dist/, then opens the app
bun run dev          # rebuilds on change; start Electron yourself with `electron .`
bun run typecheck
```

`scripts/build.mjs` bundles main and preload with esbuild, the window with Vite and Solid, and
copies `../overlay/overlay.js` and `../assets/icon.png` beside them.

Settings and notes live in the app's user-data folder (`~/.config/bicycle42` on Linux);
`BICYCLE42_DATA=/some/folder` puts them elsewhere.

## Test

```bash
bun run test         # unit and controller tests in Node, then the page view and the whole app in headless Electron against a fake server
bun run test:unit    # the Node part alone
bun run check:design # the window's styles against the design system's rules
```

The Electron parts load the pages in `../overlay/harness/`. No test needs an OpenCode server.

`scripts/shot.mjs` takes screenshots of the window in every state from the renderer's mock
(`src/renderer/mock.ts`); they go to `shots/` or `$SHOT_DIR`:

```bash
node scripts/build.mjs && node_modules/.bin/electron --ozone-platform=headless --disable-gpu scripts/shot.mjs
```

## How it's built

```
src/shared/types.ts     the contract: AppState, ChatEvent, Commands, Backend. Read this first.
src/main/index.ts       controller: owns AppState, wires the four parts below
src/main/page.ts        the page: a WebContentsView with ../overlay/overlay.js injected over CDP
src/main/review.ts      a site's notes and their status rules (pure, no Electron)
src/main/images.ts      screenshot → area crop + viewport thumbnail
src/main/opencode.ts    the backend: fetch + one SSE stream → BackendEvents (no Electron)
src/main/local.ts       finds the OpenCode server running on this computer
src/main/store.ts       settings and notes on disk, versioned, atomic writes
src/preload.ts          window.b42: the only door between the window and main
src/renderer/           the window: top bar, notes list, chat (Solid, @kkrll/design tokens)
```

- **Main owns everything durable.** The page hot-reloads under you and the window is a view of
  `AppState`; neither can lose a note. The window never sees the password or a raw server payload.
- **One site = one folder = one conversation** (plus a background one for `alt+Enter` notes).
  Stored in `settings.json` under the app's user-data folder; notes are in `reviews/`.
- **The chat is rebuilt from the server's step, text and tool events**, and the same code path
  re-reads it after a reconnect, so a dropped connection can't duplicate or reorder messages.
- **A note remembers the conversation it was sent to**, and carries a message id chosen here.
  Switching conversations, a restart or a dropped connection can't mark it done by mistake, and
  retrying after a lost reply can't queue it twice.
- **The page is untrusted.** A note counts only right after a real Enter key press in the page, so
  the site's own scripts can't send text to the agent. Page text is quoted in the prompt as data.
  A canvas note's edits are checked field by field (`pageEdits` in `review.ts`): at most 40, known
  kinds, short one-line strings, a property name that looks like one. What fails is dropped.
  CSS typed in the inspector has a length limit and goes into the prompt inside a fence longer
  than any run of backticks in it, so it cannot end its own block.
- **A note has one name** (`noteWords` in `../overlay/prompt.js`): the reviewer's words, or a
  summary of its canvas edits. The list, the pin's tooltip and the chat all show that.
- **The overlay sits in the browser's top layer** (it is a popover), so a site's own dialogs and
  menus can't cover it, and it moves inside an open modal dialog, the only place typing still
  works while one is open.
- **The backend is one interface** (`Backend` in `types.ts`). OpenCode implements it; an ACP
  backend could later without touching the rest.

## What a canvas note sends

What the agent gets: the edits as a numbered list with each element's selector and the window
width they were made at. A moved, reworded or removed element is a sentence
(`Removed "Badge · New".`); a styled one is the CSS as typed, in a fenced block, followed by the
computed value of each property before and after (`gap: 16px → 32px`); a class change is
`class "a b" → "a b c"`; the batch's new rules follow, fenced, with the request to put them where
the project keeps its styles. With them go two pictures of the same area, **before** and **after**
the edits, named as such. If the page does not switch the edits
off in time for the before picture (one second), the note goes with the after picture alone. In
the notes list a canvas note has the sliders icon; its tooltip, and the row itself once its pin is
clicked, list the edits in words. A canvas note sent without words is called by its edits
(`3 canvas edits: moved "Card · Pricing", styled "Card · Features", 1 new CSS rule`) in the list,
on its pin and in the chat. A note may be new CSS rules and nothing else.

## Not done yet

- Tabs and device widths (two tabs at 390 and 1440).
- Before/after crops of what the agent changed, and one-click revert. (The server reverts
  "everything from this message on", not one turn, so per-note revert needs its own design.)
  A canvas note does carry before and after pictures of the reviewer's own edits.
- Canvas mode: reordering in block flow (only flex and grid parents reorder), moving an element
  into another container, dragging padding and margins (type them in the CSS box instead),
  adding new elements and editing HTML.
- Canvas mode: the edited area's crop is cut where the elements are after the edits and before
  them, but a note of new CSS rules alone is cut around at most 20 of the elements they match.
- An Enter that does something else in the page (a new line in the note, picking a template,
  keeping a text edit) still opens the one-second window in which the page's own script could
  slip a note in; closing it needs the isolated world below.
- Session rotation every N notes.
- A failed note can be retried until the app restarts; after that its screenshot is gone.
- Pending permission requests of the background conversation are only seen live, not after a reconnect.
- The overlay shares the page's script world. The Enter check stops forged notes, but a hostile
  page could still read or alter the overlay; the full fix is running it in an isolated world.
- Packaging. It runs from source.

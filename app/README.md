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
puts the overlay and `../assets/icon.png` beside them. The overlay is built by its own script
(`../overlay/scripts/build.mjs`, esbuild over `../overlay/src`), with the overlay's esbuild,
or the app's when the overlay's packages are not installed.

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
src/main/page.ts        the page: a WebContentsView with the overlay injected over CDP, in its own script world
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
- **The repo comes before the site.** `settings.folder` is the repo that is open; a site seen for
  the first time works in it (`adopt` in `index.ts`). With a repo and no page, the app is at a
  place of its own (`HOME`) that has a conversation like any site, so the agent can be asked to
  get the site running (`startSite`): the prompt says whether app and server share a computer
  and asks for a last line `SITE: <address>`, which is opened when the run ends and no page
  works yet. The first site opened takes that conversation over.
- **What is left running is the server's to say.** `Backend.running` lists the shell commands
  still running in a folder (`GET /api/shell`), `kill` ends one. Main reads the open repo's
  every 20 s and after each run, and every project's on connecting and when the list is opened
  (`refreshRunning`); a command younger than 15 s is taken for a step under way and not shown.
  `startSite` asks for a background command of the shell tool, not a detached process, which
  the server would not know about.
- **Every server connected to is kept** (`servers` in `settings.json`, passwords encrypted as
  before), and each has its own repo, pages, conversations and default model: a folder or a
  conversation of one server means nothing on another. The one in use has these in the
  settings' own fields; the others carry theirs in `space` (`enter` in `index.ts` swaps them).
  Notes files of every server but the first have its id before the site's origin, so the same
  address on two machines is two sites.
- **A project is a folder.** `openProject` makes it the open repo and loads the site visited
  last among those that work in it (`url` and `seen` in a site's settings), or no page when it
  has none. The window's list for it is `renderer/switcher.tsx`, behind the panel's "+".
- **One site = one folder = one conversation** (plus a background one for `alt+Enter` notes).
  Stored in `settings.json` under the app's user-data folder; notes are in `reviews/`.
- **The chat is rebuilt from the server's step, text and tool events**, and the same code path
  re-reads it after a reconnect, so a dropped connection can't duplicate or reorder messages.
- **A note remembers the conversation it was sent to**, and carries a message id chosen here.
  Switching conversations, a restart or a dropped connection can't mark it done by mistake, and
  retrying after a lost reply can't queue it twice.
- **The page is untrusted.** The overlay and its way to the app (`window.__review`) are in a
  script world of their own (`WORLD` in `page.ts`): they share the page's document, but the
  site's scripts can't call the one or reach into the other. As a second lock, a note counts
  only right after a real Enter key press in the page (or a real click, for a Send button).
  One small script does run among the page's own (`overlay/src/lookup.js`, with `component.js`): what React or
  Vue calls an element is in the page's objects, so it reads that there and answers the overlay
  through an event; the answer is checked like anything else the page says.
  Page text is quoted in the prompt as data.
  A canvas note's edits are checked field by field (`pageEdits` in `review.ts`): at most 40, known
  kinds, short one-line strings, a property name that looks like one. What fails is dropped.
  CSS typed in the inspector has a length limit and goes into the prompt inside a fence longer
  than any run of backticks in it, so it cannot end its own block.
- **Three sounds, decided in one place.** `renderer/cues.ts` compares two state snapshots and
  names at most one cue: a question or permission that was not there (`ascend`), the server
  lost, a note or the run failed (`descend`), the agent finished with nothing still on its way
  (`f-staccato`). What the reviewer did themselves (Stop, a note removed, another conversation) is
  silent. `renderer/sound.ts` plays them; the settings dialog turns them off.
- **The mode switch is the window's, the mode is the page's.** Preview | Annotate | Edit | Motion and the
  pencil (the brush, in the code) are in the top bar (`setMode`, `toggleBrush`); main tells the overlay, and shows what the
  overlay says back (`{ type: "mode" }`), so the page's own keys (`mod+U`/`P`/`O`/`I`, `Esc`) move the switch
  too. "Edit" is the overlay's canvas mode; "Preview" is review off. The mode is not saved: the
  page remembers it across a reload and says it again.
- **A motion note is one animation.** The overlay sends it as `note.motion` (`Motion` in
  `review.ts`): the keyframes' name, the element, how many elements share the keyframes, the
  `animation` value and the `@keyframes` text before and after, what changed in the timing, and
  what should start it. `pageMotion` checks it field by field (names are CSS identifiers, values
  one line, the keyframes 4000 characters at most); a note whose motion can't be read is refused,
  since its words would lose what they are about. `prompt.js` fences the CSS and writes the rest
  as sentences; the row lists the same sentences and has the motion icon. Like a canvas batch,
  a sent animation stays applied on the page until its note is done, failed or stopped.
- **Every note is answered.** The app replies `captured` once the pictures are taken, or
  `captured` with `ok: false` and a reason when it does not take the note (nothing in it it can
  send, not readable, or it came more than a second after Enter because the page stalled). The
  overlay then puts the card, or the canvas batch with its undo steps, back as it was and says
  why, so nothing shows as sent that went nowhere. Only the second of two notes with one id
  gets no answer of its own.
- **A canvas edit is on an element, not on a place.** The element gets a `data-b42e` attribute
  for as long as a batch names it (none when it has an id of its own), and the preview's rules
  select by that. So the edit stays put when the page adds, removes or reorders the elements
  around it, and the note names the element by the selector it has when it is sent. Only when
  the page builds the element anew (or reloads) is it found by where the old one last was.
- **A note has one name** (`noteWords` in `../overlay/prompt.js`): the reviewer's words, or a
  summary of its canvas edits. The list, the pin's tooltip and the chat all show that.
- **The overlay sits in the browser's top layer** (it is a popover), so a site's own dialogs and
  menus can't cover it, and it moves inside an open modal dialog, the only place typing still
  works while one is open.
- **The model new conversations start with is the person's choice**, saved in `settings.json`
  (`defaultModel`). Main asks for it once (`AppState.modelChoice`, answered by
  `setDefaultModel`) when a server lists several models and none is saved, or the saved one has
  left its list, and makes no new conversation until it has the answer. One model is saved
  without asking; no models, or a list that cannot be read, asks nothing and leaves the choice
  to the server. The picker under the chat box changes the open conversation and the default
  together; the server dialog's "Default model" changes only the default.
- **The backend is one interface** (`Backend` in `types.ts`). OpenCode implements it; an ACP
  backend could later without touching the rest.
- **The app's own slash commands live in main** (`BUILTINS` in `index.ts`). The window asks
  `commands()` for the list (the app's first, then the server's for the site's folder; a
  built-in wins over a server command of the same name) and sends every `/name` through
  `runCommand`, which either does it here or passes it to the server. Each is one `Backend` call:

  | Command | `Backend` | OpenCode route |
  |---|---|---|
  | `/compact` | `compact` | `POST /api/session/{id}/compact` |
  | `/new` | `createSession` | `POST /api/session` |
  | `/undo` | `lastTurn`, `undo` | `GET …/message`, `POST …/revert/stage` |
  | `/redo` | `redo` | `DELETE …/revert` |
  | `/rename name` | `rename` | `PATCH /api/session/{id}` |
  | `/fork` | `fork` | `POST …/fork` |

  A summary (asked for with `/compact`, or written by the server when the context fills) arrives
  as `session.compaction.*` events and shows as a folded step in the conversation; "nothing to
  compact yet" is a line there too. It moves no note: notes follow their own message ids.
  `/undo` first says what it would take back and waits for Enter, because the server takes back
  **everything from that message on**, the agent's file changes included (files only where the
  folder is a git repository). What is undone stays out of the conversation until `/redo`, and
  the next message sent makes it final. A note whose message was undone keeps the status it had.
  The events for summaries and undo are asked for on top of the usual ones. A server that does
  not know them refuses the whole stream (400); the app then asks again without them, once per
  connection, and reads the conversation back after `/compact`, `/undo` and `/redo` instead:
  the summary appears when it is written, without the streaming.

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
- Before/after crops of what the agent changed, and taking back one note. (`/undo` takes back
  the last message and everything after it, which is all the server offers; one turn out of the
  middle needs its own design. Undoing does not yet change the status of the notes it covers.)
- Slash commands OpenCode has that are not here: `/share` (this server has no route for it),
  `/export`, `/copy`, `/timeline`, and choosing the message to fork from (a fork copies the
  whole conversation).
  A canvas note does carry before and after pictures of the reviewer's own edits.
- Canvas mode: reordering in block flow (only flex and grid parents reorder), moving an element
  into another container, dragging padding and margins (type them in the CSS box instead),
  adding new elements and editing HTML.
- Canvas mode: the edited area's crop is cut where the elements are after the edits and before
  them, but a note of new CSS rules alone is cut around at most 20 of the elements they match.
- The overlay on a heavy page: a hover outline that changes size repaints what is under it
  (a layer of its own did not help: it is drawn anew at every size), and the note card is
  painted again as it follows the scroll. Outlines of a fixed look, moved and scaled by
  transform only, would need square corners and a solid line.
- Session rotation every N notes.
- A failed note can be retried until the app restarts; after that its screenshot is gone.
- Pending permission requests of the background conversation are only seen live, not after a reconnect.
- The overlay's elements are in the page's document, in an open shadow root: a hostile page
  can't run the overlay's code or send a note, but it can still read or change what the layer
  shows (the words being typed, the panels). Closing the root, or moving the panels into the
  app window, would end that.
- Signed builds and installers. `npm run pack` makes an unsigned app for this computer.

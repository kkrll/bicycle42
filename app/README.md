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

`scripts/build.mjs` bundles main and the two preloads with esbuild, the window with Vite and
Solid, and puts `../assets/icon.png` beside them. The overlay is built by its own script
(`../overlay/scripts/build.mjs`, esbuild over `../overlay/src`), with the overlay's esbuild,
or the app's when the overlay's packages are not installed, and goes into the page's preload
(`dist/page-preload.cjs`): a sandboxed preload can't read a file. `bun run dev` builds that
preload again when `../overlay/src` changes.

Settings and notes live in the app's user-data folder (`~/.config/bicycle42` on Linux);
`BICYCLE42_DATA=/some/folder` puts them elsewhere.

## Test

```bash
bun run test         # unit and controller tests in Node, then the page view and the whole app in headless Electron against a fake server
bun run test:unit    # the Node part alone
bun run check:design # the window's styles against the design system's rules
```

The Electron parts load the pages in `../overlay/harness/`. None of these needs an OpenCode server.

`bun run test:real` is the one that does, and it is not part of `bun run test`: it drives the
app against the OpenCode server running on this computer with a real agent (three one-line CSS
notes in a throwaway repository, then their pictures, diff, take back, a checkpoint and a
commit), so it spends model tokens. It uses a free model unless `B42_REAL_MODEL=provider/model`
names another, and deletes its conversation and its folder when it ends.

`scripts/shot.mjs` takes screenshots of the window in every state from the renderer's mock
(`src/renderer/mock.ts`); they go to `shots/` or `$SHOT_DIR`:

```bash
node scripts/build.mjs && node_modules/.bin/electron --ozone-platform=headless --disable-gpu scripts/shot.mjs
```

## How it's built

```
src/shared/types.ts     the contract: AppState, ChatEvent, Commands, Backend. Read this first.
../overlay/protocol.ts  the page's side of it: the overlay's messages and a note's shape, shared with the overlay
src/main/core.ts        controller: owns AppState, wires the parts below; createCore(host), with nothing of Electron in it
src/main/index.ts       the Electron shell around it: window, menu, keychain, the bridge's IPC, start and quit
src/main/page.ts        the page: a WebContentsView with the overlay as its preload, in its own script world
src/page-preload.ts     the overlay's way into the page and back to main (IPC), built with the overlay inside
src/main/review.ts      a site's notes and their status rules (pure, no Electron)
src/main/outbox.ts      what each unfinished note sends (prompt, pictures), on disk until it is done
src/main/images.ts      a captured Frame → area crop + viewport thumbnail, each frame scaled once, yielding between steps
src/main/queue.ts       one file operation at a time per key (outbox, shots)
src/main/opencode.ts    the backend: fetch + one SSE stream → BackendEvents (no Electron)
src/main/pictures.ts    the conversation's pictures by address (b42-img:), served to the window by main
src/main/local.ts       finds the OpenCode server running on this computer
src/main/store.ts       settings and notes on disk, versioned, atomic writes off the main thread (flushed at quit)
src/preload.ts          window.b42: the only door between the window and main
src/renderer/           the window: top bar, notes list, chat (Solid, @kkrll/design tokens)
```

- **Main owns everything durable.** The page hot-reloads under you and the window is a view of
  `AppState`; neither can lose a note. The window never sees the password or a raw server payload.
- **The controller is a core without a window.** `createCore(host)` in `core.ts` holds all of
  the app's state in one call and imports nothing of Electron. What it needs of the shell it
  runs in is `Host`: the data folder, the keychain (`secrets`), `emit` to the window's three
  streams (state, chat, note), a `dialog`, a `log`. The shell makes the page and hands it over
  (`attach`); `Page` is what a page under review does (load, send, capture, busy, …) with no
  view, no script text and no Electron type in it, and a capture is a `Frame` (`images.ts`:
  size, crop, resize, JPEG), which `page.ts` makes from the view's. What the shell gets back is
  `Core`: the window's `commands` (and `invoke` by name), `snapshot`, `chat`, `picture`,
  `pageEvents`, `start`, `dispose`. `index.ts` is the Electron shell; the controller tests are
  another, in plain Node (`test/stubs/host.ts`), with no module swapped at build time.
- **Main writes no script into the page.** What it wants of the page it asks the overlay for,
  by message (`../overlay/protocol.ts`): `frame` for a note's picture once the agent is done
  (the layer out of the picture, the page scrolled to where the note was made, both given back,
  each step answered with `frame-shown` two frames later), `show` to bring a note's pin into
  view. The two scripts that are run there (is the page hot-reloading itself, is the reviewer
  mid-note) are `page.ts`'s own.
- **The repo comes before the site.** `settings.folder` is the repo that is open; an address
  seen in it for the first time works in it (`adopt` in `core.ts`). A site is an address in a
  repo, not an address: a port is whoever's dev server took it, so the same origin in another
  repo is another place, with its own entry in `settings.sites`, notes file and conversation
  (`placeOf`: a place is found by its folder and address; its name is the origin and a mark,
  or the origin alone for one made before this). A folder that is not on the server is asked
  for again and nothing saved is taken away for it: the place keeps its conversation, what was
  pinned and its notes until a folder is chosen or the folder is back. With a repo and no
  page, the app is at a place of the repo's own (`HOME`, one for each repo) that has a
  conversation like any site, so the agent can be asked to
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
  settings' own fields; the others carry theirs in `space` (`enter` in `core.ts` swaps them).
  Notes files of every server but the first have its id before the site's origin, so the same
  address on two machines is two sites.
- **A project is a folder.** `openProject` makes it the open repo and loads the site visited
  last among those that work in it (`url` and `seen` in a site's settings), or no page when it
  has none. The window's list for it is `renderer/switcher.tsx`, behind the panel's "+", and
  behind the project's name, where it has no row for a new conversation.
- **One site = one folder = one conversation** (plus a background one for `alt+Enter` notes).
  Stored in `settings.json` under the app's user-data folder; notes are in `reviews/`.
- **The chat is rebuilt from the server's step, text and tool events**, and the same code path
  re-reads it after a reconnect, so a dropped connection can't duplicate or reorder messages.
  After a gap in one conversation's events (a step whose start was not seen), only its newest
  messages are read, back to one read before that had settled by then; a reconnect, an undo, a
  redo or a summary reads the whole list.
- **A conversation's pictures are not in the chat.** Each is a `b42-img://pic/<conversation>/<message>/<file>`
  address (`pictures.ts`), served by main through `protocol.handle` in the app window's session
  only: from the note's own picture on disk, else from the bytes the message list brought (decoded
  on the first look, kept in a bounded cache), else from the server again (`GET …/message/{id}`).
  An address main did not hand out is refused. A re-read of 150 notes is 0.1 MB, not 45.
- **A note remembers the conversation it was sent to**, and carries a message id chosen here.
  Switching conversations, a restart or a dropped connection can't mark it done by mistake, and
  retrying after a lost reply can't queue it twice. Its row says which conversation
  (`NoteRow.session`), so the note's view can name one that is not open and Follow up can open
  it first; a background note's follow-up stays in the open conversation, since the background
  one is not a conversation to talk in.
- **Take back says its way before it goes.** `takeBackWay` answers "undone" (the note is the
  newest message of an idle conversation: an exact undo) or "asked" (the agent is asked to
  reverse it); the view puts that in its question and hands it to `takeBackNote`, which does
  nothing when the conversation has moved to the other way meanwhile.
- **The page is untrusted.** The overlay and its way to the app (`window.__review`, which
  sends over IPC) are the view's preload (`page-preload.ts`), which Electron runs before the
  page's scripts in a script world of its own (`contextIsolation`; `WORLD` in `page.ts`), in
  the top frame only: they share the page's document, but the site's scripts can't call the
  one or reach into the other, and see no IPC handle. As a second lock, a note counts
  only right after a real Enter key press in the page (or a real click, for a Send button).
  One small script does run among the page's own (`overlay/src/lookup.js`, with `component.js`,
  put there by the preload with `contextBridge.executeInMainWorld`): what React or
  Vue calls an element is in the page's objects, so it reads that there and answers the overlay
  through an event; the answer is checked like anything else the page says.
  No debugger is attached to the page, so its console stays in its own process, and
  Developer Tools: Page can be open without taking the overlay away.
- **The page is throttled in the background**, like a browser tab: in a hidden or minimised
  window it draws nothing. `page.holdFrames()` lifts that while it needs frames: for a note's
  pictures, the picture after the agent is done, and the second after a real Enter or click in
  the page (the overlay sends a note two frames after it).
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
- **One note is one turn.** The server makes a turn of everything that reaches a conversation
  while it is busy, and a turn is what it can show the changes of and take back. So the app
  sends a lane's notes one at a time (`enqueue`, `pump` in `core.ts`): a note made while
  another is with the agent, or while a typed message runs, is held in the app (`held` in
  `review.ts`: "queued", with no conversation) and goes when that run ends. A stop or an
  agent's error leaves the rest waiting until something is sent again. Whether a conversation
  is busy is what the event stream last said of its runs (`busy` in `core.ts`); the server is
  asked only when the stream has said nothing since it connected, reconnected or had a gap, and
  a message typed in the chat counts as a run from the moment it is sent. What a held note sends
  is on disk (`outbox.ts`), so it is still sent after a restart; a note goes only once that
  file has its message id.
- **A waiting note is said once.** The server's queue holds notes and typed messages alike, and
  the conversation gets both as waiting items; the window leaves out the ones that are notes on
  the list (`ordered` in `renderer/chat.tsx`), so only a typed message waits there, with its
  Cancel. A note's Cancel is in its own view and goes by the note (`cancelNote`): a held
  note is simply stopped, one already in a conversation's queue is taken out of it there,
  which need not be the open conversation.
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
- **The app's own slash commands live in main** (`BUILTINS` in `core.ts`). The window asks
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
  How full the context is comes from the server's own counts (`AppState.context`). "Used" is
  everything the agent's last finished step read and wrote: `tokens.input + cache.read +
  cache.write + output + reasoning` of the newest assistant message that has counts and no
  error (`GET …/message`, and `session.step.ended` as it happens). The limit is the model's
  window, `limit.input` or `limit.context` of `GET /api/model`, the smaller when it has both.
  That is the sum and the window the server itself uses to decide when to summarise, which it
  does at the window less a reserve (15% unless configured). After a summary nothing is known
  until the next step ends, and a count made by another provider's model is not used, as on the
  server. The window shows it in the message box's bottom row (`renderer/meter.tsx`, arithmetic
  in `renderer/context.ts`): nothing under half, a percentage from there (with the word
  "Compact" while the agent is idle and no note waits), the warning colour
  from 80%, and behind it one confirmed action, Compact, which is `runCommand("compact")`.
  `/undo` first says what it would take back and waits for Enter, because the server takes back
  **everything from that message on**, the agent's file changes included (files only where the
  folder is a git repository). What is undone stays out of the conversation until `/redo`, and
  the next message sent makes it final. A note whose message was undone keeps the status it had.
  The events for summaries and undo are asked for on top of the usual ones. A server that does
  not know them refuses the whole stream (400); the app then asks again without them, once per
  connection, and reads the conversation back after `/compact`, `/undo` and `/redo` instead:
  the summary appears when it is written, without the streaming.

## The page as a phone's, and docks the window draws

- **Desktop | Phone, beside the address** (`setDevice`, `page.device`; kept in settings). As a
  phone's, the window gives the page a box the size of the chosen phone's screen at most (one of
  `PHONES` in `shared/types.ts`, 390 by 844 until another is chosen; the `.stage.phone` rules,
  from `--phone-width` and `--phone-height`) and main asks Chromium for its own phone emulation
  (`setDevice` in `main/page.ts`): the viewport tag counts and scrollbars lie over the page, so
  the page is laid out 390 wide, not 375. The pointer stays a mouse: every mode works as on a
  desktop page. A page with something wider than the window is shown zoomed out to fit, as a
  phone shows it.
- **A phone is shown whole, as large as life or as large as fits.** Its page sits in the middle
  of a column of its own (`.device-col`), with which phone it is right above it. A phone taller
  than that column is not cut: the box keeps the phone's shape, smaller (`fit` and `pageBox` in
  `renderer/app.tsx`), and main draws the page smaller in it, by the box's width over the
  phone's (the emulation's `scale`, with the phone's own size as the page's): `100vh` is the
  phone's height in a short window too, and the picker says "· 94%". The column is as wide as
  the widest phone, so another phone or another scale moves nothing beside it; the column at
  its right is 300 to 720px wide, and the panel cannot be dragged so wide that it gets less
  (`maxWidth`, `--panel-max`).
- **A phone's document is one from its first script on, as far as its width goes.** Emulation
  goes with the document before it, and main can only ask for it again once the new one has
  begun (`did-navigate`); a script of the page's that measures something before then has it laid
  out as a desktop's, where scrollbars take room 15 px narrower, and the zoom a phone gives a
  page wider than its screen stays the one worked out from that (a page 900 wide shown 937 wide,
  for good). So the preload asks main at once, before the page's first script, whether the
  document is a phone's (`IS_PHONE`, the app's one question answered in one go), and starts one
  with a scrollbar that takes no room; the rule goes once the document has loaded
  (`page-preload.ts`). Asking main for the rule from `did-navigate` instead is too late whenever
  a script reads a layout while the page loads, which most pages' scripts do.
- **A length the window's boxes are sized by is set where it is read.** `--panel-width` and
  `--panel-max` on the panel, `--dock-height` on the stage, the phone's three on the phone's
  column (`renderer/app.tsx`). The panel's and the dock's, which follow the pointer while an
  edge is dragged, are registered not to inherit (`@property` in `styles.css`; the dock asks for
  the stage's by name): set on `.app` and inherited, as a variable is by default, each move
  restyled every element of the window, the whole conversation with it. Counted from Chromium's
  trace in `app.e2e.ts`: 457 elements restyled a move (all the test window has, its
  pseudo-elements included), now 17 for the panel's edge and 14 for the dock's.
- **Which phone** (`setPhone`, `page.phone`; kept in settings, also while the page is a
  desktop's). The list above the page is a native `<select>` under words (`PhonePick` in
  `renderer/app.tsx`, as the composer's model is): its list opens over the page, where nothing
  of the window's own document would show.
- **The panel is at the window's left, and a phone's page next to it, in every mode.** The
  column on the page's right is the mode's dock, or in a mode with none (Preview, Annotate) This
  page on this phone (below): the column is always there, so the page does not move when the
  mode changes.
- **This page on this phone** (`renderer/facts-pane.tsx`, its own `facts-pane.css`; `PhoneAside`
  in `renderer/dock.tsx`). What the page is at this phone's size, each row an element of it: what
  sticks out past the screen's right edge (why a phone scrolls it sideways or zooms it out), tap
  targets under 44 px, fields whose text is under 16 px (iOS zooms into them), and no viewport
  tag; one line when all is well. The pointer on a row outlines its element on the page, a click
  brings it into view, and in Annotate "Note" makes it the note's selection (main puts the keys
  on the page then). Under them the files the agent changed, and the two keys worth knowing here.
  Every row is the same grid (words, number, a slot as wide as Note, empty where there is
  none), so every number ends at one x; Note is words only until its row is pointed at (or it
  has the focus), so nine of them do not outweigh the facts. 620 px wide or more, the facts and
  the changed files are two columns. Units are written with a space ("+134 px"). The changed
  files are words, not controls: the path's last two segments, the full one in the title.
- **The phone line: the facts pane's header** (`PhoneLine` in `facts-pane.tsx`; Preview and
  Annotate only). 36 px, as the inspector's header, the words 12 px in; its accessible name is
  "This page on this phone". At its left the counts, each a quiet button with its kind's dot ("2
  stick out", "5 small taps", "2 fields zoom"; none for a kind with none), "Fits this phone" when
  all are none, the missing viewport tag instead when there is none, "Looking at the page…" until
  the first look. The pointer on a count (or the focus) marks that kind on the page while it is
  there; a click goes to the next of them (`nextOf`, cycling): the page scrolls to it and flashes
  it, and the pane's row for it comes into view, lit a moment. At its right "Marks off" | "Marks
  on" (its title says what it would do): every listed element outlined on the page in its kind's
  tone, the sections' dots their legend. Off until turned on (`facts.marks`): the page in Preview
  is the page, and an element is outlined only while its row or its kind's count is pointed at. A
  narrow line shortens the counts ("2 out · 5 taps · 2 zoom", then the numbers by their dots):
  container queries in `facts-pane.css`; nothing is cut at the column's least.
  The overlay works the facts out (`overlay/src/facts/host.js`) only while the pane is up: it
  says it wants them (`wantFacts`), and the window sends "view" (with whether to mark) when it
  appears, "marks" when that changes and "stop" when it goes, once a mode change's unmount and
  mount have settled. It is a pane of the window's that is no mode's dock (`Pane` in
  `overlay/protocol.ts`, "facts" in `HOSTED_PANES`) and rides as a dock does. In Edit and Motion
  the column is the mode's dock and nothing else, and nothing is worked out; a desktop's page has
  no column and no pane.
- **The bar's hints wait two seconds** (`HINT_DELAY`), and one that is up stays a moment after
  the pointer leaves its control (`HINT_LINGER`): on the way to the next control the same
  element gets new words, and is not taken down and put up again.
- **A dock the window draws.** Edit mode's inspector and motion mode's dock are the window's
  only: the overlay draws neither and the page has none of its own. A dock named in
  `HOSTED_PANES` (`shared/types.ts`) is drawn by the window: the overlay is told after every
  "state" ("docks"), sends what the dock shows (`PanelMessage`, the "panel" stream: a whole
  view, or the fields of it that changed, which `renderer/store.ts` puts into the view it keeps
  in `dockViews`) and does what the window's dock asks (the `panel`
  command, `dockAct`). Main carries both and reads neither. A page whose renderer died
  (`page.crashed`) has no overlay: main sends it nothing, and the window drops the views it
  kept, so no pane shows a page that is not there; loaded again, the overlay starts anew and its
  first views are whole ones. The dock's component goes into
  `DOCKS` in `renderer/dock.tsx`; the window puts it under the page (its top edge drags, as the
  panel's side does) or, beside a phone's page, in the column at the page's right.
  What a view and an act carry is each pane's own file: `overlay/protocol-motion.ts`,
  `overlay/protocol-canvas.ts`, `overlay/protocol-facts.ts`.
- **Motion's dock is the window's** (`renderer/motion-dock.tsx`, its own `motion-dock.css`):
  the list, the open animation's header, timeline and keyframe, the note and Send. It is motion
  mode's only dock: the overlay draws none, and keeps what is on the page (the tag, the
  outlines, a click that opens what was clicked, the keys while the page has the keyboard). Its
  layout asks its own box (container queries, which style what is in the box, never the box):
  wide, the list beside what is open; narrower than 720, one or the other with a way back and
  narrower lane names; narrow and at least 600 tall (beside a phone's page), the list above
  what is open. A list that is not the whole page's (the overlay looked at a part of a very
  large page: `partial`) says so in a line under it. A field that comes with a view (a new animation's name, a new lane's or
  keyframe's value) gets the caret once the view has drawn it. Typing, a keyframe dragged and the
  playhead scrubbed are drawn from the hand until the view agrees (an act's view comes back on
  the page's next frame, 20 to 35 ms headless; a ping is about 1 ms). Its popovers stay inside
  its box: the page view paints over the window wherever it sits. There is one at a time, drawn
  in one place, and each is a child of the component that opened it (`usePop`): it reads what
  that component reads, so it goes when the component does (a keyframe deleted with its easings
  open, what is open closed under the "More" sheet). A field removed with the caret in it hears a
  blur from Chromium as it goes, and asks nothing then.
- **Edit's inspector is the window's** (`renderer/canvas-dock.tsx`, its own `canvas-dock.css`; the
  overlay's side is `overlay/src/canvas/host.js`). Its fields are its own while typed in and its
  suggestions are worked out here (the overlay's pure `suggest-model.js`, `number.js`,
  `css-data.js`, and this window's `CSS.supports`), so typing never waits for the page. Its
  header names what is selected (its component, else tag#id.class as the tree has it), never
  what the element says. The overlay sends only the fields of the view that changed (the hovered
  row is one number, `hover`), so an inspector that comes up in a window with no view (a window
  reloaded while the page stayed) asks for the whole one (`whole`). A handle between the tree and the styles (a pill, as the window's other
  handles) sizes the tree: its height above the styles, its width beside them; arrows step 16
  px, Home and End go to the limits, a double click gives it its share again; kept
  (`canvas.tree.h`, `canvas.tree.w`). The tree scrolls up and down only: a long row ends in "…".
- **The bar is the inspector's footer.** The page has no bar over it in Edit: the footer has how
  many edits ("No edits", "3 edits"), undo, redo, Reset, the note ("Add a note…"; Enter sends,
  alt+Enter to the background, mod+Enter from the inspector's fields), Send and, in the note's
  place while it is empty, what happened to the note sent last ("Sent · preview stays until note
  4 is done", a refusal for a moment). The words are the overlay's, sent with every key
  (CanvasView `batch`, the acts "note" and "reset"), so a refused note brings them back. The count
  is a button: it opens the list of the unsent edits inside the inspector's box, each as what it
  is on and what it does ("Card · Pro For small teams — padding 16 → 24"); a row selects its
  element and brings it into view (the stylesheet's shows Global, the caret in its box), its ×
  takes that one edit out as an undo step (the acts "edits", "select" with `show`, "unedit"; the
  overlay makes the rows only while the list is open, since each is measured with the batch off
  and on). A press anywhere outside it, on the page too, or Escape shuts it, and so does the last
  edit going. Its "?" opens the keys list (the overlay's `canvas/help.js`) inside the inspector's
  box. Folded under a desktop's page, the inspector keeps its footer.
- **Send in a dock of the window's** (motion's Send, the inspector's Send and mod+Enter) has no key or
  click in the page to come with, which the page view asks of every note: on a "send" act the
  controller tells the page view to let the next note through, once (`admitNote`).
- **A view is the page's text.** A class, a keyframe's name, an element's words: the window draws
  them as text and never as markup, and keeps nothing of the page's that the overlay does not
  also have (a reload of either side loses nothing). `dockPing` measures the way to the overlay
  and back.
- Shots: `phone`, `phone-se`, `phone-wide`, `phone-clear`, `dock`, `phone-dock`,
  `phone-dock-keys`, `phone-least-dock`, `phone-motion-dock`, `dock-more`, `dock-narrow`,
  `canvas-dock`, `canvas-dock-edits` (the footer's list of edits open), `canvas-dock-narrow` (the mock takes `&device=phone`,
  `&docks=motion,canvas`, `&mode=preview|edit|motion`, `&facts=clear`; it feeds motion's dock a
  sample view, the inspector the one in `mock-canvas.ts`, and the facts pane one of a pricing page).

## What a canvas note sends

What the agent gets: the edits as a numbered list with each element's selector and the window
width they were made at. A moved, reworded, removed or duplicated element is a sentence
(`Removed "Badge · New".`); an edit made inside a copy says `in the copy made by edit 2` (or, in one an earlier note asked
for, `in the copy of "Card · Pro" an earlier note asked for`); a styled one is the CSS as typed, in a fenced block, followed by the
computed value of each property before and after (`gap: 16px → 32px`); a class change is
`class "a b" → "a b c"`; the batch's new rules follow, fenced, with the request to put them where
the project keeps its styles. With them go two pictures of the same area, **before** and **after**
the edits, named as such. If the page does not switch the edits
off in time for the before picture (one second), the note goes with the after picture alone. In
the notes list a canvas note has the sliders icon; its tooltip, and the note's own view once it is
opened, list the edits in words. A canvas note sent without words is called by its edits
(`3 canvas edits: moved "Card · Pricing", styled "Card · Features", 1 new CSS rule`) in the list,
on its pin and in the chat. A note may be new CSS rules and nothing else.

## Not done yet

- Tabs and device widths (two tabs at 390 and 1440).
- Taking back a note that is not the newest message is a request to the agent, not an exact
  undo (the server undoes from a message on, never one turn out of the middle). A note's diff
  is its turn's, and a message typed into the chat while the agent is on a note joins that
  turn, so its changes show in the note's diff.
- The picture after the agent is done is taken only while the page the note was made on is
  open at the same width; a note finished while the reviewer is elsewhere has none.
- Slash commands OpenCode has that are not here: `/share` (this server has no route for it),
  `/export`, `/copy`, `/timeline`, and choosing the message to fork from (a fork copies the
  whole conversation).
  A canvas note does carry before and after pictures of the reviewer's own edits.
- Canvas mode: moving an element into another container, adding new elements other than a copy
  of one, and editing HTML. A reorder in block flow is previewed by shifting the boxes
  (`translate`), so it is exact for a plain stack of blocks; one among text or side-by-side boxes
  is refused.
- Canvas mode: the edited area's crop is cut where the elements are after the edits and before
  them, but a note of new CSS rules alone is cut around at most 20 of the elements they match.
- The overlay's outlines have square corners: each is four edge strips and a scaled fill, so
  an outline that changes size repaints only thin lines, not what is under it (a rounded box
  repainted its whole old and new size, which over a large element is the whole window).
- Session rotation every N notes.
- A failed note can be retried until the app restarts; after that its screenshot is gone.
- Pending permission requests of the background conversation are only seen live, not after a reconnect.
- The overlay's elements are in the page's document, in an open shadow root: a hostile page
  can't run the overlay's code or send a note, but it can still read or change what the layer
  shows (the words being typed, the panels). Closing the root, or moving the panels into the
  app window, would end that.
- Signed builds and installers. `npm run pack` makes an unsigned app for this computer.

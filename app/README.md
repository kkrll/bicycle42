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
bun run test         # unit and controller tests in Node, then the page view and the whole app in headless Electron with a fake ACP agent
bun run test:unit    # the Node part alone
bun run check:design # the window's styles against the design system's rules
```

One heavy run at a time on a computer: the unit tests, each e2e, the screenshots and the overlay's
browser tests wait for a lock (`scripts/heavy-lock.mjs`, a folder at `/tmp/bicycle42-heavy.lock`
with its holder's pid) and say whom they wait for. Two or three at once (parallel agents, a merge
check beside them) made each several times slower and timing-sensitive checks fail. A holder that
is gone is taken over; `B42_NO_LOCK=1` skips it, and after `B42_LOCK_WAIT_S` (1800) a run goes
ahead anyway. `node scripts/heavy-lock-run.mjs <command…>` holds it around any other command.

The Electron parts load the pages in `../overlay/harness/`. None of these needs a real agent: the
controller's tests and the whole app's (`test/app.e2e.ts`) play the fake ACP agent of
`test/fake-agent.ts` in their own process, a turn at a time (`test/played-agent.ts`, reached
through `Host.agentTransport`); `test/controller-acp.test.ts` and `controller-ssh.test.ts` run it
as a program of its own (`test/acp-agent.ts`), here and over a fake ssh.

`bun run test:real` is the one that does, and it is not part of `bun run test`: it drives a real
ACP agent on this computer through `main/acp.ts` (`test/acp.real.ts`: a note-like turn that writes
a file, the queue, Stop, steer, a re-read from a new process), so it spends the agent's tokens.
It runs OpenCode (`opencode acp`) unless told another: `bun run test:real -- claude haiku`.

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
src/main/index.ts       the Electron shell around it: window, menu, the bridge's IPC, start and quit
src/main/page.ts        the page: a WebContentsView with the overlay as its preload, in its own script world
src/main/site-address.ts where an agent's `SITE:` address points, from the address alone: its computer's loopback, or elsewhere
src/page-preload.ts     the overlay's way into the page and back to main (IPC), built with the overlay inside
src/main/review.ts      a site's notes and their status rules (pure, no Electron)
src/main/outbox.ts      what each unfinished note sends (prompt, pictures), on disk until it is done
src/main/images.ts      a captured Frame → area crop + viewport thumbnail, each frame scaled once, yielding between steps
src/main/queue.ts       one file operation at a time per key (outbox, shots)
src/main/acp.ts         the backend: an ACP agent the app runs, here or over ssh, JSON-RPC over its stdio → BackendEvents
src/main/machine.ts     where the code is: commands, files, the agent's process and PATH of a computer (Machine); this one's (LocalMachine)
src/main/ssh.ts         another computer over ssh as a Machine: ControlMaster, the helper put there and attached to, reconnecting, port forwards
src/helper/helper.ts    the app's helper on that computer (dist/helper.cjs): Machine's calls as JSON-RPC, and the agent's process kept with its output while the app is away
src/shared/wire.ts      the wire between the app and that helper: lines read as bytes and decoded whole, LINE_MAX, the protocol's number
src/main/model-facts.ts what an agent says of its models beyond their names (OpenCode's model list), how its errors about them read
src/shared/models.ts    how a model is named to the reviewer: its provider when another has its name, its labels (free, alpha)
src/main/agents.ts      the ACP agents the app knows (Claude Code, Codex, Gemini CLI, OpenCode), how each starts and installs, whether a sign-in is found
src/main/chat-items.ts  what a conversation is built with: a user message, a run's end, parseNote, reading untrusted JSON
src/main/patch.ts       an edit's old and new text as a unified diff (ACP says edits that way)
src/main/asks.ts        what the app itself asks the agent (site, commit, take back), what it tells it, and the line the chat shows for it
src/main/snapshots.ts   the app's own file history: a shadow git repository per folder, outside it; snapshots, diffs, exact take-backs
src/main/ops.ts         the work done where the files are (vcs, the history's git side): by the app here, by the helper there, one call each
src/main/pictures.ts    the conversation's pictures by address (b42-img:), served to the window by main
src/main/store.ts       settings and notes on disk, versioned, atomic writes off the main thread (flushed at quit)
src/preload.ts          window.b42: the only door between the window and main
src/renderer/           the window: top bar, notes list, chat (Solid, @kkrll/design tokens)
src/renderer/agents.tsx the agent in use as the window shows it (AppState.harness): mark, name, the switcher, paths
src/renderer/paths.ts   a path under the home folder as ~, and cut in the middle to fit (pure, tested)
```

- **Main owns everything durable.** The page hot-reloads under you and the window is a view of
  `AppState`; neither can lose a note. The window never sees a raw agent payload.
- **The controller is a core without a window.** `createCore(host)` in `core.ts` holds all of
  the app's state in one call and imports nothing of Electron. What it needs of the shell it
  runs in is `Host`: the data folder, `emit` to the window's three streams (state, chat, note),
  a `dialog`, the system's `saveDialog`, a `log` (and, for tests, `agentTransport`: an agent in the same process). The shell makes the page and hands it over
  (`attach`); `Page` is what a page under review does (load, send, capture, busy, …) with no
  view, no script text and no Electron type in it, and a capture is a `Frame` (`images.ts`:
  size, crop, resize, JPEG), which `page.ts` makes from the view's. What the shell gets back is
  `Core`: the window's `commands` (and `invoke` by name), `snapshot`, `chat`, `picture`,
  `pageEvents`, `start`, `dispose`. `index.ts` is the Electron shell; the controller tests are
  another, in plain Node (`test/stubs/host.ts`), with no module swapped at build time.
- **The page is a stranger's.** The site may be another computer's, forwarded here. Its sessions
  refuse every permission and every check of one (geolocation, camera, clipboard, notifications,
  MIDI, devices, and `openExternal`, which would hand an app's link to the system), and it may go
  to web addresses only: any other scheme, by a link, a script, a frame, `window.open` or a
  server's redirect, is stopped and said quietly by the address (`PageState.refused`). The review
  needs none of it: the overlay talks to main over IPC, pictures are taken by main, a pasted
  picture comes with the paste. A download the page starts (a link with `download`, a response
  that is an attachment, a script clicking a link to a blob it made, an address typed that is
  one) opens no Save dialog of its own: it is held, paused, in a folder of the app's (`Held
  downloads` in the user-data folder, emptied at every start), and the window says so in a line
  under the top bar, with who asked, the file and its size when the site said it
  ("localhost:5173 wants to download report.csv (12 KB)", `AppState.page.download`). Who asked is
  the download's initiator origin; a frame of no site of its own (sandboxed, `data:`) is "A
  frame in localhost:5173", never the page itself, and a file of another site says so ("… from
  files.example.com"). Save… opens the system's Save dialog in the reviewer's Downloads folder;
  the download goes on, a line says how much has come ("Saving report.csv… 40%", with Cancel,
  `AppState.page.saving`), and once it has all come it is moved to the file chosen (across
  disks, copied beside it and renamed over it, so a file there is replaced only by a whole
  one). Don't, or cancelling that dialog, cancels it and nothing of it is kept. A download that
  stops while held is cancelled and its line goes; one that stops after Save… is resumed once
  more (Chromium has already tried again by itself by then, so from a link that keeps dropping
  that can be a dozen requests, and a server that can't send a part starts it over), and one
  that stops again, or of which nothing more comes for 60 s, is given up and said in a dialog.
  One waits at a time: a second takes the place of the first, which is cancelled; a file chosen
  for the first in a Save dialog still open then is said not to be saved. A typed address that
  is a download leaves the page where it was, and is not kept as the page's last address. A
  download from the page's developer tools (same session) is refused, and said in the log.
  The page going to another site (a move within the site, a pushState or another path, does
  not), the page closing, and opening another project or computer cancel the one waiting. It is
  held, not stopped and asked for again on Save, because a blob a script made or the answer to a
  form's POST cannot be asked for again; Electron gives a download its file when it starts or
  shows its own dialog, so that file is the held one. Held is not "nothing has come": Chromium
  writes a download to a file of its own before it has its file, and the pause takes hold only
  then, so what a fast server sent by then has come (from a local server, often the whole file,
  hundreds of MB), and stays in the held folder until the answer. That first file is in the
  folder the app's "downloads" path names, which the app makes the held folder for this reason
  (`holdDownloadsIn`; a session's `setDownloadPath` does not move it), so nothing of a download
  is ever in the reviewer's Downloads before Save…. A download from another computer's site
  comes through the forwarded port, and is
  saved on this computer. Each computer's sites are in a session of their own
  (`partitionOf` in `core.ts`: `persist:review` for this computer's, as always, and
  `persist:review-<hash of host and this install's id>` for another's), since forwarded sites of
  two computers share addresses (`127.0.0.1:3000`) and so would share storage, cookies and
  service workers. Another computer's session makes the page again (`Page.setPartition`): a
  WebContents cannot change its session.
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
  or the origin alone for one made before this). A folder that is not there is asked
  for again and nothing saved is taken away for it: the place keeps its conversation, what was
  pinned and its notes until a folder is chosen or the folder is back. With a repo and no
  page, the app is at a place of the repo's own (`HOME`, one for each repo) that has a
  conversation like any site, so the agent can be asked to
  get the site running (`startSite`): the prompt is short, says that what it starts as a background
  command of its shell tool ends with the session, and asks for a last line `SITE: <address>`,
  which is opened when the run ends and no page works yet (for an agent on another computer, its
  localhost forwarded here first). The first site opened takes that conversation over.
- **What the app asks in the reviewer's name is one line in the chat.** Getting the site
  running, a commit and a note taken back are messages the app writes (`main/asks.ts`); each
  says only what the agent cannot know by itself. `parseAsk` reads back what one asks
  (`ChatUser.ask`), and the chat shows that line with the whole text folded under it, as a
  note's message shows the note's words and not its prompt.
- **What the agent leaves running ends with it.** ACP gives the app no list of what the agent's
  shell runs and no way to stop it, so a dev server the agent starts lives as long as the
  agent's process, which the app ends (with its process group) when it quits or uses another
  agent. `startSite` asks for a background command of the shell tool, not a detached process,
  which would outlive it.
- **Every agent started is kept** (`servers` in `settings.json`: which agent, the command that
  starts it, the computer over ssh), and each has its own repo, pages, conversations and default
  model: a folder or a conversation of one means nothing to another. The one in use has these in
  the settings' own fields; the others carry theirs in `space` (`enter` in `core.ts` swaps them).
  Notes files of every one but the first have its id before the site's origin, so the same
  address on two machines is two sites. `describe` in `core.ts` gives each its kind (the mark),
  its name ("Claude Code", the reviewer's own, a custom command's program) and whether it is on
  this computer, as `AppState.harness` for the one in use and in `servers()` and `allProjects()`
  for the others.
- **An OpenCode server is no longer connected to.** The app runs an agent over ACP, here or on
  another computer over ssh (OpenCode too: `opencode acp`). A server saved by an earlier version
  (`{ url, password }` or `{ local: true }`) is put aside when the controller is made, before
  anything loads (`retireServers` in `core.ts`): it leaves `servers` and `server`, without its
  password, into `retired`, with its `space` (when it owned the settings' own fields, those go
  with it, and the next agent gets a new `prefix`), so nothing of it is reached and nothing is
  deleted; its notes files stay. `AppState.serversRetired` makes the connect screen say so once;
  `leaveSsh` (the connect screen closing) forgets it.
- **A project is a folder.** `openProject` makes it the open repo and loads the site visited
  last among those that work in it (`url` and `seen` in a site's settings), or no page when it
  has none. The window's list for it is `renderer/switcher.tsx`, behind the panel's "+", and
  behind the project's name, where it has no row for a new conversation.
- **One site = one folder = one conversation** (plus a background one for `alt+Enter` notes).
  Stored in `settings.json` under the app's user-data folder; notes are in `reviews/`.
- **The chat is built by one path** (`apply` in `acp.ts`) from the agent's live updates and from
  the replay `session/load` sends, so a re-read after the agent's process starts again gives the
  same items with the same ids and never duplicates or reorders anything.
- **A conversation's pictures are not in the chat.** Each is a `b42-img://pic/<conversation>/<message>/<file>`
  address (`pictures.ts`), served by main through `protocol.handle` in the app window's session
  only: from the note's own picture on disk, else from the bytes the message carried (decoded on
  the first look, kept in a bounded cache), else from the agent's conversation again.
  An address main did not hand out is refused. A re-read of 150 notes is 0.1 MB, not 45.
- **A note remembers the conversation it was sent to**, and carries a message id chosen here.
  Switching conversations, a restart or a dropped connection can't mark it done by mistake, and
  retrying after a lost reply can't queue it twice. Its row says which conversation
  (`NoteRow.session`), so the note's view can name one that is not open and Follow up can open
  it first; a background note's follow-up stays in the open conversation, since the background
  one is not a conversation to talk in.
- **"2 unpinned" counts what the page says now.** It sits at the notes header's end, before
  Clear done, so the counts that come into the header when the list folds never move it. The overlay reports which pins it can't place
  (`pins-placement`) only while it draws them, so main counts, of the notes on the list that are
  not done, those in the last report: none in Preview, none of a note taken off meanwhile, and
  none after a new document ("ready") or a page that failed, until the page says again. A done
  note is not counted (the agent's change is often what moved its element). There is nothing to
  do about one: a pin finds its element again by itself once it is back, and its note goes to the
  agent as written, as the explanation under the count says.
- **Take back says its way before it goes.** `takeBackWay` answers "restored" (the app reverses
  the note's turn from its own file history, below) or "asked" (the agent is asked to reverse it); the view puts that in its question and hands it to
  `takeBackNote`, which does nothing when things have moved to another way meanwhile.
  `takeBackPlan` is the same with, for "restored", the files the reversal would change (from a dry
  run): the question names them and says that what anyone changed in them during that turn (the
  reviewer in their editor too) goes back with it, since the turn's diff is the folder's.
- **The app keeps its own file history** (`snapshots.ts`): it is what takes a note back exactly,
  and what `/undo`, `/redo` and checkpoints do (ACP has no undo). It is kept on the computer the
  agent works on: this one's under the data folder, another's in `~/.bicycle42/snapshots/<id>`
  there, over ssh. Each folder has a shadow git repository (`snapshots/<name>-<hash>.git`), used with
  `GIT_DIR` and `GIT_WORK_TREE` and none of the person's git configuration; the folder's own `.git`
  is never touched, and it need not be a repository. A snapshot is `git add -A` + `git write-tree`
  (the folder's `.gitignore` counts; `node_modules` never goes in). A `git add` that was killed
  (the 60 s timeout, a signal) is no snapshot; only its own exit 1 under `--ignore-errors` (a file
  it could not read) counts. A turn that begins with the empty tree in a folder with files is not
  kept, a change that would delete at least 20 files and half of the folder's is refused
  (`Refused`, with a sentence), and a file a turn "added" that was on disk before the turn began
  (a `.gitignore` edit let it in) is kept when the turn is reversed. The folder's shadow index is
  warmed when its site opens, so boundary snapshots read only what changed. Core snapshots a site's
  conversation's folder at each turn boundary (`turnEdge`: a run starts, the agent is handed
  the next message, the run ends); the notes that finished at a boundary ran in the turn it ends,
  and the turn's two trees, with those notes' message ids, go into the folder's log (`b42.json` in
  the shadow), so they outlive a restart. A note's diff is `git diff before after` of its turn.
  Taking it back is that diff reversed, applied to the files as they are: what changed since on
  other lines stays, the reviewer's edits between turns are in the next "before" and are never
  reversed, and when a later change touched the same lines nothing is touched and the agent is
  asked instead (with the diff from the snapshots). Several turns (a checkpoint) are reversed in
  a scratch index, newest first, and the files change once or not at all. What was taken back is
  a restore in the log: `/redo` applies it forward again until the agent is told, and the next
  message to that conversation, whatever it is, starts with one line saying which notes were
  taken back (`toldLine` in `asks.ts`; `readTold` in core shows the message as it would be
  without it, the line folded under a typed message). The restore is `told` only when that
  message reaches the agent (its inbox "working", by the message id it was sent with: `carrying`
  in core); cancelled, stopped or lost first, it stays untold for /redo and the next message, and
  untold restores outlive the log's 30-day cut. Before `/compact` or an agent's own command the
  line goes alone, as a message of its own ("Told the agent what was taken back"). A turn during
  which another conversation ran in the same folder, or one inside it or around it (by real path;
  the background one, another project's: run events come for every folder, and a conversation
  of no site's is asked for its folder) is `shared`: its diff may hold the other's
  changes, so it is never reversed by itself. A turn whose "before" may hold its own first
  changes is `untrusted` and goes to the agent too: one whose message went before its snapshot was
  taken (`AcpOptions.turnUntrusted`: it took longer than `timing.beforeTurn`). So is a turn that changed nothing the app sees (the agent worked in
  a nested repository, an ignored file, outside the folder), and a reversal that throws (a stale
  `index.lock`). A note whose turn was never kept has no diff to show (`noteDiff` is null, "No
  record of what changed"), which is not "No file changed". Turns older than 30 days leave the log once a day, and git's gc (off
  otherwise) lets their trees go.
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
  names at most one cue: a question or permission that was not there (`ascend`), the agent
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
- **One note is one turn.** A turn is what the app can show the changes of and take back (its
  snapshots are taken at turn boundaries). So the app
  sends a lane's notes one at a time (`enqueue`, `pump` in `core.ts`): a note made while
  another is with the agent, or while a typed message runs, is held in the app (`held` in
  `review.ts`: "queued", with no conversation) and goes when that run ends. A stop or an
  agent's error leaves the rest waiting until something is sent again. Whether a conversation
  is busy is what the backend last said of its runs (`busy` in `core.ts`); the conversation is
  asked only when nothing has been said since the agent started, and a message typed in the
  chat counts as a run from the moment it is sent. What a held note sends
  is on disk (`outbox.ts`), so it is still sent after a restart; a note goes only once that
  file has its message id.
- **A waiting note is said once.** A conversation's queue (in `acp.ts`) holds notes and typed
  messages alike, and the conversation gets both as waiting items; the window leaves out the ones that are notes on
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
  `setDefaultModel`) when an agent offers several models and none is saved, or the saved one has
  left its list, and makes no new conversation until it has the answer. One model is saved
  without asking; no models asks nothing and leaves the choice to the agent. The picker under
  the chat box changes the open conversation and the default together; the settings' "Default
  model" changes only the default.
- **The backend is one interface** (`Backend` in `types.ts`), and its implementation is an ACP
  agent (`acp.ts`, below), on this computer or another. What it can do beyond the basics is
  `Backend.can` (`BackendCan`), which reaches the window as `AppState.can`: what it can't do is
  not offered (Steer, Compact, Fork, Archive), and the controller refuses it with a sentence.
- **The app's own slash commands live in main** (`BUILTINS` in `core.ts`). The window asks
  `commands()` for the list (the app's first, then the agent's; a built-in wins over an agent's
  command of the same name) and sends every `/name` through `runCommand`, which either does it
  here or passes it to the agent as a message:

  | Command | What it does |
  |---|---|
  | `/compact` | the agent's own `/compact`, as a message (`Backend.compact`; offered only when the agent has it) |
  | `/new` | `createSession` |
  | `/undo` | the agent's last turn here, files only, from the app's history (`undoFiles`) |
  | `/redo` | brings back the newest take-back the agent was not told of yet |
  | `/rename name` | `rename` |
  | `/fork` | `fork` (where the agent offers it) |

  How full the context is comes from the agent's own count (its `usage_update`: `ContextUse`,
  `AppState.context`), against the window it gives. The window shows it in the message box's
  bottom row (`renderer/meter.tsx`, arithmetic in `renderer/context.ts`): nothing under half, a
  percentage from there (with the word "Compact" while the agent is idle and no note waits, when
  it offers `/compact`), the warning colour from 80%, and behind it one confirmed action,
  Compact, which is `runCommand("compact")`. `/undo` first says what it would take back and
  waits for Enter; the conversation stays as it is, and the agent is told with the next message.

## An agent on this computer (ACP)

`main/acp.ts` runs an agent that speaks ACP, the [Agent Client Protocol](https://agentclientprotocol.com),
and is the `Backend` for it (`@agentclientprotocol/sdk`, its `/unstable` entry, bundled into
main). The connect screen lists the agents `main/agents.ts` knows, each said installed or not
(looked for on this process's PATH and on the one the login shell sets up, since an app started
from the desktop has less), and takes any other command (`connectAgent`). A row not installed or
not signed in offers to copy the command that fixes it, not Start; the list is asked for again
when the window gets the focus back while such a row is there (or an agent refused a sign-in). A saved agent is kept
(`{ agent, command }` in `settings.servers`), with its own repo, pages and conversations; its
address is `acp://<id>`. A known agent's command is worked out again at each start (the saved one
is a record): a pin moved on, or "Always the newest" turned on, applies to it at once.

| Agent | Command |
|---|---|
| Claude Code | `claude-agent-acp` if installed, else `node ~/.bicycle42/adapters/<package>@<pin>-<lock hash>/…/dist/index.js`, installed there from the app's lockfile at its first start (needs `claude`, signed in, and node and npm) |
| Codex | `codex-acp` if installed, else the same from its own lockfile (needs `codex`, signed in, and node and npm) |
| Gemini CLI | `gemini --experimental-acp` |
| OpenCode | `opencode acp` |

The two adapters are pinned to an exact version in `src/main/agent-pins.json`, the same on this
computer and on another one over ssh (the line is built here): each start runs what was tested,
never what npm has newest that minute, with the reviewer's login, keys and repos. The Claude
adapter bundles its own Claude Code (it pins `@anthropic-ai/claude-agent-sdk`), so a new model
arrives with a new adapter. Gemini CLI and OpenCode are the person's own CLIs: nothing to pin.

So is everything under a pinned adapter. `npx -y <package>@<pin>` pinned only the adapter: npm
resolved the rest of its tree afresh on each computer (Codex's asks for `@openai/codex ^0.171.0`,
`zod ^4`, `open ^11`… as ranges) and ran every package's install script as the reviewer, here
and on the computer the agent runs on. Now each pin has a lockfile beside it,
`src/main/adapter-locks/<id>/` (a `package.json` asking for the adapter at its pin, and the
`package-lock.json` npm made for it: every package of the tree with its address and sha512, the
per-platform ones of macOS, Linux and Windows included), bundled into main. At the adapter's
first start on a computer, `main/adapters.ts` writes those two files there through `Machine` (no
change to the helper: the same calls on this computer and over ssh) into
`~/.bicycle42/adapters/.installing-<folder>-<random>/` (`~/.bicycle42` and `adapters/` made the
person's alone, 0700, here as the helper makes them there; here, one that is a link or another
user's folder is refused, never installed into) and runs that computer's own
`npm ci --ignore-scripts --no-audit --no-fund --include=optional --include=peer
--legacy-peer-deps=false --install-strategy=hoisted` in it. npm refuses any package whose
download is not the sha512 in the lockfile, and no package's script runs: Claude's and Codex's
adapters, and the Claude Code and Codex programs they bring (one package per platform, about 440
MB with it), need none. Once npm is done, the app checks what it installed against the lockfile:
every package the lockfile names for that computer (its os, cpu and libc, as npm tells them) must
be in npm's own record of the install (`node_modules/.package-lock.json`) at its version, or the
install is refused ("npm said it was done, but left out a package its lockfile names for linux
x64 (…)", an npmrc's `cpu=` or a failed optional download) and nothing is kept. A computer the
lockfile has no build of the program for (Linux on riscv64 or 32-bit arm, FreeBSD, a Linux whose
libc can't be told), where npm installs none and says it is done, is refused the same way ("its
lockfile has no build of its program for linux riscv64 glibc…"); Claude's is 108
packages of its lockfile's 115 on one computer, Codex's 25 of 30. Only then, with the adapter's
program where the lockfile says, is the folder renamed to `<package>@<version>-<hash of both
files>` (`@agentclientprotocol+codex-acp@2.9.0-…`), its hash written in it last (`.b42-installed`):
a folder at that name with that hash is a whole install. Anything else at that name (half a copy,
another lockfile's, a file) is moved aside to `.removing-…` and removed, and the install goes
ahead; if the name still can't be had, a sentence says so. One that failed or was cut off is never
used, and is taken away at a later install once it is an hour old. The agent is then `node <that
folder>/node_modules/<package>/<its bin>`, no npx, and later starts use the folder as it is. A
changed lockfile is another folder. npm's settings from a script it runs (`npm_config_*` of an
app started with `npm start`) and `NPM_CONFIG_*` are left out of the install; the reviewer's own
`~/.npmrc` (a mirror, a proxy) is read, with a mirror npm still checks every sha512, and what in
it could leave packages out (`legacy-peer-deps`, `omit=peer`, which left Claude's adapter with 6
packages of 108, said to be done) is overruled by the words above.

The first start says "Installing the Codex adapter (first start)…" (on dev-box: "…adapter on
dev-box…") under the agent's row on the connect screen, and in the panel's "Connecting" banner
(`agentStep`). An install that fails says why in a sentence: npm not there ("npm was not found
there (it comes with node)…"), offline ("npm could not reach its registry (registry.npmjs.org).
Is dev-box offline?"), a download refused ("npm refused it, because what it downloaded (…)
differs from what the app tested: its sha512 is not the one in the app's lockfile. Nothing of it
was installed."), a full disk, or npm's own last words. npm runs under a watchdog of node's, in a
process group of its own, which the watchdog ends with SIGKILL after 15 minutes (npm ignores
SIGTERM while a download hangs, and macOS has no `timeout`); when the watchdog itself is ended
(the app's own timeout, output too long); and when the app no longer says it waits: it writes the
install's lease file (`.b42-lease`) every 10 s, and once the watchdog has not seen its time change
for a minute, on its own monotonic clock (the app quit, or the link to dev-box dropped, where the
helper runs on) it ends npm and removes the install's folder, also when nothing reads its output
any more. Never by comparing the file's time with the clock: a computer that slept does not end a
healthy install on waking, nor does a home folder on a server whose clock is off. A start whose
install another app's tidying took away just then installs it again, once. A link that drops during an install is said as "The
connection to dev-box ended while installing the Codex adapter; it will be tried again at the
next start." A refused download is retried after seconds, not npm's minute, so a refusal is said
in about 20 s. Two starts at once wait for one install.

Each start marks the install it uses (`.b42-used`, its time that computer's clock's), and tidies
the other installs of the same adapter there: one goes only once it has not been used for 14 days
(one from before the mark counts from its install), whatever its version. So two builds of the app
with the same version from other lockfiles, or two apps reaching one computer over ssh, each keep
theirs while they are used, and neither takes the other's away for it to install again at its
next start (each start taking away the other's, as tidying by version and install time did). One
whose program runs now is kept too: any process whose command line names its folder (`ps -A -ww
-o args=`; PowerShell's process list on Windows), such as an agent the helper keeps while the app
is away, or another app's; it goes at a later start. When the processes can't be listed nothing
is taken away. A folder is renamed to `.removing-…` before it is removed, so a start never finds
half of one, and put back if a start marked it used meanwhile.

On the connect screen, an agent's "Command" shows the version it runs ("Adapter 0.109.1, tested,
every package locked", with "(installed at its first start)" until it is) and an "Always the
newest" switch, kept per agent in `settings.agentLatest`, which starts `<package>@latest` from its
next start. The newest has no lockfile: it goes through npx as before, and the row says so
("through npx: untested, its packages not locked"). An adapter installed on its own still wins over
both (the row says "your own install"), and `B42_PIN_CLAUDE` / `B42_PIN_CODEX` win over everything
(how the check below tries a version before it is pinned): through npx too, said the same way. A
pin with no lockfile of its version (moved by hand) also goes through npx.

### Updating the agents' adapters

Bump a pin when a new model you want arrives (a new Claude adapter), when a fix you need is out,
or after the weekly check says there is a newer one:

```sh
npm run agents:check                                  # each pin against npm's newest, with dates
npm run agents:check -- --test claude --model haiku   # the real check against the newest
npm run agents:check -- --test claude --bump          # …and pin it, only if every check passed
```

The first only asks npm, and says how each pin's lockfile stands. `--test` builds the tests and
runs `test/acp.real.ts` with `B42_PIN_<ID>=<newest>`: it starts the agent with your login in a
throwaway folder and spends your tokens on a few tiny prompts (it says so before it starts).
`--bump` goes on only when all checks passed: it makes the lockfile (`npm install
--package-lock-only --ignore-scripts --registry=https://registry.npmjs.org/` in a throwaway
folder, whatever your npmrc says: only the packages' metadata is fetched, nothing installed, no
script run), and refuses it when it can't be used (a package with no sha512, one not from
`https://registry.npmjs.org/`, one that needs its install script, one of the four platforms
macOS arm64 and x64, Linux x64 and arm64 missing). The check ran npx's tree, resolved then, and
the app installs the lockfile's, resolved after: so `--bump` writes the lockfile into
`src/main/adapter-locks/<id>/` and the new version, the date and the count into
`agent-pins.json`, builds again, and runs the check once more from that lockfile as the app
installs it (`B42_REAL_FROM_LOCK`: into `~/.bicycle42/adapters` with npm ci, never npx or your
own install, and it must say it ran from that lockfile's folder). Only when that passes in full
is the pin kept; otherwise both files are put back as they were. Commit both. `npm run
agents:check -- --lock <id>` makes the lockfile of the version pinned now again (after moving a
pin by hand), and says it is untested: `npm run agents:check -- --test <id> --from-lock` runs the
real check from the lockfile as it is, installed as the app does, and writes nothing.

- **One process for all of an agent's conversations.** Started on the first call, in its own
  process group, and started again with a growing pause (1 s to 30 s) when it dies; the app
  stops listening (quit, another agent) by ending the group, so what it started ends with it.
  The connection is then `offline` with `retry`, and the panel's banner says only "Can't reach
  Claude Code. Notes wait until it is back." One that dies five times in a row just after it
  started is not started again by itself: no `retry`, and the banner prints the error and what to
  do ("Claude Code keeps stopping at start: … Fix it, then Retry."), as for any start that nothing
  tries again. When what stopped it is a sign-in it wants (`needsSignIn` on its error), the
  offline state carries `signIn`, with the known agent's sign-in command (`login` in agents.ts),
  and the banner says that instead of the agent's own words ("Please run /login" read as
  something to type in the box under it): "Claude Code isn't signed in. Sign in: `claude` Copy,
  then Retry." ("Sign in on dev-box:" for an agent on another computer, "Sign in to it in a
  terminal" for one the app does not know); the error is the banner's tooltip. While it is
  offline (and not `away`), the turn under way reads "Paused on ④", with no spinner or clock (its
  running tools show nothing where the spinner was), the notes list's working group reads
  "Paused", and the box keeps Send
  instead of Stop: the run Stop would end went with the process. A message sent then is queued
  as any is offline, and starts the agent again at once (failing with the reason if it can't).
  A dev server the agent starts is a background command of its own shell tool, which ACP gives
  the client no way to list or stop: it lives as long as the agent's process. The request to get
  the site running says so (`startPrompt`).
- **One conversation model, two ways in.** Each conversation opened in the process is kept as
  ChatItems, built by one path (`apply`) from the live `session/update` notifications and from
  the replay `session/load` sends, so a re-read in a new process gives the same items, ids and
  part keys as the stream. One assistant item per turn (`a_<message id>`); text and thinking are
  parts keyed by kind and ordinal, a new part where a tool call or a new message id of the
  agent's comes between; a tool part is everything its updates said, merged. A conversation
  loaded once is read from the model after that, not loaded again.
- **The ledger** (`<data folder>/agents/<id>.json`). ACP lets a client choose no message ids and
  its replay names messages its own way, so the app keeps, per conversation, the id each message
  it sent had, by a hash of its text: a replayed user message gets its id from there (a note
  stays its note), one the app did not send gets an id of its place. Also kept: how a turn ended
  when it was stopped or failed (the agent does not keep the line), the conversation's folder,
  name and whether it is a background one, and what was under way when the process ended.
  Claude Code's own `[Request interrupted by user]` message is left out of a replay: the chat
  has "Stopped".
- **The queue is the adapter's.** ACP takes one prompt at a time; the rest wait in `acp.ts`
  with inbox and run events (queued, working, cancelled; the run started once and ended when the
  queue is dry), which the notes move by. Stop is `session/cancel`,
  parks the queue, and answers the agent's open permission and question as cancelled; the next
  message wakes it. Steer is the agents' `_session/steering` extension (Claude Code's adapter and
  `opencode acp` advertise it in `initialize`): the message joins the turn under way and the rest
  of the turn goes under it; when the turn has ended meanwhile it is queued. Where the agent
  itself puts a steered message can differ (OpenCode puts it after the step it arrived during),
  which a re-read from a new process shows.
- **A process that ends with work in flight.** The turn under way fails with the reason
  ("Claude Code stopped: it exited with code 1 (its last line on stderr)"), what waits is
  cancelled: each note with Retry. Quitting with work in flight puts its ids in the ledger
  (`lost`), and the controller stops those notes when it next settles them.
- **A conversation is let go only when the agent's list lacks it too.** A `session/load` that
  answers "not found" (-32002) is not enough: Claude Code's adapter says that whenever the program
  it starts to resume a conversation quits before answering, as it does while whatever ended the
  process before is still wrong, and the app used to drop the conversation from the ledger and
  open a new one in the site's place (after the agent died and came back, or Retry). Now, unless
  `session/list` for its folder, read to its end, lacks it, the conversation stays open and the
  site's, what this process showed of it stays readable with "Claude Code can't open this
  conversation again now: …" under it, and the next message or re-read tries again.
- **What the agent offers** comes per conversation: models, effort and modes are its config
  options (category model, thought_level, mode; an agent from before those, `models` and
  `session/set_model`), slash commands its `available_commands_update`, the context's fill its
  `usage_update` (`ContextUse.limit` is the window it gives). The last options seen are kept, so
  models are known on connecting; Claude Code also answers `session/options` before any
  conversation. A change is a `{ type: "agent" }` event, and the controller reads them again.
  `/compact` is the agent's own command when it has one (`can.compact`).
- **The model is said as the agent says it** (`main/model-facts.ts`, `shared/models.ts`). A
  model's name loses its provider ("moonshotai/Kimi K3.1 Pro" is "Kimi K3.1 Pro" under
  moonshotai), so when two providers have a model of one name the chip and the lists name the
  provider beside it (`modelLabel`). Free and pre-release models carry a quiet label ("free,
  alpha"), from their name or id and from OpenCode's own metadata (its "opencode" provider at no
  cost; `status` alpha or beta); "Free" leaves the name once the label says it. Which models see
  pictures: the agent's `promptCapabilities.image`, and for OpenCode `opencode api GET /api/model`
  (2.x, through its background service; `opencode models --verbose` on 1.x), run on the agent's
  computer through its `Machine` and read once per list (`ModelInfo.images`, "no images"). The
  conversation's model is the option's `currentValue` as the agent last said it (its answer to
  `set_config_option`, a `config_option_update`), never what the app asked for; a model the agent
  changes by itself gets a line in the chat, and one a new conversation could not start on says
  why and which it is on. Each turn keeps the model that answered (`ChatAssistant.model`,
  "Worked for 2m · Kimi K3.1 Pro"): Claude Code's adapter says it with its token count
  (`usage_update._meta["_claude/model"]`, an API id matched to the list's name by `modelWords`),
  others by the conversation's model when the turn began; the ledger keeps it for a re-read.
- **Pictures a model did not see are said on the message** (`ChatUser.unseen`): the agent takes no
  pictures (they are not sent), OpenCode says the model takes text only, or the model's answer
  repeats what OpenCode puts in a picture's place (`ERROR: Cannot read "…" (this model does not
  support image input)`). The message goes all the same, and the box says the model in use sees
  no images, with the way to another one beside it. Codex refuses such a message instead; its
  error says so in those words.
- **A sign-in and a provider's refusal are told apart.** An auth error (ACP's -32000, or words for
  it) at `initialize` or a new or loaded conversation asks for the agent's own sign-in, as before.
  The same on a prompt of an agent whose models are several providers' (their names say
  "provider/…"), or one that names a provider, is that provider refusing the agent's key: the run
  fails saying the model and the provider and that the agent itself is signed in, and its line
  (`ChatMarker.refused`) offers another model and the agent's own command to add a key, read from
  its `authMethods` ("Run `opencode auth login` in the terminal").
- **Done here, not by the agent**: folders (`listFolders`), `@`-files (`git ls-files`, else a
  walk), the branch and its changes (`git status`, `git diff --numstat HEAD`), projects (the
  folders of the conversations the ledger and `session/list` know). "Here" is the agent's
  computer (`AcpOptions.machine`): this one, or the one it runs on over ssh.
- **An agent on another computer** (`connectSsh`, then `connectAgent` with `host`; saved as
  `{ agent, command, host }`, its ledger `<id>@<host>.json` here) is the same backend over a
  `RemoteMachine` (`ssh.ts`): the system's ssh with the reviewer's own config and keys, never a
  password (BatchMode), one ControlMaster connection per host for every call and forward, and the
  app's helper (`src/helper/helper.ts`) as a daemon there, attached to over that connection. A
  connection attaches first, and starts the helper only when none runs: with scripts sent to
  `sh -s` on stdin, so any login shell (bash, zsh, fish, csh) runs them alike and Windows's is said;
  they find the newest node of 18 or later on the plain and the login shell's PATH (marker lines,
  so a noisy profile is not read; remembered per host; a profile that never finishes is ended
  with SIGKILL after 10 s and said), and start the helper in the same session. Attaching first
  uses ~/.bicycle42 only when it is this user's alone; else the probe runs.
  What stops the helper starting is said as a code and a sentence (EACCES, EROFS, ENOSPC, a home
  too long for a socket's path, the helper stopping as it starts, from its own log of that start),
  never node's last line; a socket there that is not this user's is never spoken to, and
  ~/.bicycle42 there is tightened as the app's own folder here is. The connect screen says the
  step it is at after a second (`AppState.sshStep`). The
  helper is `Machine` (`machine.ts`, the same code as here) as JSON-RPC plus a host for the
  agent's process, which outlives the connection: its output is kept until read (8 MB, then the
  oldest lines go and the app re-reads the conversations: `Child.onGap`), its stdin numbered, so a
  reconnect reads and writes nothing twice. The wire (`src/shared/wire.ts`) is one JSON message a
  line, split on the newline byte and decoded whole (text of any language survives any cut), 64 MiB
  a line at most each way (a longer one from there drops the link with a sentence; an answer too
  long is an error, E2BIG); the helper says its `protocol` in `hello` and the app refuses another
  (except `ping`, `hello` and `endOwner`, frozen for every version, `LIFECYCLE`: when an app says
  hello, its helper asks every other version's there to end what an earlier run of that install
  left with it, so an update does not leave the old version's agent running for 12 hours; a helper
  from before endOwner answers it ENOSYS and ends what it keeps with its lease);
  every call's params are checked (EINVAL); each spawn has a key, so one sent again after a drop
  is the same process; and what waits for the agent's stdin goes joined, 4 MiB a write. The app's
  ssh never forwards the reviewer's agent or X11, and a changed host key is said as a possible
  attack. While the computer can't be reached the connection is
  `offline` with `away`: nothing is failed, cancelled or forgotten (turns under way stay), notes
  wait, working ones stay working, and Retry (`reconnect`) tries the connection, not the agent.
  The app's file history of its folders is kept there (`~/.bicycle42/snapshots`) and git runs
  there: snapshots and take-backs all go through that computer, never this computer's disk. The
  work on a folder is done where its files are (`ops.ts`): the helper runs the same code as the
  app does here (the repo's line, `vcs.ts`; the history's git side, `snapshots.ts`'s `Shadows`)
  over its own files, and the app asks once per operation: a snapshot, a take-back's dry run, its
  run with the restore written down in the same call (a link that drops meanwhile leaves both
  made or neither; the reviewer is told the link dropped, and the note says it is taken back once
  it is back), a change of the log (made there on the log as it is on disk, so a log that could
  not be read is never written over), the repo's line, each one call however many git commands it
  is there. The log is read once and kept by the app (a read that fails is not kept), and no
  message waits on a call before it goes. git's output is read up to 64 MiB there: a turn whose
  patch is longer is left to the agent, with a sentence. The address the agent reports (`SITE:` on its
  localhost) is forwarded here (`ssh -O forward`, the same port when it is free) and opened; the
  request to start the site says nothing of binding to the network or of a tunnel for it. Which
  addresses are that computer's is read from the address alone, parsed as the browser does, with
  no DNS (`site-address.ts`): its loopback however written (`[::ffff:127.0.0.1]`, `0x7f.1`), its
  unspecified address, `localhost` and names under it. Anything else (`localtest.me`, a LAN
  address, the web) would load from this computer, so it is offered (`AppState.page.elsewhere`,
  "Open it here"), never opened by itself.
  Tested against a fake ssh (`test/fake-ssh.ts`), whose "other computer" is this one under a home
  of its own, and with `unshare` a folder of its own at the same path.

| `Backend` | ACP |
|---|---|
| `info` | `initialize` (starts the process) |
| `projects` | `session/list` without a folder, and the ledger's folders |
| `listFolders`, `findFiles`, `vcs` | the agent's computer's fs and git (`Machine`) |
| `models`, `agents` | config options (model, thought_level, mode), else `session/options` |
| `sessions`, `session` | `session/list` with the folder, and the ledger |
| `createSession` | `session/new`, then `session/set_title` and the model's options |
| `setModel`, `setAgent` | `session/set_config_option` (or `session/set_model`, `session/set_mode`) |
| `prompt`, `command` | the adapter's queue → `session/prompt` (a command is `/name args`); steer: `_session/steering` |
| `commands` | `available_commands_update` |
| `skills`, mention agents | none |
| `compact` | the agent's `/compact`, when it has one |
| `rename` | `session/set_title` where offered, and the ledger |
| `archive` | `session/archive` / `unarchive` where offered (`can.archive`) |
| `remove`, `fork` | `session/delete`, `session/fork` where offered |
| `cancelQueued`, `waiting` | the adapter's queue |
| `stop` | `session/cancel` |
| `transcript` | the model; `session/load` (its replay) the first time in a process, else `session/resume` |
| `replyPermission` | the answer to `session/request_permission`, as the option of that kind |
| `answerQuestion`, `dismissQuestion` | the answer to `elicitation/create` (form): accept, decline |
| `listen` | the `session/update` notifications; the process's life as `connection` |

`test/acp.real.ts` drives a real agent through it (`node dist/test/acp.real.cjs claude haiku`,
after `node scripts/build.mjs --tests`): a note-like turn, the queue, Stop, steer, the repo, and a
re-read from a new process against the stream. It spends the agent's tokens; not part of `bun run test`.

## The page as a phone's, and docks the window draws

- **Desktop | Phone, beside the address** (`setDevice`, `page.device`; kept in settings). As a
  phone's, the window gives the page a box the size of the chosen phone's screen at most (one of
  `PHONES` in `shared/types.ts`, 390 by 844 until another is chosen; the `.stage.phone` rules,
  from `--phone-width` and `--phone-height`) and main asks Chromium for its own phone emulation
  (`setDevice` in `main/page.ts`): the viewport tag counts and scrollbars lie over the page, so
  the page is laid out 390 wide, not 375. A page with something wider than the window is shown
  zoomed out to fit, as a phone shows it.
- **The window draws the phone; the page is the part of the screen between its bars.** The
  phone's body (`.device-body`) is the screen's shape, with a ring 8px wide outside it in the
  foreground at a tenth. Inside, top to bottom: the status strip (the time, the cut-out, signal,
  wifi and battery; `StatusStrip` in `renderer/phone-frame.tsx`), the page's box, and the home
  strip with the home indicator (`HomeStrip`; none on the SE, which has a home button). Each
  phone in `PHONES` says how tall the two strips are (`top`, `bottom`, its browser's safe-area
  insets, sources in the comment there), its cut-out (an island, a notch, a punch-hole, none) and
  whether it has a home indicator. The page's viewport is the screen less the strips, as in a
  phone's browser (`viewportOf`: 390 by 763 on the 16e), while `screen` is the whole screen
  (the emulation's `viewSize` and `screenSize`). Sizes at the size the phone is drawn are
  `frameOf` in `renderer/phone.ts`: the strips and the box add up to the body on whole pixels,
  and the body is moved by the fraction of a pixel its column centres it at (`report` in
  `app.tsx`: a relative offset, as `translate` snapped its rounded clip a pixel short), so the
  native view meets the strips exactly. The window cannot draw over the native view, so nothing
  here is on the page: the strips are beside it. The view's corners never have to match a curve
  of CSS's (macOS draws a native view's as a continuous curve, which CSS's arcs never followed,
  so a phone's page had no hairline before): they are square between the strips, except where a
  strip is less tall than the screen's corner is round (an iPhone's 34 px below a 62 px corner),
  where a square corner would reach 6.7 px past the screen over the ring. There the view is
  rounded just enough to stay inside (`viewRadius` in `shared/types.ts`, `phone.test.ts` checks
  every phone), and what shows in the gap is the strip's colour.
- **The strips are in the page's colours**, as a phone's browser colours its bars. Main asks the
  page in the overlay's world (`TINT_PROBE` in `main/page.ts`): above, its `theme-color` (the
  first whose media matches), else the first opaque background at its top; below, the same at
  its bottom; with neither, its canvas (white, or Chromium's dark one for a page dark by its
  `color-scheme`). Any CSS colour is read by drawing it on a canvas. Asked once a load is done
  and a moment later, after a move within the page, a tap, a drag or the wheel (250 ms on), and
  when the system's theme changes; only as a phone's (`page.tint`). The time and icons are black
  or white, whichever has the larger contrast (`inkOn`); black strips with white ink until the
  colours are known.
- **In Preview the mouse is a finger** (`setTouch` in `main/page.ts`, asked by the controller
  with every state it pushes: a phone's page, in Preview, with a site). What Chromium's own
  device mode does, over the page's debugger: `Emulation.setTouchEmulationEnabled` and
  `setEmitTouchEventsForMouse` ("mobile"). The page has no hover on mouse-over, `:hover` sticks
  where the finger last tapped, `(hover: none)` and `(pointer: coarse)` match,
  `navigator.maxTouchPoints` is 5, a press is a touchstart and a click a tap; the wheel and a
  trackpad still scroll (the emulator lets them through). Nothing is reloaded: a page that looks
  for `'ontouchstart' in window` finds it from its next load. In Annotate, Edit and Motion, and
  on a desktop's page, the debugger is detached, which undoes all of it, so the overlay picks
  with a real mouse's hover. The debugger is attached only after the view's first commit and
  never while its renderer is gone (as the emulation: asked of a view that has loaded nothing,
  Chromium crashes the whole app); after a reload,
  a crash or another site it is told again once the document has committed. It asks only the
  Emulation domain, so the page's console still never reaches main. The page's developer tools
  (alt+mod+J) are a client of their own beside it; a debugger someone else attached (a test's)
  is used and left attached. Closing the page detaches it first.
- **A phone is shown whole, as large as life or as large as fits.** Its page sits in the middle
  of a column of its own (`.device-col`), with which phone it is right above it. A phone taller
  than that column is not cut: the box keeps the phone's shape, smaller (`fit` and `pageBox` in
  `renderer/app.tsx`), and main draws the page smaller in it, by the box's width over the
  phone's (the emulation's `scale`, with the phone's own size as the page's): `100vh` is the
  phone's (less its strips) in a short window too, and the picker says "· 94%", the drawn
  width over the phone's. The column is as wide as
  the widest phone, so another phone or another scale moves nothing beside it; the column at
  its right is 300 to 720px wide until its edge is dragged, and the panel cannot be dragged so
  wide that it gets less than 300 (`maxWidth`, `--panel-max`).
- **The column at a phone's right is as wide as its left edge is dragged** (`.column-resizer`,
  `columnChosen` in `renderer/app.tsx`; kept as `dock.width`, as the dock's height is
  `dock.height`). The edge is the panel's, mirrored: its pill where the pointer is, arrows step
  16 px (left wider), Home and End go to its limits, a double click gives the column the room
  that is left again, and the page is away while it is dragged. At least 300 px, at most what
  leaves the phone its own column (the phone's body as drawn, with its ring and air at each side,
  `.device-col`'s min-width): the phone is drawn smaller only for the window's height (`fit`),
  so a wider column stops at the phone, and the phone stays whole in the middle of its column.
  Chosen, the column keeps its width in every mode; a panel dragged wider, or a narrower window,
  takes it down to 300 and gives it back. Set on the stage as `--dock-width`, which does not
  inherit, as `--dock-height` does not.
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
  tag. Each fact is said once: the phone's size is the picker's above the phone, how many of each
  kind and "Fits this phone" are the line's (below), so the sections' headings have no counts and
  the body only the page's height. The pointer on a row outlines its element on the page, a click
  brings it into view, and in Annotate "Note" makes it the note's selection (main puts the keys
  on the page then). Under them the files the agent changed, and the two keys worth knowing here.
  Every row is the same grid (words, number, a slot as wide as Note, empty where there is
  none), so every number ends at one x; Note is out of sight until its row is pointed at (or has
  the focus: it stays in the tab order), so nine of them do not outweigh the facts. 620 px wide or more, the facts and
  the changed files are two columns. Units are written with a space ("+134 px"). The changed
  files are words, not controls: the path's last two segments, the full one in the title.
- **The phone line: the facts pane's header** (`PhoneLine` in `facts-pane.tsx`; Preview and
  Annotate only). 36 px, as the inspector's header, the words 12 px in; its accessible name is
  "This page on this phone". At its left the counts, each a quiet button with its kind's dot ("2
  stick out", "5 small taps", "2 fields zoom"; none for a kind with none), "Fits this phone" when
  all are none (its title says what that means), the missing viewport tag instead when there is none, "Looking at the page…" until
  the first look. The pointer on a count (or the focus) marks that kind on the page while it is
  there; a click goes to the next of them (`nextOf`, cycling): the page scrolls to it and flashes
  it, and the pane's row for it comes into view, lit a moment. At its right the Marks switch
  (the app's `Toggle`, from `connect.tsx`): every listed element outlined on the page in its kind's
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
  panel's side does) or, beside a phone's page, in the column at the page's right (its left edge
  drags).
- **A dock is a card, as the panel's sections are**, under the page and beside a phone's alike
  (the facts pane, the inspector, Motion's dock): `--card`, the quieter rule, 10 px corners, and
  8 px from the window's edge and from what is next to it (`.dock` in `styles.css`). What is in
  it was tuned for paper and is tuned for the card: every control's hover is `--card-hover`
  (`--hover-fill` on `.dock`), fields are paper set into the card as the message box is (their
  edge shows on Motion's fields' hover; an inspector value turns paper on its row's hover), the
  Element | Global track is a ring, and Motion's ruler is the card's colour; the popovers over
  a dock (suggestions, keys, edits, Motion's sheets) are paper and keep the paper's hover. Each
  fill is 1.16 to 1.22:1 on the card in either theme, where the paper's fills were 1.03 to 1.05
  on it.
  What a view and an act carry is each pane's own file: `overlay/protocol-motion.ts`,
  `overlay/protocol-canvas.ts`, `overlay/protocol-facts.ts`.
- **Motion's dock is the window's** (`renderer/motion-dock.tsx`, its own `motion-dock.css`):
  the list, the open animation's header, timeline and keyframe, the note and Send. It is motion
  mode's only dock: the overlay draws none, and keeps what is on the page (the tag, the
  outlines, a click that opens what was clicked, the keys while the page has the keyboard). Its
  layout asks its own box (container queries, which style what is in the box, never the box):
  wide, the list beside what is open; narrower than 720, one or the other with a way back and
  narrower lane names, and the group's "2 elements" is "2" so Duplicate stays whole; narrow and at least 600 tall (beside a phone's page), the list above
  what is open. The timing fields keep their names at every width ("900 ms" alone leaves one
  guessing which it is): where the header has no room for them in one row (under 1100 px) they
  take a row of their own, and come last in the markup so Tab reaches them after the row above
  (in one row, `reading-flow` keeps Tab in the order seen); in a dock under 640 the rest of the header is one row and the names
  are short ("Dur.", "Delay", "Ease"), so the three fit in the second, and an easing too long
  to fit whole there takes a row of its own. A short dock (under 400 tall) draws its rows
  closer: the header, the keyframe's row and the note's, the ruler, so a 1000×720 window shows
  two tracks whole with a keyframe selected; there, if also narrow, a keyframe's easing that is
  its animation's (the placeholder) is cut before that row takes two. Until dragged, the dock under a page is 360,
  or in a short window what leaves the page 300, never under half. The header's controls are words
  where a picture would need its title: "Only this" (show only this element), and "Reset" (put
  back as the page has it, or remove a new animation), named as the inspector's footer names it;
  undo stays an icon, as everywhere in the window. The playhead's flag is its time ("0.38s"),
  with no second number beside Play. A list that is not the whole page's (the overlay looked at a part of a very
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
  The headings say no more than "Element styles" and "Computed · edit to override": what the
  boxes are (this element only, `&` nests; a computed value edited goes into Element styles) is
  in the "?" list, put there by the window ahead of the overlay's keys.
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
- Shots: `phone`, `phone-se`, `phone-island`, `phone-notch`, `phone-pixel`, `phone-galaxy`,
  `phone-dark-page` (a dark page: its strips dark, white ink; `&page=dark`), `phone-wide`, `phone-clear`,
  `phone-column-wide`, `phone-column-narrow` (the column at its most and its least), `dock`, `phone-dock`,
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
- A note's diff is its turn's, and a message steered into a run while the agent is on a note
  joins that turn, so its changes show in the note's diff and go with it when it is taken back.
  Another agent the app does not run (a terminal agent in the same folder) is not seen: what it
  changes during a turn counts as that turn's.
- The picture after the agent is done is taken only while the page the note was made on is
  open at the same width; a note finished while the reviewer is elsewhere has none.
- Choosing the message to fork from (a fork copies the whole conversation).
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

<img src="assets/icon.png" width="96" alt="bicycle 42">

# bicycle 42

A bicycle for two: the designer and the agent.

bicycle 42 is a desktop app for reviewing a web page together with a coding agent. The page under
review fills the window. You click or draw on it and type a note, or change it directly in edit
mode (DOM tree, raw CSS, drag), and each note goes to an agent on an
[OpenCode](https://opencode.ai) server, which makes the change in the code while you keep going.
It is for designers who work with a coding agent, and it is open source.

![The overlay on the bundled test page](overlay/docs/harness.png)

## Requirements

- An OpenCode server, on this computer or another one.
- Node 22 or newer with npm, or Bun.

## Run it

```bash
cd app
bun install          # or: npm install
bun run start        # or: npm start. Builds, then opens the app
```

`bun run pack` (or `npm run pack`) builds a real app for this computer in `app/release/`, with
its own name and icon. It is not signed with a developer certificate, and there are no installers yet.

## First launch

1. **Connect.** If OpenCode is running on this computer the app finds it: press
   **Use this computer**. (`opencode service start` starts one.) For a server on another machine,
   enter its address and password: `opencode service status` there shows the address (the
   `https://….opentunnel.xyz` one works from anywhere) and `~/.config/opencode/service.json`
   holds the password. If the server offers more than one model, you then choose the one new
   conversations start with; it can be changed any time under the chat box.
   Every server you connect to is remembered: the settings and the connect screen list them
   under **Connected before**, and going back to one needs no password and brings back its
   repo, page and notes.
2. **Open the repo**: the folder on the server that holds the site's code. The agent works
   there, and you can talk to it from then on.
3. **Open the site.** Type your dev URL in the top bar, for example `localhost:3000`. If the
   site is not running, press **Ask the agent to start it**: it starts the dev server (or serves
   plain HTML), is told whether the app is on its computer or another one so it gives an address
   that opens here, asks when it needs something, and the app opens the address it reports.

A dev server the agent started keeps running after its reply. While the server has
something running, a count with a stop mark shows at the end of the address line: it opens the
list of what is still running, in the open repo and in the server's other projects, each with
its own **Stop**.

After that, the app reopens the last page with its notes and conversation. A site opened for
the first time works in the repo that is open; the folder can be changed from the panel.

**Another project:** the **+** beside the conversation's name lists the server's projects
(type to narrow, `↑` `↓`, `Enter`; `mod+1`…`9` for the first nine; a path starting with `/`
opens any folder), with a new conversation in the open project as its first row. A project
opens on the page it was last on, with its notes and conversation, or with no page yet. Each row
says which computer the project is on; the projects of servers you connected to before are in
the list too, and choosing one connects to its server first.

**Conversations:** a conversation is named after the first thing you say in it, a note or a
message; `/rename`, or the pencil in the list, gives it a name of your own, which is kept. The
conversation's name opens the list of the project's conversations, newest first, each with the
number of this site's notes that went to it. Typing narrows it by name and by what the notes
said. A row can be pinned to the top, renamed, archived (it leaves the list and can be brought
back from **Archived**) or deleted for good; archiving or deleting the open one opens the
most recent other one.

**A note, opened:** click a note in the list and it takes the panel, above the message box,
with **Notes** (or Esc) to go back and arrows to the note before and after. It shows what the
note says and, once the agent is done, what came of it. Its area as it was when
you made the note and as it is now the agent is done (the second picture is taken only on the
page the note was made on, at the same window width); what changed in the code for it (notes
that waited together for the agent share one diff); and three things to do: **Accept** it,
**Follow up** on it in the conversation, or **Take back** what the agent did. The newest
message is taken back exactly, files included; for an older one the agent is asked to reverse it.

**Checkpoints and commits:** `/checkpoint name` marks a point in the conversation. Its line
has **Return here**, which takes back every message after it and the files the agent changed
since (in a git repository; `/redo` brings it back until you say something new). When the repo
has uncommitted changes, the conversation's header shows how many lines are added and removed;
open it for the branch, the files and a commit message started from the finished notes, and **Commit**
asks the agent to commit everything, without pushing.

The app makes three sounds: a rising one when the agent asks something or wants permission, a
falling one when a note fails or the server is lost, and a single note when the agent has
finished everything you sent. They can be turned off in the settings (the server button, in the
panel's conversation row), where reloading the page after a note is switched too.

The top bar has the mode: **Preview** (the page as it is), **Annotate** (point at something
and say what to change), **Edit** (change the page itself, then press Send) and **Motion** (see
what moves on the page, change one animation, then send it), with the pencil for drawing beside
them.

## Keys

`mod` is `⌘` on macOS and `Ctrl` elsewhere.

| Modes, anywhere | |
|---|---|
| `mod+U` | Preview; again, back to the mode you were in |
| `mod+P` / `mod+O` / `mod+I` | Annotate / Edit / Motion |
| `mod+shift+P` | The pencil: draw on the page |

| Annotate mode | |
|---|---|
| click / `shift`+click / drag | Select an element / add one / select an area |
| `alt`+drag, or the pencil button | Draw. A line selects what it crosses, a closed loop what it encloses |
| `↑` / `↓` | Parent / child element, while the note is empty |
| `Enter` / `alt+Enter` | Send the note / send it to the background conversation |
| paste a picture | Attach it as a reference |
| `Esc` | Cancel the note; again for Preview |
| `mod+L` / `mod+K` / `mod+\` | URL bar / chat box / show or hide the panel |
| `mod+R` | Reload the page |

| Edit mode | |
|---|---|
| click, or a row of the tree | Select an element |
| drag an element / an edge / a gap | Move it among its siblings / resize it / change the gap |
| hold `mod` while dragging | No snapping |
| double-click text | Edit it in place |
| `Delete` | Hide the selection |
| `mod+Z` / `mod+shift+Z` | Undo / redo |
| `Enter` (`mod+Enter` in a text box), or **Send** | Send all the edits as one note |

| Motion mode | |
|---|---|
| click on the page, or a row of the list | Open what moves it (a row's elements are outlined while the pointer is on it) |
| click a grip / drag it | Show that frame / move the keyframe in time (hold `mod`: no snapping to 5%) |
| click a bar | Select the stretch between two keyframes, to change its easing |
| press twice on a lane | Add a keyframe there |
| `Space` / `←` `→` | Play or pause / step (`shift`: bigger steps) |
| `Delete` | Remove the selected keyframe |
| `mod+Z` / `mod+shift+Z` | Undo / redo |
| `↑` `↓` then `Enter` in a property or easing field | Pick from its list |
| `Enter`, or **Send** | Send the open animation as one note, with the words typed for it |
| `Esc` | The keyframe, then the animation, then back to Annotate |

Keyframes belong to their name, so a change to them changes every element that plays them (the
timeline says how many); **Duplicate** gives the element a copy of its own. Duration, delay,
easing and the rest belong to the element.

In the chat box, `/` lists commands: the app's own (`/compact`, `/new`, `/undo`, `/redo`,
`/rename`, `/fork`, `/checkpoint`), then the ones the site's folder defines on the server. `@` names a file,
a skill or a helper agent.

## Not built yet

- Signed builds and installers.
- Tabs and device widths.
- Edit mode: adding elements, moving one into another container, reordering in block flow.

The full list is in [app/README.md](app/README.md).

## Test

```bash
cd overlay && bun install && bun run test  # the in-page layer, in headless Chromium
cd app && bun install && bun run test    # unit tests, then the app in headless Electron
```

## Licence

MIT, see [LICENSE](LICENSE).

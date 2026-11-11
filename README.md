<img src="assets/icon.png" width="96" alt="bicycle 42">

# bicycle 42

A bicycle for two: the designer and the agent.

bicycle 42 is a desktop app for reviewing a web page together with a coding agent. The page under
review fills the window. You click or draw on it and type a note, or change it directly in canvas
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
2. **Type your dev URL** in the top bar, for example `localhost:3000`.
3. **Pick the site's folder** on the server, once per site.

After that, the app reopens the last page with its notes and conversation.

The app makes three sounds: a rising one when the agent asks something or wants permission, a
falling one when a note fails or the server is lost, and a single note when the agent has
finished everything you sent. The speaker button in the top bar turns them off.

## Keys

`mod` is `⌘` on macOS and `Ctrl` elsewhere.

| Notes mode | |
|---|---|
| `mod+shift+M` | Review mode on or off |
| click / `shift`+click / drag | Select an element / add one / select an area |
| `alt`+drag, or the brush button | Draw. A line selects what it crosses, a closed loop what it encloses |
| `↑` / `↓` | Parent / child element, while the note is empty |
| `Enter` / `alt+Enter` | Send the note / send it to the background conversation |
| paste a picture | Attach it as a reference |
| `Esc` | Cancel the note; again to leave review mode |
| `mod+L` / `mod+K` / `mod+\` | URL bar / chat box / show or hide the panel |
| `mod+R` | Reload the page |

| Canvas mode | |
|---|---|
| `mod+E` | Canvas mode on or off, inside review mode |
| click, or a row of the tree | Select an element |
| drag an element / an edge / a gap | Move it among its siblings / resize it / change the gap |
| hold `mod` while dragging | No snapping |
| double-click text | Edit it in place |
| `Delete` | Hide the selection |
| `mod+Z` / `mod+shift+Z` | Undo / redo |
| `Enter` (`mod+Enter` in a text box) | Send all the edits as one note |

In the chat box, `/` lists commands: the app's own (`/compact`, `/new`, `/undo`, `/redo`,
`/rename`, `/fork`), then the ones the site's folder defines on the server. `@` names a file,
a skill or a helper agent.

## Not built yet

- Signed builds and installers.
- Tabs and device widths.
- Before and after pictures of what the agent changed, and taking back one note
  (`/undo` takes back the last message and everything after it).
- Canvas mode: adding elements, moving one into another container, reordering in block flow.
- Running the overlay in an isolated script world.

The full list is in [app/README.md](app/README.md).

## Test

```bash
cd overlay && npm install && npm test    # the in-page layer, in headless Chromium
cd app && bun install && bun run test    # unit tests, then the app in headless Electron
```

## Licence

MIT, see [LICENSE](LICENSE).

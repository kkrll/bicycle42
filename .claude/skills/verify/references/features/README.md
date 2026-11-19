# Feature map

One file per feature. Each answers four things: what exists, how a user reaches it, how to drive
it with `app/scripts/drive.mjs`, and what usually lies about it.

Sweep order, when a change touches more than one: `page`, then the mode (`annotate`, `draw`,
`edit`, `motion`), then `notes`, then `chat`, then the window's own screens.

| Feature | File | Code |
|---|---|---|
| The page view, the URL bar, reload | `page.md` | `app/src/main/page.ts` |
| Annotate mode: a note about elements | `annotate.md` | `overlay/src/notes/`, `review.ts` |
| The pencil: drawing on the page | `draw.md` | `overlay/src/notes/`, `overlay/src/canvas/` |
| Edit mode: change the page, send the edits | `edit.md` | `overlay/src/canvas/` |
| Motion mode: one animation per note | `motion.md` | `overlay/src/motion/` |
| A note after Enter: queued to done, pins | `notes.md` | `app/src/main/core.ts`, `review.ts`, `panel.tsx` |
| The chat, the composer, commands, mentions | `chat.md` | `chat.tsx`, `composer.tsx`, `opencode.ts` |
| Connect, servers, the model to start with | `connect.md` | `connect.tsx`, `local.ts`, `store.ts` |
| Repo, projects, the switcher, what is running | `projects.md` | `switcher.tsx`, `running.tsx`, `core.ts` |
| Settings and sounds | `settings.md` | `menu.tsx`, `cues.ts`, `sound.ts` |
| A packed app | `pack.md` | `app/scripts/pack.mjs` |

Every file shares these lies:

- A window shot (`<name>-window.png`) never shows the page: the page view paints over the window
  and the capture leaves it out. The pane where the page sits is empty there. Read
  `<name>-page.png` for the page.
- Shots are at the display's scale (2x on a Retina Mac); steps take page CSS px. Read
  coordinates from `getBoundingClientRect()`, never off a shot.
- `window.__b42` exists only in the overlay's world. `page typeof window.__b42` says `undefined`
  even when the overlay is running; use `overlay ...`.
- The harness pages have no Content Security Policy, so `log` always shows Electron's "Insecure
  Content-Security-Policy" warning for the page. It is not a regression.
- The fake server answers but never works: a note stays `queued`. What happens after that is in
  `notes.md`.

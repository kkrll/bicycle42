# Main process

`app/src/main/` owns everything durable; the window and the page are views of `AppState`.
`app/README.md` ("How it's built") is the map. This guide holds the rules no check enforces.

## The window is a client, not a peer

- The window reaches main through `window.b42` only (`app/src/preload.ts`). A new capability
  is a command in `Commands` (`app/src/shared/types.ts`) and a handler in `commands` in
  `core.ts`, never a new IPC channel.
- A command's arguments arrive from the renderer as `unknown[]`. Check their shape in the handler
  before use, the way `pageNote` checks a note. The types in `Commands` say what a well-behaved
  window sends; they do not check anything.
- The window never sees the server password or a raw server payload. `app.e2e.ts` checks the
  password is absent from the state.

## The page is untrusted

- The page has no debugger. The overlay goes in as `app/src/page-preload.ts`, in its own world,
  and talks to main over two IPC channels (`FROM_OVERLAY`, `TO_OVERLAY` in `page.ts`).
  `executeJavaScript` on the page stays in `page.ts`. Lint enforces both.
- Anything the page or the overlay sends is checked field by field before it reaches the agent
  or the disk (`pageNote`, `pageEdits`, `pageMotion` in `review.ts`). A new field in a message
  gets a check there in the same change.
- Page text goes into a prompt as quoted data, inside a fence longer than any backtick run in it.

## The core has no Electron

`index.ts` is the Electron shell and `page.ts` the page view; `core.ts` and everything it uses run
in plain Node, so `controller.test.ts` drives the whole controller through `test/stubs/host.ts`.
What the core needs from Electron goes through `Host` or `Page`. dependency-cruiser enforces this
(`the-core-has-no-electron`).

## Preferences

`app.e2e.ts` checks that both web contents are isolated, sandboxed and without Node. A change
that needs any of these off is a design question for the user, not a code change.

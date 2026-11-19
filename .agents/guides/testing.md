# Testing

Where each kind of proof lives:

| What | Where | Runs in |
|---|---|---|
| Pure logic in main (notes, the backend, the store) | `app/test/*.test.ts`, node:test | `check` |
| The page view, the overlay injected, captures | `app/test/page.e2e.ts`, headless Electron | `check --full`, CI |
| The whole app against a fake OpenCode server | `app/test/app.e2e.ts`, headless Electron | `check --full`, CI |
| The overlay's gestures and modes | `overlay/test/*.test.mjs`, headless Chromium | `check --full`, CI |
| The window's look, every state, light and dark | `bun run visual`, the renderer's mock | by hand, CI |
| The overlay's cost to the page | `overlay`: `bun run bench` | by hand |

No test needs an OpenCode server: `app/test/fake-server.ts` and `app/test/fixtures/opencode/` stand
in for it. `app/test/stubs/` stands in for Electron and the page view, so `controller.test.ts` runs
`core.ts` in plain Node (`test/stubs/host.ts` is its shell).

## A test that can fail

- Each test asserts the behaviour a user or the agent would notice: what the window shows, what
  the note carries, what the prompt says. A test that would still pass with the feature deleted
  proves nothing.
- A negative check (nothing sent, no window opened) needs the positive case beside it, in the same
  setup, so the test can tell "refused" from "never ran".
- A bug fix starts with the test that fails on the bug.
- Wait on a condition (`until(...)`), never a fixed sleep. A fixed pause belongs only where the
  thing under test is the passing of time.

## Headless Electron

The e2e tests run with `--ozone-platform=headless --disable-gpu`. The page view's renderer lays
out only after the window is resized, so a test sets a size before it measures. A renderer
screenshot (`win.webContents.capturePage`) does not include the page view, which paints over the
window: capture `page.view.webContents` for the page.

## The e2e check format

`page.e2e.ts` and `app.e2e.ts` are scripts, not node:test: `check(name, ok, detail)` prints one
line and the script exits 1 when any check failed. A new check goes in the section it belongs to,
named as a sentence about what the user sees.

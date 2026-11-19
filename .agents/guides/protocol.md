# Protocol

Two contracts hold the app together, and each has one file:

- `app/src/shared/types.ts`: the window and main. `AppState`, `Commands`, `Bridge`, `ChatEvent`,
  `Backend`.
- `overlay/protocol.ts`: the overlay and its host. `PageMessage` (page to host), `HostMessage`
  (host to page), `PageNote` and what it carries.

The app reaches the overlay only through `protocol.ts`, `prompt.js` and the built `overlay.js`.
Dependency rules enforce that.

## Changing a message

A change to either contract is one change across every side that speaks it:

1. The type, in its contract file.
2. The sender: the overlay's `send` names `PageMessage` in JSDoc, main's `page.ts` builds
   `HostMessage`.
3. The receiver's check. What the page sends is checked field by field in `review.ts`
   (`pageNote`, `pageEdits`, `pageMotion`) before it reaches the agent or the disk: known kinds,
   short one-line strings, counts with a limit. A field with no check is dropped there, so a new
   field without one never arrives.
4. The prompt, when a note changes: `overlay/prompt.js` turns a note into the agent's words, and
   `noteWords` names it everywhere.
5. A test on each side: the overlay's browser tests for the message, `review.test.ts` for the
   check, including a malformed value.

## Old data

`store.ts` versions the files on disk. A change to what is saved bumps the version and reads the
old shape, or the app on someone's machine stops opening their notes.

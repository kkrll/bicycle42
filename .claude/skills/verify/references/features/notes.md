# A note after Enter

**What.** The notes list in the panel and the pins on the page: queued → working → done or failed,
with retry, the background lane (`alt+Enter`), the sounds, and the page reload when a note is
done.

**Reach.** Send a note from any mode.

**Drive.** The driver's fake server takes prompts but never works, so a note stops at `queued`.

```
"mode notes" "click 300,150" "type x" "key Enter" "wait 1500" "state review.notes" "shot queued"
```

Later states:

- In the window: `bun run visual`, shots `busy`, `note-flash`, `tool-failed`, `canvas`, rendered
  from the renderer's mock (`app/src/renderer/mock.ts`).
- End to end: `app/test/app.e2e.ts` emits the server's events and checks each status, the pin
  and the reload. A change here gets a check there.

**What lies.**

- The mock is not main. A state that looks right in a mock shot can still be wrong in
  `AppState`. The e2e test is the proof for status rules; the shot is the proof for the look.
- A note remembers its conversation and its own message id. A test that switches conversations
  or drops the connection is the only way to see the rules in `review.ts` hold.

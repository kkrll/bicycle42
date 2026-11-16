# Annotate mode

**What.** Point at elements, write a note, press Enter: the note goes to the agent with the
elements, a crop and a viewport picture. Click, `shift`+click, drag for an area, `↑` `↓` for the
parent or child while the note is empty, `alt+Enter` for the background conversation, paste a
picture, `Esc` to cancel. The mode is `notes` in the code.

**Reach.** `mod+P`, or "Annotate" in the top bar.

**Drive.**

```
"mode notes" "click 300,150" "type make the heading bolder" "key Enter" "wait 1500"
"state review.notes"   the note, numbered, status queued
"prompts"              the prompt text and its two images, as the agent gets them
"shot note"            the page shot has the pin and the dashed outline
```

`drag 100,100 400,300` selects an area. `key ArrowUp` moves to the parent.

**What lies.**

- Drive keys with `key` and `type`, which are real input (`sendInputEvent`). Main takes a note
  only within `ENTER_WINDOW` (1 s) of a real Enter or click in the view (`page.ts`), so a
  synthetic Enter from `page` passes right after a `click` and is dropped after a `wait 3000`.
  A pass driven by a synthetic event proves nothing about the real key.
- The prompt's words are the proof of what the agent sees. A pin on the page says the overlay
  took the note, not that the app sent it: read `prompts`.
- The card keeps the text until the host answers `captured`. A note that fails capture comes back
  to the card with a reason; `state review.notes` will not list it.

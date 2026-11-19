# Edit mode

**What.** Change the page itself: select an element (click or the tree), drag to move it among its
siblings, drag an edge to resize, drag a gap, double-click text to edit it, `Delete` to hide,
type CSS in the inspector. `Enter` or **Send** sends every edit as one note. The mode is
`edit` in `AppState` and canvas in the overlay's code.

**Reach.** `mod+O`, or "Edit" in the top bar.

**Drive.**

```
"page JSON.stringify(document.querySelector('#cta').getBoundingClientRect())"
"mode edit" "click 445,251" "shot select"   the handles, the size and the inspector
"drag 510,251 570,251"                      the right edge of #cta, 60 px wider
"key Enter" "wait 1500" "prompts"           "1 canvas edit", with before and after crops
```

**What lies.**

- The edits are applied in the page as a preview. The page shot after sending still shows them,
  until the note is done, failed or stopped, then they come off. That is not the agent's change.
- `pageEdits` in `review.ts` drops an edit it cannot read. Count the edits in `prompts` against
  what the bar said before sending.
- The inspector covers the bottom of the page; elements under it cannot be clicked there.
- Shots are at the display's scale (2x on a Retina Mac). Take coordinates from
  `getBoundingClientRect()`, never from a shot. A drag that starts a few px off the edge moves
  the element or does nothing, and Enter then sends no note.

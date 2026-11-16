# The pencil

**What.** A line drawn on the page selects what it crosses; a closed loop selects what it
encloses. It belongs to notes mode.

**Reach.** `mod+shift+P`, the pencil button, or `alt`+drag in Annotate.

**Drive.**

```
"mode notes" "cmd toggleBrush" "drag 80,300 700,300" "type pl-8 on all three" "key Enter"
"wait 1500" "prompts" "shot strokes"
```

**What lies.**

- `state review.brush` says the pencil is on; only a stroke in the page shot and the elements in
  `prompts` say it selected anything.
- The driver's `drag` moves in 12 steps. A gesture that depends on speed or on many points may
  need `move` steps of its own.

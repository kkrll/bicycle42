# Motion mode

**What.** What moves on the page: open an animation from the page or the list, move keyframes,
change the easing, play and step, then send that one animation as a note with the words typed for
it.

**Reach.** `mod+I`, or "Motion" in the top bar.

**Drive.** `overlay/harness/motion-page.html` has CSS animations, transitions, a script's
`animate()` and a frame-by-frame bar.

```
"url harness/motion-page.html" "mode motion" "wait 800" "shot list"
"click <x>,<y>"                 an animated element; the timeline opens
"key Space"                     play or pause
"type ease out slower" "key Enter" "wait 1500" "prompts"
```

**What lies.**

- A shot freezes one frame of a running animation. Compare positions with the animation paused
  (`key Space`), or read `overlay` state, not two shots of a moving thing.
- Keyframes belong to their name: an edit changes every element that plays them. The timeline's
  count says how many; a note about one element may change more.
- `pageMotion` refuses a motion note it cannot read, and the note is not sent at all. An empty
  `prompts` after Enter means that, or a missing real key press.

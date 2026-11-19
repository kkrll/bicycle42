# Settings and sounds

**What.** The server dialog (rename, servers connected before, the tunnel address, the default
model), the three sounds and their switch, reload after a note.

**Reach.** The server button in the panel's conversation row.

**Drive.** Mock shots `settings`, `settings-servers`, `settings-tunnel`, `settings-rename`,
`settings-named`. Which sound plays when is decided in `renderer/cues.ts` and tested in
`cues.test.ts`.

**What lies.** A headless run plays no sound you can hear. `cues.test.ts` is the proof of which cue
fires; the shot only proves the switch.

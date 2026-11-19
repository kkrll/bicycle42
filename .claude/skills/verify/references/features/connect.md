# Connect

**What.** The first screen: use the OpenCode server on this computer, or another by address and
password; the servers connected before; the model new conversations start with when a server
offers several.

**Reach.** First launch, or the server button in the panel.

**Drive.** The driver starts already connected to its fake server, with the model chosen. These
screens are mock shots: `connect`, `connect-error`, `connect-progress`, `model-choice`,
`model-choice-filter`, `model-choice-settings`, `offline`. The model choice end to end is in
`app/test/app.e2e.ts` (first section).

**What lies.**

- The window never holds the password. `app.e2e.ts` checks the state for it; a screen that shows
  a server must not need it.
- `local.ts` finds a server on this computer by its service file; on a machine without OpenCode
  "Use this computer" fails, which is right.

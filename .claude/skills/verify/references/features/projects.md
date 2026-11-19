# Repo and projects

**What.** The repo folder on the server, the project switcher (the **+** by the conversation's
name), "Ask the agent to start it" for a site that is not running, and the list of what the
server still runs, with Stop.

**Reach.** The panel; the count with a stop mark at the end of the URL bar.

**Drive.** Mostly mock shots: `repo`, `empty`, `folder`, `folder-browse`, `fresh`, `switcher`,
`switcher-browse`, `running`, `noconversation`. In the driver:

```
"state site"          the open site and its folder
```

The fake server in `app/test/drive.ts` has no `/api/project` or `/api/shell` routes, so
`cmd projects` fails with a 404. Add the route there when a change needs it.

**What lies.**

- `startSite` waits for a last line `SITE: <address>` from the agent. Only a test that emits that
  reply proves it.

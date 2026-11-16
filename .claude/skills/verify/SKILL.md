---
name: verify
description: Prove a change to bicycle 42 works in the real app, not only in tests. Use after changing anything a user can see or do (the window, the page view, the overlay, notes, modes, the chat), before calling a task done, and when asked to run, drive or screenshot the app.
---

# Verify

Proof is an artifact you looked at: a screenshot you opened, a state or prompt you printed. A
passing gate is not proof that the feature works; a report of what "should" happen is not proof
at all.

## 1. Pick the features

Read `references/features/README.md` and open the file of every feature the change touches. Each
says how to drive the feature and what usually lies about it. A change that adds a feature, or
changes how one is reached, updates its file in the same change.

## 2. Doctor

From the repo root:

```bash
bun run check                       # the fast gates are green
node app/scripts/drive.mjs help     # builds the app with the tests and prints the steps
```

When `help` fails, the build is broken: fix that first. `bun install` in `app/` needs Bun 1.4 or
newer.

## 3. Drive

`node app/scripts/drive.mjs [--site <url>] [--out <dir>] "<step>" ...` launches the built app
against a fake OpenCode server, opens `overlay/harness/page.html` (or `--site`), and runs the
steps in order. Add `--no-build` after the first run of a session when only steps changed.

```bash
node app/scripts/drive.mjs --out /tmp/b42 \
  "mode notes" "click 300,150" "type make the heading bolder" "key Enter" "wait 1500" \
  "state review.notes" "prompts" "shot note" "log"
```

- Coordinates are page CSS px inside the page view. Find them with
  `page JSON.stringify(document.querySelector('h1').getBoundingClientRect())`.
- `shot` writes two files: `<name>-window.png` (the app window) and `<name>-page.png` (the page
  view). Open both with Read.
- A step that fails stops the run with exit 1 and says why.

## 4. Prove

For each feature touched, write down the evidence: the step list you ran, what `state`, `prompts`
or `overlay` printed, and the shots you opened, with one line on what each shows. Then:

- The window's look in every state: `bun run visual`. A shot that differs on purpose gets new
  baselines (`node scripts/visual.mjs --update`), and the report names which shots changed.
- A behaviour worth keeping proven goes into a test (`.agents/guides/testing.md`), not only into
  this report.

The step is done when every feature touched has evidence you read, and `log` printed no new
errors or warnings beyond the known ones in its feature file.

## 5. Clean up

The driver removes its profile and stops its servers. Delete the `--out` folder when the shots are
not needed for the report.

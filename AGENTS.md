# bicycle 42

A desktop app (Electron, Solid) for reviewing a web page with a coding agent. Two packages, each
with its own install: `app/` and `overlay/`. Their READMEs say how each is built; read the one you
are about to change.

Bun 1.4 or newer: `app/` and `overlay/` have version 2 lockfiles, which older Bun skips with a
warning and then installs other versions. After `bun install` at the root, `bunx lefthook install` sets
up the git hooks.

## Gates

`bun run check` at the root runs every fast gate in parallel, in about 15 s:

- format (oxfmt)
- lint (oxlint) and dead code (knip), both against `.baseline/`
- process boundaries (dependency-cruiser, `.dependency-cruiser.cjs`)
- repo hygiene
- the window's styles against the design system (`check:design`)
- typecheck of both packages
- the app's unit tests

`--changed` runs only what this branch touches. `--full` adds the overlay's browser tests and the
app's e2e. `bun run visual` compares the window's shots with `app/test/visual/<platform>/`.

A check that fails names the guide line behind it. A baseline count only goes down: fix the new
finding, and run `bun run baseline` when you fixed old ones. `bun run format` fixes formatting.

## Workflow

1. Implement. Each phase of a plan ends with its tests.
2. `bun run check`. The Stop hook runs it too, and blocks until it passes.
3. `/verify` drives the real app and proves the change on screen.
4. `/review-branch` before a PR. `/pull-request` writes the PR.
5. `/garden` after a phase: review findings become checks, and baselines shrink.

## Where rules live

- A rule that can be a check is a check: lint, dependency rules, types, a test. Its message points
  at a guide.
- `.agents/guides/<area>.md` holds what a check cannot: `main-process`, `renderer`, `overlay`,
  `protocol`, `testing`. Load the guide for the area you touch.
- `.claude/skills/verify/references/features/` holds how to drive and prove each feature.
- Plans, PRDs, handoffs and review reports stay out of the repo (`scripts/hygiene.mjs`).

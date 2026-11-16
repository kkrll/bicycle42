---
name: garden
description: Prune the codebase after a phase or a few PRs. Turns repeated review findings into checks, then guide lines, deletes prose a check made redundant, and pays down one baseline.
disable-model-invocation: true
argument-hint: "[--since <date or ref>]"
---

# Garden

The codebase is what the next agent copies. A finding that came up twice is a rule nobody
enforces yet: give it the strongest home it fits, in this order.

1. A **type** or a **structure** that makes the wrong thing impossible.
2. A **check** that fails: an oxlint rule (`.oxlintrc.json`), a dependency rule
   (`.dependency-cruiser.cjs`), a test, a line in `scripts/hygiene.mjs`.
3. A **canonical helper** that the right way goes through.
4. One **guide line** in `.agents/guides/`, when no check can say it.

## 1. Gather

Since the last garden (its commit says `garden:`) or `--since`:

- The **Standards gaps** and **Questions** of every report in `.agents/reports/`.
- The PR review comments: `gh pr list --state merged --search "merged:>=<date>"`, then
  `gh api repos/{owner}/{repo}/pulls/<n>/comments` for each.
- The corrections the user made in sessions, where they are in the reports.

Group the findings by what they are about. A group with one finding waits for a second.

## 2. Promote

For each group with two or more findings, pick the strongest rung above that fits, and write it:

- A check lands only when it passes today. Fix what it finds, or, with `bun run check` green
  before the new rule, add its findings to the baseline with
  `node scripts/ratchet.mjs <oxlint|knip> --reset`. A reset is the one time a count may go up:
  say so in the commit.
- The check's message names its guide, and the guide line names the check. Delete any guide
  prose that the check now holds.

## 3. Pay down

Pick one entry of `.baseline/oxlint.json` or `.baseline/knip.json`: a rule in one file, or one
file's unused exports. Fix it, run `bun run baseline`, and see the count go down. Then `bun run check`.

Also look at the items the plan left for gardening: `exactOptionalPropertyTypes` in `app/`
(32 errors), `strict` in `overlay/` (about 1300), the overlay's import cycles. Take one step on
one of them when the run has room.

## 4. Commit

One commit per promotion, `garden: <the rule, as a sentence>`, and one for the pay-down. Report
what moved to which rung, what waits for a second finding, and the baseline counts before and
after.

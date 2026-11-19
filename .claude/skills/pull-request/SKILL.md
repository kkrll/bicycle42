---
name: pull-request
description: Open a PR for the current branch: fold fixups, write the description from the branch and its review report, push and create it.
disable-model-invocation: true
argument-hint: "[--draft]"
---

# Open the pull request

## 1. Ready

- `bun run check --full` passes.
- `/review-branch` ran on this branch and its report in `.agents/reports/` has no open critical
  or high security finding. Without a report, ask whether to run it first.

## 2. Fold the fixups

If the branch has never been pushed (`git rev-parse --abbrev-ref @{upstream}` fails), fold them:
`git rebase -i --autosquash` is interactive, so use
`GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>`. A branch that is already pushed keeps
its history: add plain commits instead.

## 3. Write the description

Read `git log <base>..HEAD` and the review report. Write:

- **Intent**: the problem, in two or three sentences, and the spec it implements.
- **What landed**: the changes a reviewer should know about, grouped by area.
- **How to review**: where to start reading, and what to run (`/verify` steps, `bun run visual`).
- **Test plan**: the gates, the tests added, the evidence from `/verify`, with shots attached if
  the window changed.
- **Merge risk**: from the report. Say "none known" only if the report says so.

Run the `unslop` skill over it. End it with the attribution lines the harness gives.

## 4. Push and open

Confirm with the user before pushing: the repo is public. Then
`git push -u origin <branch>` and `gh pr create --base main --title "<area>: <what>" --body-file <file>`,
with `--draft` if asked. Print the PR's URL.

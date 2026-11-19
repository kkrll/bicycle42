---
name: review-branch
description: Review the current branch before a PR. Runs the gates, then three reviewers in fresh contexts (spec, standards, security), applies the sure fixes as fixup commits and saves the report.
disable-model-invocation: true
argument-hint: "[spec path, e.g. a PRD or plan phase] [--base <ref>]"
---

# Review the branch

## 1. Scope

- Base: `--base` if given, else `git merge-base HEAD origin/main`.
- Spec: the path given. Without one, ask which document or issue the branch implements; a branch
  with no spec skips `reviewer-spec`, and the report says so.
- The tree is clean (`git status --short`). Commit or stash work in progress first.

## 2. Gates

`bun run check --full`, or `node scripts/check.mjs --changed --full` for speed. When a gate fails,
stop and fix it; reviewers do not review red branches.

## 3. Reviewers

Start the three subagents in one message, so they run in parallel:

- `reviewer-spec`: the base ref and the spec's path.
- `reviewer-standards`: the base ref.
- `reviewer-security`: the base ref.

Give each only the base ref, the spec path and the branch name. Leave out your own summary of the
change: a reviewer who reads your account of the diff reviews your account.

## 4. Fix what is sure

For each **sure** finding from `reviewer-standards`, make the fix and commit it as
`git commit --fixup=<sha of the commit that introduced it>`. Run `bun run check` after the last
one. Everything else stays a finding: questions, spec gaps, security, anything that changes
behaviour, a test, the UX or a guide.

## 5. Report

Write `.agents/reports/<branch>-<YYYY-MM-DD>.md` (gitignored) with these sections:

- **Fixed**: each fixup commit, one line.
- **Security**: every finding, with its rating and path. Critical and high block the PR until the
  user decides.
- **Questions**: what needs the user's call, each with the reviewer's evidence.
- **Spec**: missing, wrong, unasked, stale.
- **Merge risk**: what could break for someone running main after this lands.
- **Standards gaps**: copied from `reviewer-standards`, for `/garden`.

Show the user the Security, Questions and Merge risk sections and the report's path.

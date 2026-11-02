# Agent Instructions

## Review guidelines

Respect documented author intent and check for companion PRs.

- Read the PR body before the diff. If it has sections like "Design
  decisions", "Companion PRs", "Cross-repo", or "Intent", treat them as
  the author's binding statement of design — constraints, not code to
  second-guess. Do not raise a finding that would contradict a documented
  choice.
- Assume work often spans multiple repos in this org. "Missing caller",
  "dead code", and "unused export" findings are often wrong because the
  caller lives in a companion PR. Before flagging dead or missing code,
  check whether the PR description references companion PRs in other
  repos.
- When author intent is unclear, ask a question rather than request a
  change.

## Branch lanes

Three trunks during the 2.0 beta period (from the 2.0 promotion in November 2026 until 2.0 GA):

- **`1.11.x`** — the stable patch line; this branch. A fix for a merchant on 1.11 branches from `origin/1.11.x` and targets `1.11.x`; a patch release (`1.11.N`) is cut from its tip. It has no dev site (Paul, 2026-11-01: *"1.11.x does not get a dev site"*): a patch is verified by its Test workflow plus a local run of the app from the branch. Nothing flows from `1.11.x` into `main`; a fix that 2.0 also needs is re-applied to `main` in its own PR.
- **`main`** — 2.0 (beta, then GA). dev-free and dev-pro run it.
- **`next`** — frozen until 2.0 GA; nothing targets it.

A 1.11 desktop release is `tag-and-release.yml` dispatched with `--ref 1.11.x`; `.monorepo-ref` on this branch pins the 1.11 app tag the renderer is built from, and `monorepo-drift.yml` checks it on every push here.

Never commit directly to a trunk — branch off the right one in a worktree and target the PR's base at the same lane. When the lane is not explicit, ask "1.11.x or main?" rather than defaulting.

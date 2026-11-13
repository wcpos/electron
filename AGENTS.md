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

Two live trunks during the 2.0 beta period (from the 2.0 promotion of 2026-11-02 until 2.0 GA), and one deleted until GA:

- **`main`** — WCPOS Desktop 2.0, this branch: `2.0.2` now. `.monorepo-ref` pins the monorepo ref the renderer is built from: since beta 1 it is the app tag of the current beta (`v2.0.0-beta.3`), re-pinned by each beta's stamp PR, so the release notes mirror the app release; `monorepo-drift.yml` checks it. A push here builds Linux only and publishes nothing; releases come from `tag-and-release.yml` dispatched by hand.
- **`1.11.x`** — the stable patch line for merchants still on 1.11. A 1.11 fix branches from `origin/1.11.x` and targets `1.11.x`; a 1.11 desktop release is `tag-and-release.yml --ref 1.11.x`. A fix 2.0 also needs is re-applied to `main` through a PR of its own.
- **`next`** — deleted on 2026-11-03 (Paul: *"you can delete next branches as you recommend"*); its rulesets stay. At GA it is re-cut from `main`.

Never commit directly to a trunk — branch off the right one in a worktree and target the PR's base at the same lane. When the lane is not explicit, ask "main or 1.11.x?" rather than defaulting.


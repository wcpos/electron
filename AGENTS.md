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

This repo has two permanent trunks:
- **`main`** — the **stable**, released line (1.9.x patches ship from here).
- **`next`** — the **in-development** major/minor (1.10, then 1.11, 2.0 …).

Feature work usually targets `next`; patches to the shipped release target `main`. Never commit directly to either trunk — branch off the correct one in a worktree, and target the PR's base at the same lane. **If it isn't clear which lane a task belongs to, ask "main or next?" before branching, pulling (`git pull origin <lane>`), or opening a PR — don't default to `main`.**

#!/usr/bin/env node
// Starts the renderer (@wcpos/main) dev server from the parent monorepo.
//
// This repo is a nested pnpm workspace (pnpm-workspace.yaml lists "." and
// packages/*) so that a standalone checkout can install and test on its own.
// The renderer lives in the monorepo, so `pnpm --filter @wcpos/main` run from
// here matches nothing. Walk up to the monorepo root instead of assuming the
// checkout sits at exactly <monorepo>/apps/electron (git worktrees don't).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function findMonorepoRoot(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (
      existsSync(join(dir, "pnpm-workspace.yaml")) &&
      existsSync(join(dir, "apps", "main", "package.json"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function rendererDevArgs(root, port) {
  return [
    "-C",
    root,
    "--filter",
    "@wcpos/main",
    "dev",
    "--web",
    "--port",
    port,
    "--clear",
  ];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = findMonorepoRoot(process.cwd());
  if (!root) {
    console.error(
      "dev:expo: no monorepo checkout found above this directory (expected an ancestor with pnpm-workspace.yaml and apps/main). " +
        "Develop from the WCPOS monorepo with this repo checked out at apps/electron — see README.",
    );
    process.exit(1);
  }
  const result = spawnSync(
    "pnpm",
    rendererDevArgs(root, process.env.EXPO_PORT ?? "8088"),
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ELECTRON: "true",
        EXPO_NO_METRO_LAZY: "true",
        BROWSER: "none",
      },
    },
  );
  process.exit(result.status ?? 1);
}

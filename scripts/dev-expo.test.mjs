import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findMonorepoRoot, rendererDevArgs } from "./dev-expo.mjs";

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "wcpos-dev-expo-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  mkdirSync(join(root, "apps", "main"), { recursive: true });
  writeFileSync(
    join(root, "apps", "main", "package.json"),
    '{"name":"@wcpos/main"}',
  );
  // The electron checkout is itself a nested workspace root.
  mkdirSync(join(root, "apps", "electron", "packages"), { recursive: true });
  writeFileSync(
    join(root, "apps", "electron", "pnpm-workspace.yaml"),
    'packages:\n  - "."\n',
  );
  return root;
}

test("finds the monorepo root above the nested electron workspace", () => {
  const root = makeTree();
  try {
    assert.equal(findMonorepoRoot(join(root, "apps", "electron")), root);
    assert.equal(
      findMonorepoRoot(join(root, "apps", "electron", "packages")),
      root,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns null outside a monorepo (standalone clone or worktree)", () => {
  const lone = mkdtempSync(join(tmpdir(), "wcpos-dev-expo-lone-"));
  try {
    writeFileSync(join(lone, "pnpm-workspace.yaml"), 'packages:\n  - "."\n');
    assert.equal(findMonorepoRoot(lone), null);
  } finally {
    rmSync(lone, { recursive: true, force: true });
  }
});

test("targets the renderer through the monorepo root", () => {
  assert.deepEqual(rendererDevArgs("/mono", "8088"), [
    "-C",
    "/mono",
    "--filter",
    "@wcpos/main",
    "dev",
    "--web",
    "--port",
    "8088",
    "--clear",
  ]);
});

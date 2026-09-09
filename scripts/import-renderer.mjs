#!/usr/bin/env node
// Replace dist/ with a copy of a `build:electron` export from the monorepo
// (apps/main/electron-build). The copy is staged beside dist/ and swapped in
// with a rename, so a bad path or a failed copy never leaves dist/ half-written.
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
  console.error("Usage: node scripts/import-renderer.mjs <path-to-export-dir>");
  process.exit(1);
}
const exportDir = resolve(source);
if (!existsSync(join(exportDir, "index.html"))) {
  console.error("renderer:import: export directory must contain index.html");
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const destination = join(repoRoot, "dist");
if (exportDir === destination || exportDir.startsWith(destination + sep)) {
  console.error(
    "renderer:import: export directory must not be dist/ or inside it",
  );
  process.exit(1);
}

const staging = mkdtempSync(join(repoRoot, "dist.import-"));
try {
  cpSync(exportDir, staging, { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  renameSync(staging, destination);
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  console.error(`renderer:import: ${error.message}`);
  process.exit(1);
}

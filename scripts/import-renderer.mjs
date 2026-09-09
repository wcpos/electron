#!/usr/bin/env node
import { cpSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
  console.error("Usage: node scripts/import-renderer.mjs <path-to-export-dir>");
  process.exit(1);
}
if (!existsSync(join(source, "index.html"))) {
  console.error("renderer:import: export directory must contain index.html");
  process.exit(1);
}

const destination = fileURLToPath(new URL("../dist/", import.meta.url));
try {
  rmSync(destination, { recursive: true, force: true });
  cpSync(resolve(source), destination, { recursive: true });
} catch (error) {
  console.error(`renderer:import: ${error.message}`);
  process.exit(1);
}

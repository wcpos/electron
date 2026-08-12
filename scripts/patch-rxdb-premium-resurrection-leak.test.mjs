import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourcePatcher = fileURLToPath(
  new URL("./patch-rxdb-premium-resurrection-leak.mjs", import.meta.url),
);

test("fails before patching CJS when its documents helper anchor is missing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wcpos-resurrection-patch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const patcher = join(root, "patch-rxdb-premium-resurrection-leak.mjs");
  copyFileSync(sourcePatcher, patcher);

  const packageRoot = join(root, "node_modules/rxdb-premium");
  const esm = join(
    packageRoot,
    "dist/esm/plugins/storage-abstract-filesystem/bulk-write.js",
  );
  const cjs = join(
    packageRoot,
    "dist/cjs/plugins/storage-abstract-filesystem/bulk-write.js",
  );
  mkdirSync(dirname(esm), { recursive: true });
  mkdirSync(dirname(cjs), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "rxdb-premium",
      version: "0.0.0-test",
      exports: { "./package.json": "./package.json" },
    }),
  );
  writeFileSync(
    esm,
    'import{writeDocumentRows as r}from"./documents-file.js";' +
      "for(var p=[],k=0;k<l.indexStates.length;k++){l.indexStates[k].appendWriteOperations(u,f.documentPositions,p)}",
  );
  const cjsBefore =
    "for(var f=[],I=0;I<c.indexStates.length;I++){c.indexStates[I].appendWriteOperations(g,p.documentPositions,f)}";
  writeFileSync(cjs, cjsBefore);

  const result = spawnSync(process.execPath, [patcher], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /anchor missing .* import site/);
  assert.equal(readFileSync(cjs, "utf8"), cjsBefore);
});

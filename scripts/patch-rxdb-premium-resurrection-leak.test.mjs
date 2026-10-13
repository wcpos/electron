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
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const sourcePatcher = fileURLToPath(
  new URL("./patch-rxdb-premium-resurrection-leak.mjs", import.meta.url),
);

function fixture(t) {
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
    'import{writeDocumentRows as i}from"./documents-file.js";' +
      "for(var p=[],k=0;k<l.indexStates.length;k++){l.indexStates[k].appendWriteOperations(u,f.documentPositions,p)}",
  );
  const cjsBefore =
    'a=require("./documents-file.js");' +
    "for(var f=[],k=0;k<c.indexStates.length;k++){c.indexStates[k].appendWriteOperations(g,p.documentPositions,f)}";
  writeFileSync(cjs, cjsBefore);

  return {
    esm,
    cjs,
    run: () => spawnSync(process.execPath, [patcher], { encoding: "utf8" }),
  };
}

test("fails before patching CJS when its documents helper anchor is missing", (t) => {
  const { esm, cjs, run } = fixture(t);
  const esmBefore = readFileSync(esm, "utf8");
  const cjsBefore = readFileSync(cjs, "utf8").replace(
    'a=require("./documents-file.js");',
    "",
  );
  writeFileSync(cjs, cjsBefore);
  const result = run();
  assert.equal(readFileSync(esm, "utf8"), esmBefore);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /anchor missing .* import site/);
  assert.equal(readFileSync(cjs, "utf8"), cjsBefore);
});

test("17.6 anchors patch both dists and a second run is byte-identical", (t) => {
  const { esm, cjs, run } = fixture(t);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const patched = [esm, cjs].map((path) => readFileSync(path, "utf8"));
  assert.ok(
    patched.every((source) =>
      source.includes("appendWriteOperations(__wcposIdxEvents,"),
    ),
  );
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /esm: already patched, cjs: already patched/);
  assert.deepEqual(
    [esm, cjs].map((path) => readFileSync(path, "utf8")),
    patched,
  );
});

for (const dist of ["esm", "cjs"]) {
  for (const mutation of [
    "duplicate import",
    "duplicate loop",
    "missing rewrite",
    "outdated shim",
  ]) {
    test(`[${dist}] refuses ${mutation} without writing either dist`, (t) => {
      const { esm, cjs, run } = fixture(t);
      const path = dist === "esm" ? esm : cjs;
      if (mutation === "missing rewrite" || mutation === "outdated shim") {
        const applied = run();
        assert.equal(applied.status, 0, applied.stderr);
      }
      let source = readFileSync(path, "utf8");
      if (mutation === "duplicate import")
        source += source.slice(0, source.indexOf(";") + 1);
      if (mutation === "duplicate loop")
        source += source.slice(source.indexOf("for(var "));
      if (mutation === "missing rewrite")
        source = source.replace(
          "appendWriteOperations(__wcposIdxEvents,",
          "appendWriteOperations(unpatched,",
        );
      if (mutation === "outdated shim")
        source = source.replace(
          "Object.assign({},__wcposEv,",
          "Object.assign(__wcposEv,",
        );
      writeFileSync(path, source);
      const before = [esm, cjs].map((file) => readFileSync(file, "utf8"));
      const result = run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /matched 2 times|incomplete|outdated/);
      assert.deepEqual(
        [esm, cjs].map((file) => readFileSync(file, "utf8")),
        before,
      );
    });
  }
}

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("rxdb-premium/package.json"));
for (const dist of ["esm", "cjs"]) {
  test(`[${dist}] real storage keeps one index row through delete/reinsert cycles`, async (t) => {
    const { createRxDatabase } =
      dist === "esm" ? await import("rxdb") : require("rxdb");
    const { getRxStorageFilesystemNode } = await import(
      pathToFileURL(
        join(
          packageRoot,
          `dist/${dist}/plugins/storage-filesystem-node/index.js`,
        ),
      ).href
    );
    const basePath = mkdtempSync(join(tmpdir(), "wcpos-resurrection-runtime-"));
    const db = await createRxDatabase({
      name: join(basePath, "database"),
      storage: getRxStorageFilesystemNode({ basePath }),
      multiInstance: false,
    });
    t.after(async () => {
      await db.close();
      rmSync(basePath, { recursive: true, force: true });
    });
    const { items } = await db.addCollections({
      items: {
        schema: {
          version: 0,
          primaryKey: "id",
          type: "object",
          properties: {
            id: { type: "string", maxLength: 32 },
            value: { type: "string", maxLength: 32 },
          },
          required: ["id", "value"],
          indexes: ["value"],
        },
      },
    });
    let instance = items.storageInstance;
    while (!instance.internals?.statePromise)
      instance = instance.originalStorageInstance;
    const state = await instance.internals.statePromise;
    const events = [];
    const sub = instance
      .changeStream()
      .subscribe((bulk) => events.push(...bulk.events));
    t.after(() => sub.unsubscribe());
    let doc = await items.insert({ id: "one", value: "first" });
    for (let cycle = 0; cycle < 3; cycle++) {
      await doc.remove();
      doc = await items.insert({ id: "one", value: `cycle${cycle}` });
      await instance.internals.taskQueue.awaitIdle();
      for (const index of state.indexStates) {
        assert.equal(index.rows.length, 1, `cycle ${cycle}: ${index.name}`);
      }
    }
    assert.equal((await items.find().exec()).length, 1);
    assert.equal((await items.findOne("one").exec()).value, "cycle2");
    const inserts = events.filter((event) => event.operation === "INSERT");
    assert.equal(inserts.length, 4);
    assert.ok(
      inserts.every((event) => !event.previousDocumentData),
      "backfill stays out of change events",
    );
  });
}

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeMangoQuery, prepareQuery } from "rxdb";
import { getRxStorageFilesystemNode } from "rxdb-premium/plugins/storage-filesystem-node";

const schema = {
  title: "targeted recovery probe",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 100 },
    value: { type: "string" },
    _deleted: { type: "boolean" },
    _rev: { type: "string", minLength: 1 },
    _meta: {
      type: "object",
      properties: {
        lwt: {
          type: "number",
          minimum: 1,
          maximum: 1_000_000_000_000_000,
          multipleOf: 0.01,
        },
      },
      required: ["lwt"],
      additionalProperties: false,
    },
    _attachments: { type: "object" },
  },
  required: ["id", "value", "_deleted", "_rev", "_meta", "_attachments"],
  indexes: [["_deleted", "id"]],
};

function storageParams(token) {
  return {
    databaseName: "targeted-recovery-db",
    collectionName: "products",
    schema,
    options: {},
    multiInstance: false,
    devMode: false,
    databaseInstanceToken: token,
  };
}

function document(id, sequence) {
  return {
    id,
    value: `value-${id}`,
    _deleted: false,
    _rev: `1-recovery${sequence}`,
    _meta: { lwt: Date.now() + sequence },
    _attachments: {},
  };
}

async function corruptRecord(basePath, id, makeCorruptBytes) {
  const directory = join(basePath, (await readdir(basePath))[0]);
  const indexPaths = (await readdir(directory))
    .filter((name) => name.startsWith("index-"))
    .map((name) => join(directory, name));
  const parsedIndexes = await Promise.all(
    indexPaths.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  const targetRow = parsedIndexes.flat().find((row) => row[0].includes(id));
  assert.ok(targetRow, `missing index row for ${id}`);
  const originalStart = targetRow[1];
  const originalEnd = targetRow[2];

  const documentsPath = join(directory, "documents.json");
  const documents = await readFile(documentsPath);
  const cleanRecord = documents.subarray(originalStart, originalEnd);
  const corruptRecordBytes = makeCorruptBytes
    ? makeCorruptBytes(cleanRecord)
    : Buffer.concat([cleanRecord, Buffer.from(`garbage-${id}`)]);
  const corruptStart = documents.length;
  const corruptEnd = corruptStart + corruptRecordBytes.length;
  await writeFile(
    documentsPath,
    Buffer.concat([documents, corruptRecordBytes]),
  );

  for (let index = 0; index < indexPaths.length; index += 1) {
    for (const row of parsedIndexes[index]) {
      if (row[1] === originalStart && row[2] === originalEnd) {
        row[1] = corruptStart;
        row[2] = corruptEnd;
      }
    }
    await writeFile(indexPaths[index], JSON.stringify(parsedIndexes[index]));
  }
}

async function corruptRecordInPlace(basePath, id, makeCorruptBytes) {
  const directory = join(basePath, (await readdir(basePath))[0]);
  const indexPath = join(
    directory,
    (await readdir(directory)).find((name) => name.startsWith("index-")),
  );
  const targetRow = JSON.parse(await readFile(indexPath, "utf8")).find((row) =>
    row[0].includes(id),
  );
  assert.ok(targetRow, `missing index row for ${id}`);

  const documentsPath = join(directory, "documents.json");
  const documents = await readFile(documentsPath);
  const original = documents.subarray(targetRow[1], targetRow[2]);
  const corrupt = makeCorruptBytes(original);
  assert.ok(corrupt.length <= original.length);
  const replacement = Buffer.alloc(original.length, 32);
  corrupt.copy(replacement);
  await writeFile(
    documentsPath,
    Buffer.concat([
      documents.subarray(0, targetRow[1]),
      replacement,
      documents.subarray(targetRow[2]),
    ]),
  );
}

test("exports a targeted OPFS recovery storage wrapper", async () => {
  const recoveryModule = await import("./opfs-targeted-recovery.mjs").catch(
    () => ({}),
  );

  assert.equal(typeof recoveryModule.withTargetedOpfsRecovery, "function");
});

test("derives an invalid count result and passes through a valid result", async () => {
  const records = [document("cache:orders", 0), document("cache:products", 1)];
  const validResult = { count: 7, mode: "fast" };
  const countResults = [undefined, validResult];
  const errors = [];
  let queriedPreparedQuery;
  const instance = {
    primaryPath: "id",
    findDocumentsById: async () => "[]",
    bulkWrite: async () => ({ error: [] }),
    query: async (preparedQuery) => {
      queriedPreparedQuery = preparedQuery;
      return JSON.stringify({ documents: records });
    },
    count: async () => countResults.shift(),
    getChangedDocumentsSince: async () => JSON.stringify({ documents: [] }),
  };
  const { withTargetedOpfsRecovery } =
    await import("./opfs-targeted-recovery.mjs");
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance(storageParams("count-result"));
  const preparedQuery = { query: { selector: { value: "probe" } } };
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args);
  let derivedResult;
  try {
    derivedResult = await recovering.count(preparedQuery);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(derivedResult, {
    count: records.length,
    mode: "fast",
  });
  assert.strictEqual(queriedPreparedQuery, preparedQuery);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "[count-recovery] targeted-recovery-db/products");
  assert.deepEqual(errors[0][1], {
    detail: "typeof=undefined result=undefined",
  });
  assert.strictEqual(await recovering.count(preparedQuery), validResult);
});

test("falls back to singleton reads when only a combined response is malformed", async () => {
  const records = [document("cache:orders", 0), document("cache:products", 1)];
  const instance = {
    primaryPath: "id",
    findDocumentsById: async (ids) =>
      ids.length > 1
        ? "[{malformed"
        : JSON.stringify(records.filter(({ id }) => ids.includes(id))),
    bulkWrite: async () => ({ error: [] }),
    query: async () => JSON.stringify({ documents: records }),
    count: async () => ({ count: records.length, mode: "fast" }),
    getChangedDocumentsSince: async () =>
      JSON.stringify({ documents: records }),
  };
  const { withTargetedOpfsRecovery } =
    await import("./opfs-targeted-recovery.mjs");
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance(storageParams("combined-read"));

  assert.deepEqual(
    JSON.parse(
      await recovering.findDocumentsById(
        records.map(({ id }) => id),
        false,
      ),
    ),
    records,
  );
});

test("falls back to singleton writes when a combined write is malformed", async () => {
  const records = [
    document("cache:orders", 0),
    { ...document("cache:orders", 1), _rev: "2-recovery1" },
    document("cache:products", 2),
  ];
  const written = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  let combinedWriteAttempted = false;
  let idleAwaited = false;
  const instance = {
    primaryPath: "id",
    taskQueue: {
      awaitIdle: async () => {
        idleAwaited = true;
      },
    },
    findDocumentsById: async (ids) => (ids.length > 1 ? "[{malformed" : "[]"),
    bulkWrite: async (rows) => {
      if (rows.length > 1) {
        combinedWriteAttempted = true;
        throw new SyntaxError("malformed combined write");
      }
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setImmediate(resolve));
      written.push(rows[0].document._rev);
      activeWrites -= 1;
      return { error: [] };
    },
    query: async () => JSON.stringify({ documents: [] }),
    count: async () => ({ count: 0, mode: "fast" }),
    getChangedDocumentsSince: async () => JSON.stringify({ documents: [] }),
  };
  const { withTargetedOpfsRecovery } =
    await import("./opfs-targeted-recovery.mjs");
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance(storageParams("combined-write"));

  const result = await recovering.bulkWrite(
    records.map((item) => ({ document: item })),
    "test",
  );

  assert.deepEqual(result, { error: [] });
  assert.equal(combinedWriteAttempted, false);
  assert.equal(idleAwaited, true);
  assert.equal(maxActiveWrites, 1);
  assert.deepEqual(
    written,
    records.map(({ _rev }) => _rev),
  );
});

test("refuses malformed-document read and write repair when multi-instance", async () => {
  let writeAttempted = false;
  const instance = {
    primaryPath: "id",
    findDocumentsById: async () => "[{malformed",
    bulkWrite: async () => {
      writeAttempted = true;
      return { error: [] };
    },
    query: async () => JSON.stringify({ documents: [] }),
    getChangedDocumentsSince: async () => JSON.stringify({ documents: [] }),
  };
  const { withTargetedOpfsRecovery } =
    await import("./opfs-targeted-recovery.mjs");
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance({
    ...storageParams("multi-instance-document-repair"),
    multiInstance: true,
  });
  const expectedRefusal = {
    name: "SyntaxError",
    message: /targeted recovery refused: multi-instance$/,
  };

  await assert.rejects(
    recovering.findDocumentsById(["cache:orders"], false),
    expectedRefusal,
  );
  await assert.rejects(
    recovering.bulkWrite([{ document: document("cache:orders", 0) }], "test"),
    expectedRefusal,
  );
  assert.equal(writeAttempted, false);
});

test("skips the write preflight for ids already verified clean", async () => {
  const records = [document("cache:orders", 0), document("cache:products", 1)];
  let probeCalls = 0;
  const instance = {
    primaryPath: "id",
    findDocumentsById: async () => {
      probeCalls += 1;
      return "[]";
    },
    bulkWrite: async () => ({ error: [] }),
    query: async () => JSON.stringify({ documents: [] }),
    getChangedDocumentsSince: async () => JSON.stringify({ documents: [] }),
  };
  const { withTargetedOpfsRecovery } =
    await import("./opfs-targeted-recovery.mjs");
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance(storageParams("clean-cache"));
  const rows = records.map((item) => ({ document: item }));

  await recovering.bulkWrite(rows, "first");
  assert.equal(probeCalls, 1);
  await recovering.bulkWrite(rows, "second");
  assert.equal(probeCalls, 1);

  // A withDeleted read proves the requested ids parsed or are absent; a
  // withDeleted=false read cannot (tombstones are filtered unparsed).
  await recovering.findDocumentsById(["cache:customers"], true);
  assert.equal(probeCalls, 2);
  await recovering.bulkWrite(
    [{ document: document("cache:customers", 2) }],
    "after-read",
  );
  assert.equal(probeCalls, 2);
});

test("re-probes writes after observing malformed data", async () => {
  const record = document("cache:orders", 0);
  let probeCalls = 0;
  let malformedOnce = true;
  const instance = {
    primaryPath: "id",
    findDocumentsById: async (ids) => {
      probeCalls += 1;
      if (ids.length > 1 && malformedOnce) {
        malformedOnce = false;
        return "[{malformed";
      }
      return "[]";
    },
    bulkWrite: async () => ({ error: [] }),
    query: async () => JSON.stringify({ documents: [] }),
    getChangedDocumentsSince: async () => JSON.stringify({ documents: [] }),
  };
  const { withTargetedOpfsRecovery } =
    await import("./opfs-targeted-recovery.mjs");
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance(storageParams("cache-invalidate"));

  await recovering.bulkWrite([{ document: record }], "first");
  const cleanProbes = probeCalls;
  await recovering.findDocumentsById(["cache:orders", "cache:products"], false);

  const beforeReprobe = probeCalls;
  await recovering.bulkWrite([{ document: record }], "after-malformed");
  assert.ok(probeCalls > beforeReprobe, "write after malformed must re-probe");
  assert.ok(cleanProbes > 0);
});

test("re-probes cached ids after repair failure", async () => {
  const record = document("cache:orders", 0);
  let malformed = false;
  let probeCalls = 0;
  const instance = {
    primaryPath: "id",
    internals: { statePromise: Promise.resolve({}) },
    taskQueue: {
      runCleanup: async () => {
        throw new Error("repair failed");
      },
    },
    findDocumentsById: async () => {
      probeCalls += 1;
      return malformed ? "[{malformed" : "[]";
    },
    bulkWrite: async () => ({ error: [] }),
    query: async () => JSON.stringify({ documents: [] }),
    getChangedDocumentsSince: async () => JSON.stringify({ documents: [] }),
  };
  const { withTargetedOpfsRecovery } =
    await import("./opfs-targeted-recovery.mjs");
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance(storageParams("repair-failure-cache"));

  await recovering.bulkWrite([{ document: record }], "prime-cache");
  malformed = true;
  await assert.rejects(
    recovering.bulkWrite(
      [{ document: record }, { document: document("cache:new", 1) }],
      "repair-failure",
    ),
    /repair failed/,
  );
  malformed = false;
  const beforeRetry = probeCalls;

  await recovering.bulkWrite([{ document: record }], "retry");

  assert.ok(probeCalls > beforeRetry, "retry after repair failure must probe");
});

test("does not treat tombstones filtered from a read as verified clean", async () => {
  const live = document("cache:orders", 0);
  let probeCalls = 0;
  const instance = {
    primaryPath: "id",
    findDocumentsById: async (ids, withDeleted) => {
      if (withDeleted) probeCalls += 1;
      // Without withDeleted the storage filters tombstoned rows by index key
      // and never parses their bytes — only the live document comes back.
      return JSON.stringify(ids.includes(live.id) ? [live] : []);
    },
    bulkWrite: async () => ({ error: [] }),
    query: async () => JSON.stringify({ documents: [] }),
    getChangedDocumentsSince: async () => JSON.stringify({ documents: [] }),
  };
  const { withTargetedOpfsRecovery } =
    await import("./opfs-targeted-recovery.mjs");
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance(storageParams("tombstone-cache"));

  await recovering.findDocumentsById(["cache:orders", "cache:deleted"], false);
  await recovering.bulkWrite([{ document: live }], "returned-doc");
  assert.equal(probeCalls, 0, "a returned document is proven clean");

  await recovering.bulkWrite(
    [{ document: document("cache:deleted", 1) }],
    "filtered-tombstone",
  );
  assert.equal(probeCalls, 1, "a filtered tombstone id must still preflight");

  await recovering.findDocumentsById(["cache:gone"], true);
  await recovering.bulkWrite(
    [{ document: document("cache:gone", 2) }],
    "with-deleted",
  );
  assert.equal(probeCalls, 2, "a withDeleted read proves absent ids clean");
});

test("re-probes after the raw write itself reports malformed bytes", async () => {
  const record = document("cache:orders", 0);
  let probeCalls = 0;
  let failNextWrite = false;
  const instance = {
    primaryPath: "id",
    findDocumentsById: async () => {
      probeCalls += 1;
      return "[]";
    },
    bulkWrite: async () => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new SyntaxError("stored bytes rotted after verification");
      }
      return { error: [] };
    },
    query: async () => JSON.stringify({ documents: [] }),
    getChangedDocumentsSince: async () => JSON.stringify({ documents: [] }),
  };
  const { withTargetedOpfsRecovery } =
    await import("./opfs-targeted-recovery.mjs");
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance(storageParams("raw-write-malformed"));

  await recovering.bulkWrite([{ document: record }], "prime-cache");
  assert.equal(probeCalls, 1);

  failNextWrite = true;
  await assert.rejects(
    recovering.bulkWrite([{ document: record }], "rotted"),
    /stored bytes rotted/,
  );

  await recovering.bulkWrite([{ document: record }], "retry");
  assert.ok(probeCalls > 1, "retry after a malformed write must re-probe");
});

for (const method of [
  "findDocumentsById",
  "query",
  "getChangedDocumentsSince",
]) {
  test(`${method} validates the result returned after recovery`, async () => {
    const basePath = await mkdtemp(join(tmpdir(), "wcpos-retry-validation-"));
    const record = document(`retry:${method}`, 0);

    try {
      const rawStorage = getRxStorageFilesystemNode({ basePath });
      const initial = await rawStorage.createStorageInstance(
        storageParams(`${method}-initial`),
      );
      await initial.bulkWrite([{ document: record }], "seed");
      await initial.cleanup(0);
      await initial.close();
      await corruptRecord(basePath, record.id);

      const malformedStorage = {
        ...rawStorage,
        async createStorageInstance(params) {
          const instance = await rawStorage.createStorageInstance(params);
          instance[method] = async () => "[{malformed";
          return instance;
        },
      };
      const { withTargetedOpfsRecovery } =
        await import("./opfs-targeted-recovery.mjs");
      const recovering = await withTargetedOpfsRecovery(
        malformedStorage,
      ).createStorageInstance(storageParams(`${method}-recovering`));
      const args =
        method === "findDocumentsById"
          ? [[record.id], false]
          : method === "query"
            ? [{}]
            : [10];
      try {
        await assert.rejects(recovering[method](...args), {
          name: "SyntaxError",
        });
      } finally {
        await recovering.close();
      }
    } finally {
      await rm(basePath, { recursive: true, force: true });
    }
  });
}

test("repairs one malformed record without removing its collection siblings", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-targeted-recovery-"));
  const ids = ["product:111", "product:6660", "product:999"];
  const records = ids.map((id, index) => document(id, index));

  try {
    const rawStorage = getRxStorageFilesystemNode({ basePath });
    const initial = await rawStorage.createStorageInstance(
      storageParams("initial"),
    );
    const writeResult = await initial.bulkWrite(
      records.map((item) => ({ document: item })),
      "seed",
    );
    assert.deepEqual(writeResult.error, []);
    await initial.cleanup(0);
    await initial.close();
    await corruptRecordInPlace(basePath, "product:6660", () =>
      Buffer.from(
        `          ,{,${JSON.stringify({ ...records[1], value: "x" })}`,
      ),
    );

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recoveryStorage = withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    );
    const recovering = await recoveryStorage.createStorageInstance(
      storageParams("recovering"),
    );
    const query = prepareQuery(
      schema,
      normalizeMangoQuery(schema, {
        selector: {},
        sort: [{ id: "asc" }],
      }),
    );
    const recovered = (await recovering.query(query)).documents;
    assert.deepEqual(
      recovered.map((item) => item.id),
      ids,
    );
    let cleaned = false;
    for (let attempt = 0; attempt < 5 && !cleaned; attempt += 1) {
      cleaned = await recovering.cleanup(0);
    }
    assert.equal(cleaned, true);
    const afterCleanup = await recovering.findDocumentsById(ids, false);
    assert.deepEqual(
      afterCleanup.map((item) => item.id),
      ids,
    );
    await recovering.close();

    await corruptRecord(basePath, "product:999");
    const syncing = await recoveryStorage.createStorageInstance(
      storageParams("syncing"),
    );
    const changed = await syncing.getChangedDocumentsSince(10);
    assert.deepEqual(
      changed.documents.map((item) => item.id).sort(),
      [...ids].sort(),
    );
    await syncing.close();

    const reopened = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("reopened"));
    const persisted = await reopened.findDocumentsById(ids, false);
    assert.deepEqual(
      persisted.map((item) => item.id),
      ids,
    );
    await reopened.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("drops whitespace-only index rows after cleanup fails", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-cleanup-recovery-"));
  const oldLwt = Date.now() - 10_000;
  const deleted = {
    ...document("product:deleted", 0),
    _meta: { lwt: oldLwt },
  };
  const dead = {
    ...document("product:dead", 1),
    _meta: { lwt: oldLwt + 1 },
  };
  const survivor = {
    ...document("product:survivor", 2),
    _meta: { lwt: oldLwt + 2 },
  };

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("cleanup-initial"));
    await initial.bulkWrite(
      [deleted, dead, survivor].map((item) => ({ document: item })),
      "seed",
    );
    let initialCleaned = false;
    for (let attempt = 0; attempt < 5 && !initialCleaned; attempt += 1) {
      initialCleaned = await initial.cleanup(0);
    }
    assert.equal(initialCleaned, true);
    await initial.bulkWrite(
      [
        {
          previous: deleted,
          document: {
            ...deleted,
            _deleted: true,
            _rev: "2-deleted",
            _meta: { lwt: oldLwt + 100 },
          },
        },
      ],
      "delete",
    );
    assert.equal(await initial.cleanup(0), false);
    assert.equal(await initial.cleanup(0), false);
    await initial.close();

    await corruptRecordInPlace(basePath, dead.id, () => Buffer.alloc(0));

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("cleanup-recovering"));
    assert.equal(await recovering.cleanup(0), false);
    assert.equal(typeof (await recovering.cleanup(0)), "boolean");

    const state = await recovering.internals.statePromise;
    assert.equal(state.firstIdx.metaIdMap.has(dead.id), false);
    assert.ok(
      state.indexStates.every((indexState) =>
        indexState.rows.every((row) => !row[0].includes(dead.id)),
      ),
    );
    assert.deepEqual(
      (await recovering.findDocumentsById([dead.id, survivor.id], false)).map(
        (item) => item.id,
      ),
      [survivor.id],
    );
    const query = prepareQuery(
      schema,
      normalizeMangoQuery(schema, {
        selector: {},
        sort: [{ id: "asc" }],
      }),
    );
    assert.deepEqual(
      (await recovering.query(query)).documents.map((item) => item.id),
      [survivor.id],
    );
    assert.equal(typeof (await recovering.cleanup(0)), "boolean");
    await recovering.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("repairs a malformed record before retrying its pending write", async () => {
  const basePath = await mkdtemp(
    join(tmpdir(), "wcpos-targeted-write-recovery-"),
  );
  const openOrder = document("order:open", 0);
  const siblingOrder = document("order:sibling", 1);

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("write-initial"));
    const seed = await initial.bulkWrite(
      [openOrder, siblingOrder].map((item) => ({ document: item })),
      "seed",
    );
    assert.deepEqual(seed.error, []);
    await initial.cleanup(0);
    await initial.close();
    await corruptRecord(basePath, openOrder.id);

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recoveryStorage = withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    );
    const recovering = await recoveryStorage.createStorageInstance(
      storageParams("write-recovering"),
    );
    const updatedOrder = {
      ...openOrder,
      value: "updated-open-order",
      _rev: "2-recovered",
      _meta: { lwt: openOrder._meta.lwt + 100 },
    };
    const update = await recovering.bulkWrite(
      [{ document: updatedOrder, previous: openOrder }],
      "update",
    );
    assert.deepEqual(update.error, []);
    const current = await recovering.findDocumentsById(
      [openOrder.id, siblingOrder.id],
      false,
    );
    assert.equal(
      current.find((item) => item.id === openOrder.id)?.value,
      "updated-open-order",
    );
    assert.ok(current.some((item) => item.id === siblingOrder.id));
    await recovering.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

// The storage files an insert into its in-memory indexes only when it flushes
// pending writes — at the end of a write run, or before the next task that
// touches the same id. An update that follows its own insert inside that
// window sees the primary index without the id; stripping `previous` there
// turns the update into a second insert, which the storage — having flushed
// the first by the time it categorizes the write — reports as a 409. This is
// the embedded web boot after Clear All Local Data: the credentials upsert
// and the store-links patch land milliseconds apart on a fresh collection.
test("keeps `previous` on an update that follows its own unflushed insert", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-targeted-pending-insert-"));
  const credentials = document("credentials:fresh", 0);

  try {
    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const storage = withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    );
    const instance = await storage.createStorageInstance(
      storageParams("pending-insert"),
    );
    const insert = await instance.bulkWrite(
      [{ document: credentials }],
      "insert",
    );
    assert.deepEqual(insert.error, []);
    const linked = {
      ...credentials,
      value: "linked",
      _rev: "2-linked",
      _meta: { lwt: credentials._meta.lwt + 1 },
    };
    // No await between the two writes: the update must reach the wrapper
    // while the insert is still pending in the storage.
    const update = await instance.bulkWrite(
      [{ document: linked, previous: credentials }],
      "update",
    );
    assert.deepEqual(update.error, []);
    const current = await instance.findDocumentsById([credentials.id], false);
    assert.equal(current[0]?._rev, "2-linked");
    await instance.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("refuses to recover a matching nested object as the whole document", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-targeted-refusal-"));
  const id = "product:nested";

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("nested-initial"));
    await initial.bulkWrite([{ document: document(id, 0) }], "seed");
    await initial.cleanup(0);
    await initial.close();
    await corruptRecord(basePath, id, () =>
      Buffer.from(`{"id":"${id}","nested":{"id":"${id}"} garbage`),
    );

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("nested-recovering"));
    await assert.rejects(recovering.findDocumentsById([id], false), {
      name: "SyntaxError",
      message: new RegExp(
        `targeted recovery failed for ${id}: index-mismatch$`,
      ),
    });
    await recovering.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("refuses a matching id whose recovered index values differ", async () => {
  const basePath = await mkdtemp(
    join(tmpdir(), "wcpos-targeted-index-refusal-"),
  );
  const id = "product:index-mismatch";

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("index-mismatch-initial"));
    await initial.bulkWrite([{ document: document(id, 0) }], "seed");
    await initial.cleanup(0);
    await initial.close();
    await corruptRecord(basePath, id, () =>
      Buffer.from(`{"id":"${id}"}garbage`),
    );

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("index-mismatch-recovering"));
    await assert.rejects(recovering.findDocumentsById([id], false), {
      name: "SyntaxError",
      message: new RegExp(
        `targeted recovery failed for ${id}: index-mismatch$`,
      ),
    });
    await recovering.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

const laneSchema = {
  title: "coverage lane probe",
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 100 },
    alpha: { type: "string", maxLength: 100 },
    beta: { type: "string", maxLength: 100 },
    value: { type: "string" },
    _deleted: { type: "boolean" },
    _rev: { type: "string", minLength: 1 },
    _meta: {
      type: "object",
      properties: {
        lwt: {
          type: "number",
          minimum: 1,
          maximum: 1_000_000_000_000_000,
          multipleOf: 0.01,
        },
      },
      required: ["lwt"],
      additionalProperties: false,
    },
    _attachments: { type: "object" },
  },
  required: [
    "id",
    "alpha",
    "beta",
    "value",
    "_deleted",
    "_rev",
    "_meta",
    "_attachments",
  ],
  indexes: [
    ["_deleted", "alpha", "id"],
    ["_deleted", "beta", "id"],
  ],
};

function laneStorageParams(token) {
  return {
    databaseName: "index-reconcile-db",
    collectionName: "lanes",
    schema: laneSchema,
    options: {},
    multiInstance: false,
    devMode: false,
    databaseInstanceToken: token,
  };
}

function laneDocument(id, sequence) {
  return {
    id,
    alpha: `alpha-${id}`,
    beta: `beta-${id}`,
    value: `expects product:6660 for ${id}`,
    _deleted: false,
    _rev: `1-lane${sequence}`,
    _meta: { lwt: Date.now() + sequence },
    _attachments: {},
  };
}

async function shiftSecondaryIndexOffsets(basePath, id, shift, position = 1) {
  const directory = join(basePath, (await readdir(basePath))[0]);
  const indexNames = (await readdir(directory))
    .filter((name) => name.startsWith("index-"))
    .sort();
  // index-00000 backs the primary metaIdMap; index-00001 is the second
  // schema index (["_deleted", "beta", "id"]) that queries plan onto.
  const indexPath = join(directory, indexNames[position]);
  const rows = JSON.parse(await readFile(indexPath, "utf8"));
  const targetRow = rows.find((row) => row[0].includes(id));
  assert.ok(targetRow, `missing index row for ${id}`);
  targetRow[1] += shift;
  targetRow[2] += shift;
  await writeFile(indexPath, JSON.stringify(rows));
}

test("rebuilds a secondary index whose rows point at stale byte ranges", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-index-reconcile-"));
  const ids = ["lane:aaa", "lane:bbb", "lane:ccc"];
  const records = ids.map((id, index) => laneDocument(id, index));

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("lane-initial"));
    const seed = await initial.bulkWrite(
      records.map((item) => ({ document: item })),
      "seed",
    );
    assert.deepEqual(seed.error, []);
    await initial.cleanup(0);
    await initial.close();
    await shiftSecondaryIndexOffsets(basePath, "lane:bbb", -2);

    const betaQuery = prepareQuery(
      laneSchema,
      normalizeMangoQuery(laneSchema, {
        selector: {},
        sort: [{ beta: "asc" }],
      }),
    );
    assert.ok(
      betaQuery.queryPlan.index.includes("beta"),
      "query must plan onto the corrupted secondary index",
    );

    const unwrapped = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("lane-unwrapped"));
    await assert.rejects(unwrapped.query(betaQuery), { name: "SyntaxError" });
    // Singleton reads go through the intact primary index, so probing every
    // document individually finds nothing to repair — the live dev-next shape.
    const probed = await unwrapped.findDocumentsById(ids, true);
    assert.deepEqual(probed.map((item) => item.id).sort(), [...ids].sort());
    await unwrapped.close();

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(laneStorageParams("lane-recovering"));
    const recovered = (await recovering.query(betaQuery)).documents;
    assert.deepEqual(
      recovered.map((item) => item.id),
      ids,
    );
    let cleaned = false;
    for (let attempt = 0; attempt < 5 && !cleaned; attempt += 1) {
      cleaned = await recovering.cleanup(0);
    }
    assert.equal(cleaned, true);
    await recovering.close();

    // The repair must persist: a plain storage instance with no recovery
    // wrapper reads through the rebuilt index after reopen.
    const reopened = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("lane-reopened"));
    const persisted = (await reopened.query(betaQuery)).documents;
    assert.deepEqual(
      persisted.map((item) => item.id),
      ids,
    );
    await reopened.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("declines an index rebuild when the storage is multi-instance", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-index-multi-"));
  const ids = ["lane:aaa", "lane:bbb", "lane:ccc"];

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("multi-initial"));
    await initial.bulkWrite(
      ids.map((id, index) => ({ document: laneDocument(id, index) })),
      "seed",
    );
    await initial.cleanup(0);
    await initial.close();
    await shiftSecondaryIndexOffsets(basePath, "lane:bbb", -2);

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance({
      ...laneStorageParams("multi-recovering"),
      multiInstance: true,
    });
    const betaQuery = prepareQuery(
      laneSchema,
      normalizeMangoQuery(laneSchema, {
        selector: {},
        sort: [{ beta: "asc" }],
      }),
    );
    await assert.rejects(recovering.query(betaQuery), {
      name: "SyntaxError",
      message: /index reconciliation refused: multi-instance$/,
    });
    await recovering.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("refuses an index rebuild when the primary index is itself unsound", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-index-unsound-"));
  const ids = ["lane:aaa", "lane:bbb", "lane:ccc"];

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("unsound-initial"));
    await initial.bulkWrite(
      ids.map((id, index) => ({ document: laneDocument(id, index) })),
      "seed",
    );
    await initial.cleanup(0);
    await initial.close();
    await shiftSecondaryIndexOffsets(basePath, "lane:bbb", -2);
    // Point the primary row for lane:bbb at lane:aaa's byte range: parseable
    // bytes, wrong document — the rebuild source itself cannot be trusted.
    const directory = join(basePath, (await readdir(basePath))[0]);
    const primaryPath = join(
      directory,
      (await readdir(directory))
        .filter((n) => n.startsWith("index-"))
        .sort()[0],
    );
    const rows = JSON.parse(await readFile(primaryPath, "utf8"));
    const aaaRow = rows.find((row) => row[0].includes("lane:aaa"));
    const bbbRow = rows.find((row) => row[0].includes("lane:bbb"));
    bbbRow[1] = aaaRow[1];
    bbbRow[2] = aaaRow[2];
    await writeFile(primaryPath, JSON.stringify(rows));

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(laneStorageParams("unsound-recovering"));
    const betaQuery = prepareQuery(
      laneSchema,
      normalizeMangoQuery(laneSchema, {
        selector: {},
        sort: [{ beta: "asc" }],
      }),
    );
    await assert.rejects(recovering.query(betaQuery), {
      name: "SyntaxError",
      message: /index reconciliation refused: primary-row-mismatch:lane:bbb$/,
    });
    await recovering.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("recovers every concurrent query against the same stale index", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-index-concurrent-"));
  const ids = ["lane:aaa", "lane:bbb", "lane:ccc"];

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("concurrent-initial"));
    await initial.bulkWrite(
      ids.map((id, index) => ({ document: laneDocument(id, index) })),
      "seed",
    );
    await initial.cleanup(0);
    await initial.close();
    await shiftSecondaryIndexOffsets(basePath, "lane:bbb", -2);

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(laneStorageParams("concurrent-recovering"));
    const betaQuery = prepareQuery(
      laneSchema,
      normalizeMangoQuery(laneSchema, {
        selector: {},
        sort: [{ beta: "asc" }],
      }),
    );
    const results = await Promise.all(
      Array.from({ length: 4 }, () => recovering.query(betaQuery)),
    );
    for (const result of results) {
      assert.deepEqual(
        result.documents.map((item) => item.id),
        ids,
      );
    }
    await recovering.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("refuses a rebuild when the primary points at a stale duplicate revision", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-index-stale-rev-"));
  const ids = ["lane:aaa", "lane:bbb", "lane:ccc"];

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("stale-rev-initial"));
    await initial.bulkWrite(
      ids.map((id, index) => ({ document: laneDocument(id, index) })),
      "seed",
    );
    await initial.cleanup(0);
    await initial.close();
    await shiftSecondaryIndexOffsets(basePath, "lane:bbb", -2);
    // Append a byte-identical copy of lane:ccc's record and point ONLY the
    // primary index at the copy. Secondary indexes still reference the
    // original range, so the primary loses the corroboration vote.
    const directory = join(basePath, (await readdir(basePath))[0]);
    const primaryPath = join(
      directory,
      (await readdir(directory))
        .filter((n) => n.startsWith("index-"))
        .sort()[0],
    );
    const rows = JSON.parse(await readFile(primaryPath, "utf8"));
    const cccRow = rows.find((row) => row[0].includes("lane:ccc"));
    const documentsPath = join(directory, "documents.json");
    const documentsBytes = await readFile(documentsPath);
    const copy = documentsBytes.subarray(cccRow[1], cccRow[2]);
    await writeFile(documentsPath, Buffer.concat([documentsBytes, copy]));
    cccRow[1] = documentsBytes.length;
    cccRow[2] = documentsBytes.length + copy.length;
    await writeFile(primaryPath, JSON.stringify(rows));

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(laneStorageParams("stale-rev-recovering"));
    const betaQuery = prepareQuery(
      laneSchema,
      normalizeMangoQuery(laneSchema, {
        selector: {},
        sort: [{ beta: "asc" }],
      }),
    );
    await assert.rejects(recovering.query(betaQuery), {
      name: "SyntaxError",
      message:
        /index reconciliation refused: uncorroborated-primary-range:lane:ccc$/,
    });
    await recovering.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("rebuilds every index from documents.json when the primary index is missing rows", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-index-truncated-"));
  const ids = ["lane:aaa", "lane:bbb", "lane:ccc"];

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("truncated-initial"));
    await initial.bulkWrite(
      ids.map((id, index) => ({ document: laneDocument(id, index) })),
      "seed",
    );
    await initial.cleanup(0);
    await initial.close();
    await shiftSecondaryIndexOffsets(basePath, "lane:bbb", -2);
    const directory = join(basePath, (await readdir(basePath))[0]);
    const primaryPath = join(
      directory,
      (await readdir(directory))
        .filter((n) => n.startsWith("index-"))
        .sort()[0],
    );
    const rows = JSON.parse(await readFile(primaryPath, "utf8"));
    await writeFile(
      primaryPath,
      JSON.stringify(rows.filter((row) => !row[0].includes("lane:ccc"))),
    );

    const rebuilds = [];
    globalThis.__wcposOnIndexRebuild = (event) => rebuilds.push(event);
    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(laneStorageParams("truncated-recovering"));
    const betaQuery = prepareQuery(
      laneSchema,
      normalizeMangoQuery(laneSchema, {
        selector: {},
        sort: [{ beta: "asc" }],
      }),
    );
    // Boot validation (patch-rxdb-premium-changelog-replay-safety.mjs) sees the
    // index lengths disagree and rebuilds every index from documents.json
    // before the first read, so the wrapper never has to decide whether the
    // primary can be trusted: the store heals, and the query answers.
    const result = await recovering.query(betaQuery);
    assert.deepEqual(
      result.documents.map((row) => row.id),
      ids,
    );
    assert.deepEqual(
      rebuilds.map((event) => event.reason),
      ["length-mismatch"],
    );
    await recovering.close();
  } finally {
    delete globalThis.__wcposOnIndexRebuild;
    await rm(basePath, { recursive: true, force: true });
  }
});

test("reports an incomplete index rollback and recovers on retry", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-index-scattered-"));
  const ids = ["lane:aaa", "lane:bbb", "lane:ccc"];

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("scattered-initial"));
    await initial.bulkWrite(
      ids.map((id, index) => ({ document: laneDocument(id, index) })),
      "seed",
    );
    await initial.cleanup(0);
    await initial.close();
    // The live dev-next shape: multiple index files diverged independently, so
    // no competing consensus exists — the validated primary must still win.
    await shiftSecondaryIndexOffsets(basePath, "lane:bbb", -2, 1);
    await shiftSecondaryIndexOffsets(basePath, "lane:bbb", -4, 2);

    const directory = join(basePath, (await readdir(basePath))[0]);
    const indexPaths = (await readdir(directory))
      .filter((name) => name.startsWith("index-"))
      .sort()
      .map((name) => join(directory, name));
    const before = await Promise.all(
      indexPaths.map((path) => readFile(path, "utf8")),
    );

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(laneStorageParams("scattered-recovering"));
    const state = await recovering.internals.statePromise;
    const rollbackIndex = state.indexStates.at(-2);
    const persistRollbackIndex =
      rollbackIndex.persistInMemoryRows.bind(rollbackIndex);
    let rollbackWrites = 0;
    rollbackIndex.persistInMemoryRows = async (...args) => {
      rollbackWrites += 1;
      if (rollbackWrites === 2) {
        throw new Error("injected rollback persistence failure");
      }
      return persistRollbackIndex(...args);
    };
    const laterIndex = state.indexStates.at(-1);
    const persistLaterIndex = laterIndex.persistInMemoryRows.bind(laterIndex);
    let rejectOnce = true;
    laterIndex.persistInMemoryRows = async (...args) => {
      if (rejectOnce) {
        rejectOnce = false;
        throw new Error("injected later-index persistence failure");
      }
      return persistLaterIndex(...args);
    };
    const betaQuery = prepareQuery(
      laneSchema,
      normalizeMangoQuery(laneSchema, {
        selector: {},
        sort: [{ beta: "asc" }],
      }),
    );
    await assert.rejects(recovering.query(betaQuery), (error) => {
      assert.equal(error.name, "SyntaxError");
      assert.match(error.message, /injected later-index persistence failure/);
      assert.match(error.message, /rollback incomplete/);
      assert.match(error.message, /injected rollback persistence failure/);
      return true;
    });
    assert.equal(rollbackWrites, 2);
    const afterIncompleteRollback = await Promise.all(
      indexPaths.map((path) => readFile(path, "utf8")),
    );
    assert.notDeepEqual(afterIncompleteRollback, before);
    const recovered = (await recovering.query(betaQuery)).documents;
    assert.deepEqual(
      recovered.map((item) => item.id),
      ids,
    );
    const changed = await recovering.getChangedDocumentsSince(10);
    assert.deepEqual(
      changed.documents.map((item) => item.id).sort(),
      [...ids].sort(),
    );
    await recovering.close();

    const reopened = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("scattered-reopened"));
    const persisted = (await reopened.query(betaQuery)).documents;
    assert.deepEqual(
      persisted.map((item) => item.id),
      ids,
    );
    await reopened.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("refuses a rebuild when index ID sets differ despite equal counts", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-index-idset-"));
  const ids = ["lane:aaa", "lane:bbb", "lane:ccc"];

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("idset-initial"));
    await initial.bulkWrite(
      ids.map((id, index) => ({ document: laneDocument(id, index) })),
      "seed",
    );
    await initial.cleanup(0);
    await initial.close();
    await shiftSecondaryIndexOffsets(basePath, "lane:bbb", -2, 1);
    // Rename lane:ccc's row in the _meta.lwt index so counts match but the
    // ID sets differ — a rebuild would orphan the renamed document.
    const directory = join(basePath, (await readdir(basePath))[0]);
    const metaPath = join(
      directory,
      (await readdir(directory))
        .filter((n) => n.startsWith("index-"))
        .sort()[2],
    );
    const rows = JSON.parse(await readFile(metaPath, "utf8"));
    const cccRow = rows.find((row) => row[0].includes("lane:ccc"));
    cccRow[0] = cccRow[0].replace("lane:ccc", "lane:ddd");
    await writeFile(metaPath, JSON.stringify(rows));

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(laneStorageParams("idset-recovering"));
    const betaQuery = prepareQuery(
      laneSchema,
      normalizeMangoQuery(laneSchema, {
        selector: {},
        sort: [{ beta: "asc" }],
      }),
    );
    await assert.rejects(recovering.query(betaQuery), {
      name: "SyntaxError",
      message: /index reconciliation refused: id-set-mismatch:lane:ddd$/,
    });
    await recovering.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("rebuilds every index from documents.json when the primary index holds duplicate IDs", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-index-dupid-"));
  const ids = ["lane:aaa", "lane:bbb", "lane:ccc"];

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("dupid-initial"));
    await initial.bulkWrite(
      ids.map((id, index) => ({ document: laneDocument(id, index) })),
      "seed",
    );
    await initial.cleanup(0);
    await initial.close();
    await shiftSecondaryIndexOffsets(basePath, "lane:bbb", -2, 1);
    // Append a byte-identical copy of lane:aaa, then overwrite lane:bbb's
    // primary row with a second lane:aaa row pointing at the copy: counts
    // stay equal but the primary now names lane:aaa twice.
    const directory = join(basePath, (await readdir(basePath))[0]);
    const primaryPath = join(
      directory,
      (await readdir(directory))
        .filter((n) => n.startsWith("index-"))
        .sort()[0],
    );
    const rows = JSON.parse(await readFile(primaryPath, "utf8"));
    const aaaRow = rows.find((row) => row[0].includes("lane:aaa"));
    const bbbRow = rows.find((row) => row[0].includes("lane:bbb"));
    const documentsPath = join(directory, "documents.json");
    const documentsBytes = await readFile(documentsPath);
    const copy = documentsBytes.subarray(aaaRow[1], aaaRow[2]);
    await writeFile(documentsPath, Buffer.concat([documentsBytes, copy]));
    bbbRow[0] = aaaRow[0];
    bbbRow[1] = documentsBytes.length;
    bbbRow[2] = documentsBytes.length + copy.length;
    await writeFile(primaryPath, JSON.stringify(rows));

    const rebuilds = [];
    globalThis.__wcposOnIndexRebuild = (event) => rebuilds.push(event);
    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(laneStorageParams("dupid-recovering"));
    const betaQuery = prepareQuery(
      laneSchema,
      normalizeMangoQuery(laneSchema, {
        selector: {},
        sort: [{ beta: "asc" }],
      }),
    );
    // Boot validation (patch-rxdb-premium-changelog-replay-safety.mjs) sees the
    // duplicated primary key and rebuilds every index from documents.json
    // before the first read; the byte-identical appended copy collapses to one
    // lane:aaa, so the store heals and the query answers.
    const result = await recovering.query(betaQuery);
    assert.deepEqual(
      result.documents.map((row) => row.id),
      ids,
    );
    assert.deepEqual(
      rebuilds.map((event) => event.reason),
      ["duplicate-primary"],
    );
    await recovering.close();
  } finally {
    delete globalThis.__wcposOnIndexRebuild;
    await rm(basePath, { recursive: true, force: true });
  }
});

test("rebuilds a secondary index that duplicates one document and drops another", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-index-dup-drop-"));
  const ids = ["lane:aaa", "lane:bbb", "lane:ccc"];

  try {
    const initial = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("dup-drop-initial"));
    await initial.bulkWrite(
      ids.map((id, index) => ({ document: laneDocument(id, index) })),
      "seed",
    );
    await initial.cleanup(0);
    await initial.close();
    // The live dev-next shape: an applied changelog add whose matching delete
    // was lost leaves the index with one document twice (current + stale
    // range) and another document's row gone, at unchanged cardinality.
    const directory = join(basePath, (await readdir(basePath))[0]);
    const betaPath = join(
      directory,
      (await readdir(directory))
        .filter((n) => n.startsWith("index-"))
        .sort()[1],
    );
    const rows = JSON.parse(await readFile(betaPath, "utf8"));
    const bbbRow = rows.find((row) => row[0].includes("lane:bbb"));
    const cccPosition = rows.findIndex((row) => row[0].includes("lane:ccc"));
    rows[cccPosition] = [bbbRow[0], bbbRow[1] - 2, bbbRow[2] - 2];
    await writeFile(betaPath, JSON.stringify(rows));

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(laneStorageParams("dup-drop-recovering"));
    const betaQuery = prepareQuery(
      laneSchema,
      normalizeMangoQuery(laneSchema, {
        selector: {},
        sort: [{ beta: "asc" }],
      }),
    );
    const recovered = (await recovering.query(betaQuery)).documents;
    assert.deepEqual(
      recovered.map((item) => item.id),
      ids,
    );
    await recovering.close();

    const reopened = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(laneStorageParams("dup-drop-reopened"));
    const persisted = (await reopened.query(betaQuery)).documents;
    assert.deepEqual(
      persisted.map((item) => item.id),
      ids,
    );
    await reopened.close();
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

// A "hollow" row: the index still carries the document, but its byte range
// holds only whitespace — the shape a compaction leaves when it dies between
// relocating a record and persisting the moved row. A read of that single row
// parses to `[]` and reports the document absent, so nothing upstream treats it
// as damage; the storage's own write path then indexes the parsed rows
// positionally and dereferences `undefined` (Sentry WOOCOMMERCE-POS-2HC).
async function seedCompacted(basePath, records, token) {
  const initial = await getRxStorageFilesystemNode({
    basePath,
  }).createStorageInstance(storageParams(token));
  assert.deepEqual(
    (
      await initial.bulkWrite(
        records.map((item) => ({ document: item })),
        "seed",
      )
    ).error,
    [],
  );
  let compacted = false;
  for (let attempt = 0; attempt < 5 && !compacted; attempt += 1) {
    compacted = await initial.cleanup(0);
  }
  assert.equal(compacted, true);
  return initial;
}

function captureRecoveryEvents() {
  const events = [];
  const hook = (event) => events.push(event);
  globalThis.__wcposOnStorageRecovery = hook;
  return {
    events,
    stop() {
      if (globalThis.__wcposOnStorageRecovery === hook)
        delete globalThis.__wcposOnStorageRecovery;
    },
  };
}

test("drops a hollow index row so a pending write lands instead of dereferencing it", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-hollow-write-"));
  const hollow = document("order:hollow", 0);
  const sibling = document("order:sibling", 1);
  const capture = captureRecoveryEvents();

  try {
    await (
      await seedCompacted(basePath, [hollow, sibling], "hollow-seed")
    ).close();
    await corruptRecordInPlace(basePath, hollow.id, () => Buffer.alloc(0));

    // The raw storage sees the damage as absence: the index has the row, the
    // read has no document for it.
    const raw = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("hollow-raw"));
    const rawState = await raw.internals.statePromise;
    assert.ok(rawState.firstIdx.metaIdMap.has(hollow.id));
    assert.deepEqual(await raw.findDocumentsById([hollow.id], true), []);
    await raw.close();

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("hollow-recovering"));
    const updated = {
      ...hollow,
      value: "recovered",
      _rev: "2-hollow",
      _meta: { lwt: hollow._meta.lwt + 100 },
    };
    const written = await recovering.bulkWrite(
      [{ previous: hollow, document: updated }],
      "update",
    );
    assert.deepEqual(written.error, []);
    assert.deepEqual(capture.events, [
      {
        kind: "hollow-row-dropped",
        target: "targeted-recovery-db/products",
        id: hollow.id,
      },
    ]);
    const current = await recovering.findDocumentsById(
      [hollow.id, sibling.id],
      false,
    );
    assert.deepEqual(
      current.map((item) => [item.id, item.value]),
      [
        [hollow.id, "recovered"],
        [sibling.id, sibling.value],
      ],
    );
    const state = await recovering.internals.statePromise;
    for (const indexState of state.indexStates) {
      assert.equal(
        indexState.rows.filter((row) => row[0].includes(hollow.id)).length,
        1,
        "exactly one row per index for the re-inserted document",
      );
    }
    await recovering.close();

    const reopened = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("hollow-reopened"));
    assert.deepEqual(
      (await reopened.findDocumentsById([hollow.id, sibling.id], false)).map(
        (item) => item.value,
      ),
      ["recovered", sibling.value],
    );
    await reopened.close();
  } finally {
    capture.stop();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("does not verify a hollow id as clean on a withDeleted read", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-hollow-read-"));
  const hollow = document("order:hollow", 0);
  const sibling = document("order:sibling", 1);
  const capture = captureRecoveryEvents();

  try {
    await (
      await seedCompacted(basePath, [hollow, sibling], "read-seed")
    ).close();
    await corruptRecordInPlace(basePath, hollow.id, () => Buffer.alloc(0));

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("read-recovering"));
    // The read that would have cached the id as verified drops the row instead.
    assert.deepEqual(
      (await recovering.findDocumentsById([hollow.id, sibling.id], true)).map(
        (item) => item.id,
      ),
      [sibling.id],
    );
    assert.deepEqual(
      capture.events.map((event) => [event.kind, event.id]),
      [["hollow-row-dropped", hollow.id]],
    );
    const state = await recovering.internals.statePromise;
    assert.equal(state.firstIdx.metaIdMap.has(hollow.id), false);
    // The id is now genuinely absent — verified clean by that read — and a
    // plain insert lands.
    assert.deepEqual(
      (await recovering.bulkWrite([{ document: hollow }], "reinsert")).error,
      [],
    );
    assert.deepEqual(
      (await recovering.findDocumentsById([hollow.id], false)).map(
        (item) => item.id,
      ),
      [hollow.id],
    );
    await recovering.close();
  } finally {
    capture.stop();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("refuses a row that points at another document and still lands the write", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-foreign-row-"));
  const shifted = document("order:shifted", 0);
  const victim = document("order:victim", 1);
  const capture = captureRecoveryEvents();

  try {
    await (
      await seedCompacted(basePath, [shifted, victim], "foreign-seed")
    ).close();
    // Point every index row for order:shifted at order:victim's bytes:
    // parseable, wrong document — not hollow, and not repairable in place.
    const directory = join(basePath, (await readdir(basePath))[0]);
    for (const name of (await readdir(directory)).filter((entry) =>
      entry.startsWith("index-"),
    )) {
      const path = join(directory, name);
      const rows = JSON.parse(await readFile(path, "utf8"));
      const victimRow = rows.find((row) => row[0].includes(victim.id));
      const shiftedRow = rows.find((row) => row[0].includes(shifted.id));
      shiftedRow[1] = victimRow[1];
      shiftedRow[2] = victimRow[2];
      await writeFile(path, JSON.stringify(rows));
    }

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("foreign-recovering"));
    // A read of the shifted id is refused (nothing to drop) and must not hand
    // back the victim's record in its place.
    assert.deepEqual(
      await recovering.findDocumentsById([shifted.id], true),
      [],
    );
    assert.deepEqual(
      (await recovering.findDocumentsById([shifted.id, victim.id], true)).map(
        (item) => item.id,
      ),
      [victim.id],
    );
    assert.deepEqual(
      capture.events.map((event) => [event.kind, event.reason]),
      [
        ["hollow-row-refused", "range-holds-foreign-bytes"],
        ["hollow-row-refused", "range-holds-foreign-bytes"],
      ],
    );
    capture.events.length = 0;
    const updated = {
      ...shifted,
      value: "written-over-a-stale-row",
      _rev: "2-shifted",
      _meta: { lwt: shifted._meta.lwt + 100 },
    };
    const written = await recovering.bulkWrite(
      [{ previous: shifted, document: updated }],
      "update",
    );
    assert.deepEqual(written.error, []);
    assert.deepEqual(capture.events, [
      {
        kind: "hollow-row-refused",
        target: "targeted-recovery-db/products",
        id: shifted.id,
        reason: "range-holds-foreign-bytes",
      },
    ]);
    // Not hollow, so `previous` is kept: the storage inserts the document and
    // its index code locates the stale rows by the previous revision's keys,
    // replacing them in place with the new record's range.
    const live = await recovering.internals.statePromise;
    for (const indexState of live.indexStates) {
      assert.equal(
        indexState.rows.filter((row) => row[0].includes(shifted.id)).length,
        1,
      );
    }
    await recovering.close();

    const reopened = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("foreign-reopened"));
    assert.deepEqual(
      (await reopened.findDocumentsById([shifted.id, victim.id], false)).map(
        (item) => [item.id, item.value],
      ),
      [
        [shifted.id, "written-over-a-stale-row"],
        [victim.id, victim.value],
      ],
    );
    const state = await reopened.internals.statePromise;
    assert.equal(
      state.firstIdx.rows.filter((row) => row[0].includes(shifted.id)).length,
      1,
    );
    await reopened.close();
  } finally {
    capture.stop();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("repairs a malformed tombstone when the cleanup retry still fails", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-cleanup-repair-"));
  const oldLwt = Date.now() - 10_000;
  const survivor = {
    ...document("product:survivor", 0),
    _meta: { lwt: oldLwt },
  };
  const other = { ...document("product:other", 1), _meta: { lwt: oldLwt + 1 } };
  const doomed = {
    ...document("product:doomed", 2),
    _meta: { lwt: oldLwt + 2 },
  };
  const capture = captureRecoveryEvents();

  try {
    const initial = await seedCompacted(
      basePath,
      [survivor, other, doomed],
      "cleanup-seed",
    );
    assert.deepEqual(
      (
        await initial.bulkWrite(
          [
            {
              previous: doomed,
              document: {
                ...doomed,
                _deleted: true,
                _rev: "2-doomed",
                _meta: { lwt: oldLwt + 100 },
              },
            },
          ],
          "delete",
        )
      ).error,
      [],
    );
    // Bake the delete's changelog operations into the index files without
    // purging the tombstone, so the corruption below targets the row the
    // next open will actually see.
    let baked = false;
    for (let attempt = 0; attempt < 5 && !baked; attempt += 1) {
      baked = await initial.cleanup(1_000_000_000_000);
    }
    assert.equal(baked, true);
    await initial.close();
    // Garbage after the tombstone's bytes: the whitespace pass cannot touch
    // it, so the cleanup retry fails exactly like the first attempt.
    await corruptRecord(basePath, doomed.id);

    const raw = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("cleanup-raw"));
    await assert.rejects(raw.cleanup(0), { name: "SyntaxError" });
    await raw.close();

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("cleanup-recovering"));
    let cleaned = false;
    for (let attempt = 0; attempt < 5 && !cleaned; attempt += 1) {
      cleaned = await recovering.cleanup(0);
    }
    assert.equal(cleaned, true);
    assert.deepEqual(
      capture.events,
      [],
      "no terminal cleanup failure reported",
    );
    assert.deepEqual(
      (
        await recovering.findDocumentsById(
          [survivor.id, other.id, doomed.id],
          true,
        )
      )
        .map((item) => item.id)
        .sort(),
      [other.id, survivor.id],
    );
    await recovering.close();

    const reopened = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("cleanup-reopened"));
    assert.deepEqual(
      (
        await reopened.findDocumentsById(
          [survivor.id, other.id, doomed.id],
          true,
        )
      )
        .map((item) => item.id)
        .sort(),
      [other.id, survivor.id],
    );
    await reopened.close();
  } finally {
    capture.stop();
    await rm(basePath, { recursive: true, force: true });
  }
});

// The changes file is the storage's per-run write-ahead log. Upstream appended
// every bulk at offset 0, so a crash mid-run left the shorter second bulk
// written over the longer first one — a parse failure in the hook that opens
// every read, on every boot (Sentry WOOCOMMERCE-POS-2GA). Seeds `long` and
// `short`, updates both in one run, then lays a re-targeted short bulk (value
// "from-wal") over the head of the long one the way the unpatched writer did.
async function seedOverwriteResidue(basePath, long, short) {
  const initial = await getRxStorageFilesystemNode({
    basePath,
  }).createStorageInstance(storageParams("residue-seed"));
  await initial.bulkWrite([{ document: long }, { document: short }], "seed");
  await initial.taskQueue.awaitIdle();
  const state = await initial.internals.statePromise;
  const writes = [];
  const original = state.changesFileHandle;
  state.changesFileHandle = {
    createAccessHandle: async () => {
      const handle = await original.createAccessHandle();
      const getWritable = handle.getWritable.bind(handle);
      handle.getWritable = () => {
        const writable = getWritable();
        const write = writable.write.bind(writable);
        writable.write = async (bytes, options) => {
          writes.push(Buffer.from(bytes));
          return write(bytes, options);
        };
        return writable;
      };
      return handle;
    },
  };
  await Promise.all([
    initial.bulkWrite(
      [
        {
          previous: long,
          document: {
            ...long,
            _rev: "2-long",
            _meta: { lwt: long._meta.lwt + 10 },
          },
        },
      ],
      "update-long",
    ),
    initial.bulkWrite(
      [
        {
          previous: short,
          document: {
            ...short,
            _rev: "2-short",
            _meta: { lwt: short._meta.lwt + 10 },
          },
        },
      ],
      "update-short",
    ),
  ]);
  await initial.taskQueue.awaitIdle();
  const stored = await initial.findDocumentsById([long.id, short.id], false);
  await initial.close();
  assert.equal(writes.length, 2);

  const bulk = JSON.parse(writes[1].toString().replace(/^,/, ""));
  const previous = stored.find((item) => item.id === short.id);
  bulk.events[0].previousDocumentData = previous;
  bulk.events[0].documentData = {
    ...previous,
    value: "from-wal",
    _rev: "3-short",
    _meta: { lwt: previous._meta.lwt + 1000 },
  };
  const shortBytes = Buffer.from(JSON.stringify(bulk));
  const residue = Buffer.concat([
    shortBytes,
    writes[0].subarray(shortBytes.length),
  ]);
  const directory = join(basePath, (await readdir(basePath))[0]);
  await writeFile(join(directory, "changes.json"), residue);
  return { stored, directory };
}

test("boots through a crash-damaged changes file instead of failing every run", async () => {
  // The rxdb-premium patch salvages the complete leading bulk; this pins
  // that the patched storage behind the wrapper boots and serves reads.
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-changes-residue-"));
  const long = { ...document("order:long", 0), value: "x".repeat(400) };
  const short = { ...document("order:short", 1), value: "y" };
  const capture = captureRecoveryEvents();

  try {
    const { directory } = await seedOverwriteResidue(basePath, long, short);

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("residue-recovering"));
    const documents = await Promise.race([
      recovering.findDocumentsById([long.id, short.id], false),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("boot read never settled")),
          3000,
        );
        timer.unref();
      }),
    ]);
    assert.deepEqual(
      documents.map((item) => [item.id, item.value]),
      [
        [long.id, long.value],
        [short.id, "from-wal"],
      ],
    );
    assert.equal(capture.events.length, 1);
    assert.equal(capture.events[0].kind, "changes-file-salvage");
    assert.equal(capture.events[0].keptBulks, 1);
    assert.equal((await readFile(join(directory, "changes.json"))).length, 0);
    await recovering.close();
  } finally {
    capture.stop();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("strips a stale previous from a write after an earlier read dropped the row", async () => {
  // The row goes in a read; the write that follows still carries `previous`
  // and skips the preflight because the read verified the id as clean. The
  // storage treats it as an insert either way — but with `previousDocumentData`
  // on the event, its index code looks the previous key up, finds nothing,
  // and operates at position -1: the document ends up in no index and a
  // sibling's row can be spliced away.
  const basePath = await mkdtemp(
    join(tmpdir(), "wcpos-hollow-read-then-write-"),
  );
  const hollow = document("order:hollow", 0);
  const sibling = document("order:sibling", 1);
  const third = document("order:third", 2);
  const capture = captureRecoveryEvents();
  const rebuilds = [];
  globalThis.__wcposOnIndexRebuild = (event) => rebuilds.push(event);

  try {
    await (
      await seedCompacted(basePath, [hollow, sibling, third], "rtw-seed")
    ).close();
    await corruptRecordInPlace(basePath, hollow.id, () => Buffer.alloc(0));

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("rtw-recovering"));
    assert.deepEqual(await recovering.findDocumentsById([hollow.id], true), []);
    assert.deepEqual(
      capture.events.map((event) => event.kind),
      ["hollow-row-dropped"],
    );
    const updated = {
      ...hollow,
      value: "written-after-read-drop",
      _rev: "2-hollow",
      _meta: { lwt: hollow._meta.lwt + 100 },
    };
    const written = await recovering.bulkWrite(
      [{ previous: hollow, document: updated }],
      "update",
    );
    assert.deepEqual(written.error, []);
    const query = prepareQuery(
      schema,
      normalizeMangoQuery(schema, {
        selector: {},
        sort: [{ id: "asc" }],
      }),
    );
    assert.deepEqual(
      (await recovering.query(query)).documents.map((item) => [
        item.id,
        item.value,
      ]),
      [
        [hollow.id, "written-after-read-drop"],
        [sibling.id, sibling.value],
        [third.id, third.value],
      ],
    );
    const state = await recovering.internals.statePromise;
    for (const indexState of state.indexStates) {
      assert.equal(
        indexState.rows.length,
        3,
        "every index holds every document",
      );
      assert.equal(
        indexState.rows.filter((row) => row[0].includes(hollow.id)).length,
        1,
      );
    }
    await recovering.close();

    // Persisted cleanly: the next open needs no rebuild.
    const reopened = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("rtw-reopened"));
    assert.deepEqual(
      (await reopened.query(query)).documents.map((item) => item.id),
      [hollow.id, sibling.id, third.id],
    );
    assert.deepEqual(rebuilds, []);
    await reopened.close();
  } finally {
    delete globalThis.__wcposOnIndexRebuild;
    capture.stop();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("replays crash residue before a write when the first operation after boot is a write", async () => {
  // The storage skips its replay hook ahead of a small write touching
  // nothing yet touched in its run, and that write would then land at offset
  // 0 over the residue. Through the wrapper a fresh instance's first write is
  // preceded by its own preflight read, whose run replays the file first.
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-write-first-"));
  const long = { ...document("order:long", 0), value: "x".repeat(400) };
  const short = { ...document("order:short", 1), value: "y" };
  const capture = captureRecoveryEvents();

  try {
    const { stored, directory } = await seedOverwriteResidue(
      basePath,
      long,
      short,
    );
    const storedLong = stored.find((item) => item.id === long.id);

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("write-first-recovering"));
    const written = await recovering.bulkWrite(
      [
        {
          previous: storedLong,
          document: {
            ...storedLong,
            value: "first-write",
            _rev: "3-long",
            _meta: { lwt: storedLong._meta.lwt + 2000 },
          },
        },
      ],
      "first-op",
    );
    assert.deepEqual(written.error, []);
    assert.deepEqual(
      (await recovering.findDocumentsById([long.id, short.id], false)).map(
        (item) => [item.id, item.value],
      ),
      [
        [long.id, "first-write"],
        [short.id, "from-wal"],
      ],
    );
    assert.deepEqual(
      capture.events.map((event) => [event.kind, event.keptBulks]),
      [["changes-file-salvage", 1]],
    );
    assert.equal((await readFile(join(directory, "changes.json"))).length, 0);
    await recovering.close();
  } finally {
    capture.stop();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("refuses to drop a hollow row when the storage is multi-instance", async () => {
  // The drop is a positional changelog operation; two peers detecting the
  // same hollow row would each apply the other's "D" over a healthy
  // neighbour. Under multi-instance the id is refused and never cached as
  // verified, exactly like the byte-range repairs above.
  const state = {
    firstIdx: {
      metaIdMap: new Map([["order:hollow", ["0order:hollow", 0, 0]]]),
    },
    indexStates: [],
  };
  let dropped = 0;
  const instance = {
    primaryPath: "id",
    findDocumentsById: async () => "[]",
    bulkWrite: async () => ({ error: [] }),
    query: async () => JSON.stringify({ documents: [] }),
    getChangedDocumentsSince: async () => JSON.stringify({ documents: [] }),
    internals: { statePromise: Promise.resolve(state) },
    taskQueue: {
      runCleanup: async (operation) => {
        dropped += 1;
        return operation({ accessHandlers: new Map() });
      },
    },
  };
  const capture = captureRecoveryEvents();
  try {
    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery({
      createStorageInstance: async () => instance,
    }).createStorageInstance({
      ...storageParams("multi-instance-hollow"),
      multiInstance: true,
    });
    assert.deepEqual(
      JSON.parse(await recovering.findDocumentsById(["order:hollow"], true)),
      [],
    );
    assert.deepEqual(
      (
        await recovering.bulkWrite(
          [{ document: document("order:hollow", 0) }],
          "w",
        )
      ).error,
      [],
    );
    assert.deepEqual(
      (
        await recovering.bulkWrite(
          [{ document: document("order:hollow", 1) }],
          "w-again",
        )
      ).error,
      [],
    );
    assert.equal(dropped, 0);
    assert.ok(state.firstIdx.metaIdMap.has("order:hollow"));
    assert.deepEqual(
      capture.events.map((event) => [event.kind, event.reason]),
      [
        ["hollow-row-refused", "multi-instance"],
        ["hollow-row-refused", "multi-instance"],
        ["hollow-row-refused", "multi-instance"],
      ],
    );
  } finally {
    capture.stop();
  }
});

test("serves the healthy copy when a foreign row holds a stale revision of a requested document", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-stale-foreign-"));
  const shifted = document("order:shifted", 0);
  const victim = document("order:victim", 1);
  const capture = captureRecoveryEvents();

  try {
    await (
      await seedCompacted(basePath, [shifted, victim], "stale-seed")
    ).close();
    // Overwrite order:shifted's own bytes with a STALE revision of
    // order:victim: the storage then serves that copy under victim's id from
    // shifted's row, ahead of the healthy copy at victim's own row.
    const staleVictim = {
      ...victim,
      value: "stale",
      _meta: { lwt: victim._meta.lwt - 50 },
    };
    await corruptRecordInPlace(basePath, shifted.id, () =>
      Buffer.from(JSON.stringify(staleVictim)),
    );

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("stale-recovering"));
    assert.deepEqual(
      (await recovering.findDocumentsById([shifted.id, victim.id], true)).map(
        (item) => [item.id, item.value],
      ),
      [[victim.id, victim.value]],
      "the stale foreign copy must not shadow the healthy one",
    );
    assert.deepEqual(
      capture.events.map((event) => [event.kind, event.id, event.reason]),
      [["hollow-row-refused", shifted.id, "range-holds-foreign-bytes"]],
    );
    await recovering.close();
  } finally {
    capture.stop();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("filters the post-repair retry like the first read", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-retry-filter-"));
  const broken = document("order:broken", 0);
  const shifted = document("order:shifted", 1);
  const victim = document("order:victim", 2);
  const capture = captureRecoveryEvents();

  try {
    await (
      await seedCompacted(basePath, [broken, shifted, victim], "retry-seed")
    ).close();
    // One repairable malformed record (so the combined read throws and the
    // retry path runs) beside one foreign row serving victim's stale bytes.
    await corruptRecord(basePath, broken.id);
    const staleVictim = {
      ...victim,
      value: "stale",
      _meta: { lwt: victim._meta.lwt - 50 },
    };
    await corruptRecordInPlace(basePath, shifted.id, () =>
      Buffer.from(JSON.stringify(staleVictim)),
    );

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("retry-recovering"));
    assert.deepEqual(
      (
        await recovering.findDocumentsById(
          [broken.id, shifted.id, victim.id],
          true,
        )
      )
        .map((item) => [item.id, item.value])
        .sort(),
      [
        [broken.id, broken.value],
        [victim.id, victim.value],
      ],
      "the retry returns each requested id at most once, from its own row",
    );
    assert.ok(
      capture.events.some(
        (event) =>
          event.kind === "hollow-row-refused" &&
          event.reason === "range-holds-foreign-bytes",
      ),
    );
    await recovering.close();
  } finally {
    capture.stop();
    await rm(basePath, { recursive: true, force: true });
  }
});

// The live corruption shape: the primary index lost one id (an applied
// changelog delete) while its secondary rows survived (their deletes were
// lost). A bare row-count mismatch is rebuilt from documents.json at boot,
// so the shape that actually REACHES the write path drops a different id
// from every secondary — equal counts, differing id sets, which the boot
// check cannot see and reconciliation refuses to rebuild.
async function orphanPrimaryRow(basePath, orphanId, siblingId) {
  const directory = join(basePath, (await readdir(basePath))[0]);
  const indexNames = (await readdir(directory))
    .filter((name) => name.startsWith("index-"))
    .sort();
  // index-00000 backs the primary metaIdMap; every later file is a
  // secondary (the schema's declared index plus premium's internal ones).
  for (const [position, name] of indexNames.entries()) {
    const removedId = position === 0 ? orphanId : siblingId;
    const indexPath = join(directory, name);
    const rows = JSON.parse(await readFile(indexPath, "utf8"));
    const remaining = rows.filter((row) => !row[0].includes(removedId));
    assert.equal(
      rows.length - remaining.length,
      1,
      `one row for ${removedId} in ${name}`,
    );
    await writeFile(indexPath, JSON.stringify(remaining));
  }
}

test("drops a stale secondary survivor before a stripped write lands as an insert", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "wcpos-stale-secondary-"));
  const orphan = document("order:orphan", 0);
  const sibling = document("order:sibling", 1);
  const capture = captureRecoveryEvents();

  try {
    await (
      await seedCompacted(basePath, [orphan, sibling], "survivor-seed")
    ).close();
    await orphanPrimaryRow(basePath, orphan.id, sibling.id);

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance(storageParams("survivor-recovering"));
    const updated = {
      ...orphan,
      value: "reinserted",
      _rev: "2-orphan",
      _meta: { lwt: orphan._meta.lwt + 100 },
    };
    const written = await recovering.bulkWrite(
      [{ previous: orphan, document: updated }],
      "update",
    );
    assert.deepEqual(written.error, []);
    assert.deepEqual(capture.events, [
      {
        kind: "stale-secondary-dropped",
        target: "targeted-recovery-db/products",
        id: orphan.id,
      },
    ]);
    assert.deepEqual(
      (await recovering.findDocumentsById([orphan.id, sibling.id], false)).map(
        (item) => [item.id, item.value],
      ),
      [
        [orphan.id, "reinserted"],
        [sibling.id, sibling.value],
      ],
    );
    const state = await recovering.internals.statePromise;
    for (const indexState of state.indexStates) {
      assert.equal(
        indexState.rows.filter((row) => row[0].includes(orphan.id)).length,
        1,
        "exactly one row per index for the re-inserted document",
      );
    }
    await recovering.close();

    const reopened = await getRxStorageFilesystemNode({
      basePath,
    }).createStorageInstance(storageParams("survivor-reopened"));
    const persisted = await reopened.internals.statePromise;
    for (const indexState of persisted.indexStates) {
      assert.equal(
        indexState.rows.filter((row) => row[0].includes(orphan.id)).length,
        1,
      );
    }
    await reopened.close();
  } finally {
    capture.stop();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("refuses a stripped write over a stale secondary survivor when multi-instance", async () => {
  const basePath = await mkdtemp(
    join(tmpdir(), "wcpos-stale-secondary-multi-"),
  );
  const orphan = document("order:orphan", 0);
  const sibling = document("order:sibling", 1);
  const capture = captureRecoveryEvents();

  try {
    await (
      await seedCompacted(basePath, [orphan, sibling], "survivor-multi-seed")
    ).close();
    await orphanPrimaryRow(basePath, orphan.id, sibling.id);

    const { withTargetedOpfsRecovery } =
      await import("./opfs-targeted-recovery.mjs");
    const recovering = await withTargetedOpfsRecovery(
      getRxStorageFilesystemNode({ basePath }),
    ).createStorageInstance({
      ...storageParams("survivor-multi"),
      multiInstance: true,
    });
    await assert.rejects(
      recovering.bulkWrite(
        [
          {
            previous: orphan,
            document: {
              ...orphan,
              value: "reinserted",
              _rev: "2-orphan",
              _meta: { lwt: orphan._meta.lwt + 100 },
            },
          },
        ],
        "update",
      ),
      /stale secondary index rows for order:orphan .*targeted recovery refused: multi-instance/,
    );
    assert.deepEqual(capture.events, [
      {
        kind: "stale-secondary-refused",
        target: "targeted-recovery-db/products",
        id: orphan.id,
        reason: "multi-instance",
      },
    ]);
    // The survivors are left untouched for a future single-instance repair:
    // every secondary still holds its stale row for the id.
    const state = await recovering.internals.statePromise;
    for (const indexState of state.indexStates) {
      assert.equal(
        indexState.rows.filter((row) => row[0].includes(orphan.id)).length,
        indexState === state.firstIdx ? 0 : 1,
      );
    }
    await recovering.close();
  } finally {
    capture.stop();
    await rm(basePath, { recursive: true, force: true });
  }
});

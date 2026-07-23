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
  assert.match(errors[0][0], /^\[count-recovery\].*collection=products$/);
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

test("refuses a rebuild when the primary index is missing rows", async () => {
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
    await assert.rejects(recovering.query(betaQuery), {
      name: "SyntaxError",
      message: /index reconciliation refused: id-set-mismatch:lane:ccc$/,
    });
    await recovering.close();
  } finally {
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

test("refuses a rebuild when the primary index holds duplicate IDs", async () => {
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
    await assert.rejects(recovering.query(betaQuery), {
      name: "SyntaxError",
      message: /index reconciliation refused: duplicate-primary-id:lane:aaa$/,
    });
    await recovering.close();
  } finally {
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

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { getIndexableStringMonad } from "rxdb/plugins/core";

import { withTargetedOpfsRecovery } from "./opfs-targeted-recovery.mjs";

const SCHEMA = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 4 },
    name: { type: "string", maxLength: 4 },
    _deleted: { type: "boolean" },
    _meta: {
      type: "object",
      properties: {
        lwt: {
          type: "number",
          minimum: 1,
          maximum: 1000000000000000,
          multipleOf: 0.01,
        },
      },
    },
  },
};

/**
 * A miniature of the rxdb-premium abstract-filesystem storage: a documents byte
 * buffer plus index rows of `[indexableString, start, end]`.
 *
 The index set is the one production actually builds. RxDB's
 * `fillWithDefaultSettings` prefixes `_deleted` to every schema index, and
 * premium's `getIndexesFromSchema` then appends `['_meta.lwt', primaryPath]`
 * and the cleanup index — verified against the installed packages:
 *
 *   [["_deleted","name","id"], ["_meta.lwt","id"], ["_deleted","_meta.lwt","id"]]
 *
 * That is why `indexStates[0]` is `_deleted`-first, and why the production
 * stack throws reading `_deleted` rather than `_meta`.
 *
 * `cleanup` reproduces `cleanupDocumentJsonFile` (rxdb-premium 17.4.0,
 * plugins/storage-abstract-filesystem/cleanup.js): it walks the two-element
 * `_meta.lwt` index in row order, skips any row already flush against the write
 * cursor (`w === g`), and for a row preceded by a gap reads the bytes, parses
 * them as a JSON array, takes element 0 and feeds it to
 * `changeDocumentPosition` -> `getIndexableString` for every index. It returns
 * `false` while it is still relocating documents, matching the real contract.
 *
 * A row whose bytes are whitespace parses to `[]`, so element 0 is `undefined`
 * and the index-key derivation throws `TypeError: Cannot read properties of
 * undefined (reading '_deleted')`. That is the shape observed in production;
 * the gap that makes premium look at the row at all is modelled here rather
 * than assumed.
 */
function createFakeOpfsInstance({ documents, corruptId, gapBefore }) {
  const indexes = [
    ["_deleted", "name", "id"],
    ["_meta.lwt", "id"],
    ["_deleted", "_meta.lwt", "id"],
  ];
  let cursor = 0;
  const chunks = [];
  const positions = new Map();
  for (const document of documents) {
    if (document.id === gapBefore) {
      // Dead space left by an earlier compaction — this is what makes premium
      // relocate the next row instead of skipping it.
      chunks.push(Buffer.alloc(8, 0x20));
      cursor += 8;
    }
    const encoded = Buffer.from(JSON.stringify(document));
    const bytes =
      document.id === corruptId
        ? Buffer.alloc(encoded.byteLength, 0x20)
        : encoded;
    chunks.push(bytes);
    positions.set(document.id, [cursor, cursor + bytes.byteLength]);
    cursor += bytes.byteLength;
  }
  const documentBytes = Buffer.concat(chunks);

  const indexStates = indexes.map((index, indexId) => {
    const getIndexableString = getIndexableStringMonad(SCHEMA, index);
    return {
      indexId,
      getIndexableString,
      rows: documents
        .map((document) => [
          getIndexableString(document),
          ...positions.get(document.id),
        ])
        .sort((left, right) => (left[0] < right[0] ? -1 : 1)),
      runChangelogOperation([, position, operation]) {
        assert.equal(operation, "D");
        this.rows.splice(position, 1);
      },
    };
  });
  // The real function selects the two-element `['_meta.lwt', primaryPath]`
  // index as the compaction driver, not `indexStates[0]`.
  const lwtIndex =
    indexStates[
      indexes.findIndex(
        (index) =>
          index.length === 2 && index[0] === "_meta.lwt" && index[1] === "id",
      )
    ];

  const changelogOperations = [];
  const accessHandle = {
    read: async (start, end) => documentBytes.subarray(start, end),
  };

  return {
    changelogOperations,
    indexStates,
    instance: {
      primaryPath: "id",
      findDocumentsById: async () => "[]",
      bulkWrite: async () => ({ error: [] }),
      query: async () => JSON.stringify({ documents: [] }),
      getChangedDocumentsSince: async () => JSON.stringify({ documents: [] }),
      cleanup: async () => {
        let writeCursor = 0;
        let relocated = 0;
        for (const [, start, end] of lwtIndex.rows) {
          if (start === writeCursor) {
            writeCursor = end;
            continue;
          }
          const document = JSON.parse(
            `[${documentBytes.subarray(start, end).toString()}]`,
          )[0];
          for (const indexState of indexStates) {
            indexState.getIndexableString(document);
          }
          relocated += 1;
          writeCursor += end - start;
        }
        // Premium reports "not done" while it is still moving documents.
        return relocated === 0;
      },
      internals: {
        statePromise: Promise.resolve({
          documentFileHandle: { createAccessHandle: async () => accessHandle },
          indexStates,
          changelog: {
            addChangelogOperations: async (_runState, operations) => {
              changelogOperations.push(...operations);
            },
          },
        }),
      },
      taskQueue: {
        runCleanup: async (operation) =>
          operation({ accessHandlers: new Map() }),
      },
      _decode: (bytes) => bytes.toString(),
    },
  };
}

const DOCUMENTS = [
  { id: "aaa", name: "a", _deleted: false, _meta: { lwt: 100 } },
  { id: "bbb", name: "b", _deleted: false, _meta: { lwt: 200 } },
  { id: "ccc", name: "c", _deleted: false, _meta: { lwt: 300 } },
];

test("recovers the cleanup storm: a whitespace row is dropped and cleanup retried", async () => {
  const { instance, indexStates, changelogOperations } = createFakeOpfsInstance(
    {
      documents: DOCUMENTS,
      corruptId: "bbb",
      gapBefore: "bbb",
    },
  );

  // Guard the premise: the modelled path produces the exact production error.
  await assert.rejects(
    () => instance.cleanup(0),
    (error) =>
      error instanceof TypeError &&
      /reading '_deleted'/.test(error.message) === true,
  );

  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance({ multiInstance: false });

  // Recovery makes the retry complete instead of throwing. It reports `false`
  // — the real "still relocating, call me again" signal — which is exactly why
  // the containment in wrapped-error-handler-storage must not read a `false`
  // as a completed round.
  assert.equal(await recovering.cleanup(0), false);

  // The dangling pointer is gone from every index — one delete per index — and
  // the two surviving documents are untouched.
  for (const indexState of indexStates) {
    assert.equal(indexState.rows.length, 2);
  }
  assert.equal(changelogOperations.length, indexStates.length);

  // The damage is repaired, not merely survived: the raw storage no longer
  // throws on the row that poisoned the cleanup queue.
  await assert.doesNotReject(() => recovering.cleanup(0));
});

test("recovers and broadcasts whitespace-row drops in multi-instance mode", async () => {
  const { instance, indexStates, changelogOperations } = createFakeOpfsInstance(
    {
      documents: DOCUMENTS,
      corruptId: "bbb",
      gapBefore: "bbb",
    },
  );
  const broadcastMessages = [];
  const state = await instance.internals.statePromise;
  state.params = { databaseName: "scope-db", collectionName: "orders" };
  state.broadcastChannel = {
    postMessage: (message) => broadcastMessages.push(message),
  };
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance({ multiInstance: true });

  assert.equal(await recovering.cleanup(0), false);
  for (const indexState of indexStates) {
    assert.equal(indexState.rows.length, 2);
  }
  assert.equal(broadcastMessages.length, changelogOperations.length);
  assert.deepEqual(
    broadcastMessages.map((message) => message.changelogOperations[0]),
    changelogOperations,
  );
  assert.deepEqual(broadcastMessages[0].info, {
    db: "scope-db",
    col: "orders",
  });
});

test("propagates the retry error and reports the initial cleanup error", async () => {
  const initialError = new Error("initial cleanup failure");
  const retryError = new Error("retry cleanup failure");
  let cleanupCalls = 0;
  const documentFileHandle = {
    createAccessHandle: async () => ({ read: async () => Buffer.alloc(0) }),
  };
  const instance = {
    primaryPath: "id",
    findDocumentsById: async () => "[]",
    bulkWrite: async () => ({ error: [] }),
    query: async () => JSON.stringify({ documents: [] }),
    getChangedDocumentsSince: async () => JSON.stringify({ documents: [] }),
    cleanup: async () => {
      cleanupCalls += 1;
      throw cleanupCalls === 1 ? initialError : retryError;
    },
    internals: {
      statePromise: Promise.resolve({
        documentFileHandle,
        indexStates: [],
      }),
    },
    taskQueue: {
      runCleanup: async (operation) =>
        operation({
          accessHandlers: new Map(),
        }),
    },
    _decode: (bytes) => bytes.toString(),
  };
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance({ multiInstance: false });
  const originalConsoleError = console.error;
  const originalRecoveryHook = globalThis.__wcposOnStorageRecovery;
  let recoveryEvent;
  console.error = () => {};
  globalThis.__wcposOnStorageRecovery = (event) => {
    recoveryEvent = event;
  };

  try {
    await assert.rejects(
      () => recovering.cleanup(0),
      (error) => error === retryError,
    );
  } finally {
    console.error = originalConsoleError;
    globalThis.__wcposOnStorageRecovery = originalRecoveryHook;
  }
  assert.equal(cleanupCalls, 2);
  assert.equal(recoveryEvent.error, retryError);
  assert.equal(recoveryEvent.initialError, "Error: initial cleanup failure");
});

for (const collectionName of ["logs", "orders"]) {
  for (const reason of ["no-valid-document", "range-holds-foreign-bytes"]) {
    test(`${collectionName}: ${reason} ${collectionName === "logs" ? "discards" : "preserves"} the row`, async () => {
      const id = "damaged";
      const bytes = Buffer.from(
        reason === "no-valid-document" ? "{junk" : '{"id":"foreign"}',
      );
      const operations = [];
      const events = [];
      // In the foreign-bytes case the range belongs to a healthy sibling
      // ("foreign") whose own rows share the damaged row's offsets and sort
      // first: a discard must remove "damaged" by identity and leave the
      // sibling standing (an offset lookup would take the sibling instead).
      const ids =
        reason === "range-holds-foreign-bytes" ? ["foreign", id] : [id];
      const indexes = ["primary", "secondary"].map((indexId) => ({
        indexId,
        primaryKeyLength: id.length,
        rows: ids.map((rowId) => [`0${rowId}`, 0, bytes.length]),
        metaIdMap: new Map(
          ids.map((rowId) => [rowId, [`0${rowId}`, 0, bytes.length]]),
        ),
        runChangelogOperation([, position]) {
          const [row] = this.rows.splice(position, 1);
          this.metaIdMap.delete(row[0].slice(1));
        },
      }));
      const state = {
        firstIdx: indexes[0],
        indexStates: indexes,
        documentFileHandle: {
          createAccessHandle: async () => ({ read: async () => bytes }),
        },
        changelog: {
          addChangelogOperations: async (_, ops) => operations.push(...ops),
        },
      };
      const instance = {
        primaryPath: "id",
        findDocumentsById: async () =>
          indexes[0].rows.length ? `[${bytes}]` : "[]",
        bulkWrite: async () => ({ error: [] }),
        query: async () => ({ documents: [] }),
        getChangedDocumentsSince: async () => ({ documents: [] }),
        cleanup: async () => {
          if (indexes[0].rows.length) JSON.parse(bytes.toString());
          return true;
        },
        internals: { statePromise: Promise.resolve(state) },
        taskQueue: {
          runCleanup: async (operation) =>
            operation({ accessHandlers: new Map() }),
        },
        _decode: (value) => value.toString(),
      };
      const recovering = await withTargetedOpfsRecovery({
        createStorageInstance: async () => instance,
      }).createStorageInstance({
        databaseName: "store_v6_test",
        collectionName,
        multiInstance: false,
      });
      const previousHook = globalThis.__wcposOnStorageRecovery;
      globalThis.__wcposOnStorageRecovery = (event) => events.push(event);
      try {
        if (reason === "range-holds-foreign-bytes") {
          await recovering.findDocumentsById([id], true);
        } else if (collectionName === "orders") {
          await assert.rejects(
            recovering.cleanup(0),
            /targeted recovery failed for damaged: no-valid-document/,
          );
        } else {
          assert.equal(await recovering.cleanup(0), true);
        }
        const sibling = ids.length - 1;
        for (const index of indexes) {
          assert.equal(
            index.rows.length,
            collectionName === "logs" ? sibling : sibling + 1,
          );
          assert.equal(index.metaIdMap.has(id), collectionName !== "logs");
          assert.equal(
            index.metaIdMap.has("foreign"),
            sibling === 1,
            "the healthy sibling sharing the range is never touched",
          );
        }
        assert.equal(operations.length, collectionName === "logs" ? 2 : 0);
        if (collectionName === "logs") {
          assert.ok(operations.every((operation) => operation[2] === "D"));
          assert.deepEqual(events, [
            {
              kind: "log-row-discarded",
              target: "store_v6_test/logs",
              id,
              reason,
            },
          ]);
        } else if (reason === "range-holds-foreign-bytes") {
          assert.ok(
            events.some(
              (event) =>
                event.kind === "hollow-row-refused" && event.reason === reason,
            ),
          );
        }
      } finally {
        globalThis.__wcposOnStorageRecovery = previousHook;
      }
    });
  }
}

test("drops every index row sharing one whitespace range, not just the first", async () => {
  // Damage can leave two ids pointing at the same hollow range; recovering
  // one of them must clear both rows or the survivor fails the next read.
  const bytes = Buffer.from("        ");
  const ids = ["first", "second"];
  const operations = [];
  const indexes = ["primary", "secondary"].map((indexId) => ({
    indexId,
    primaryKeyLength: 6,
    rows: ids.map((rowId) => [`0${rowId}`, 0, bytes.length]),
    metaIdMap: new Map(
      ids.map((rowId) => [rowId, [`0${rowId}`, 0, bytes.length]]),
    ),
    runChangelogOperation([, position]) {
      const [row] = this.rows.splice(position, 1);
      this.metaIdMap.delete(row[0].slice(1));
    },
  }));
  const state = {
    firstIdx: indexes[0],
    indexStates: indexes,
    documentFileHandle: {
      createAccessHandle: async () => ({ read: async () => bytes }),
    },
    changelog: {
      addChangelogOperations: async (_, ops) => operations.push(...ops),
    },
  };
  const instance = {
    primaryPath: "id",
    findDocumentsById: async () => "[]",
    bulkWrite: async () => ({ error: [] }),
    query: async () => ({ documents: [] }),
    getChangedDocumentsSince: async () => ({ documents: [] }),
    cleanup: async () => true,
    internals: { statePromise: Promise.resolve(state) },
    taskQueue: {
      runCleanup: async (operation) => operation({ accessHandlers: new Map() }),
    },
    _decode: (value) => value.toString(),
  };
  const recovering = await withTargetedOpfsRecovery({
    createStorageInstance: async () => instance,
  }).createStorageInstance({
    databaseName: "store_v6_test",
    collectionName: "orders",
    multiInstance: false,
  });
  const previousHook = globalThis.__wcposOnStorageRecovery;
  globalThis.__wcposOnStorageRecovery = () => {};
  try {
    // Reading only "first" finds it hollow and drops its range.
    await recovering.findDocumentsById(["first"], true);
    for (const index of indexes) {
      assert.equal(
        index.rows.length,
        0,
        `${index.indexId}: no row left on the range`,
      );
    }
    assert.equal(
      operations.filter((operation) => operation[2] === "D").length,
      4,
    );
  } finally {
    globalThis.__wcposOnStorageRecovery = previousHook;
  }
});

for (const owner of [false, true, "revoked in lock"]) {
  test(`hollow-row read drops and broadcasts only for sole repair owner: ${owner}`, async () => {
    const { instance, indexStates, changelogOperations } =
      createFakeOpfsInstance({
        documents: DOCUMENTS,
        corruptId: "bbb",
        gapBefore: "bbb",
      });
    const state = await instance.internals.statePromise;
    const firstIdx = indexStates[0];
    firstIdx.primaryKeyLength = 4;
    firstIdx.metaIdMap = new Map([["bbb", firstIdx.rows[1]]]);
    state.firstIdx = firstIdx;
    state.params = { databaseName: "scope-db", collectionName: "orders" };
    const broadcastMessages = [];
    state.broadcastChannel = {
      postMessage: (message) => broadcastMessages.push(message),
    };
    let owns = Boolean(owner);
    const runCleanup = instance.taskQueue.runCleanup;
    instance.taskQueue.runCleanup = (callback) =>
      runCleanup((runState) => {
        if (owner === "revoked in lock") owns = false;
        return callback(runState);
      });
    const events = [];
    const previousHook = globalThis.__wcposOnStorageRecovery;
    globalThis.__wcposOnStorageRecovery = (event) => events.push(event);
    const recovering = await withTargetedOpfsRecovery(
      { createStorageInstance: async () => instance },
      { ownsRepairs: () => owns },
    ).createStorageInstance({ ...state.params, multiInstance: true });
    try {
      await recovering.findDocumentsById(["bbb"], true);
    } finally {
      globalThis.__wcposOnStorageRecovery = previousHook;
    }
    if (!owns)
      assert.deepEqual(events, [
        {
          kind: "hollow-row-refused",
          target: "scope-db/orders",
          id: "bbb",
          reason: "multi-instance",
        },
      ]);
    for (const indexState of indexStates) {
      assert.equal(indexState.rows.length, owns ? 2 : 3);
    }
    assert.equal(changelogOperations.length, owns ? 3 : 0);
    assert.deepEqual(
      broadcastMessages.map((message) => message.changelogOperations[0]),
      changelogOperations,
    );
    if (owns)
      assert.deepEqual(broadcastMessages[0].info, {
        db: "scope-db",
        col: "orders",
      });
  });
}

test("recovers and broadcasts whitespace-row drops in multi-instance mode as sole repair owner", async () => {
  const { instance, indexStates, changelogOperations } = createFakeOpfsInstance(
    {
      documents: DOCUMENTS,
      corruptId: "bbb",
      gapBefore: "bbb",
    },
  );
  const broadcastMessages = [];
  const state = await instance.internals.statePromise;
  state.params = { databaseName: "scope-db", collectionName: "orders" };
  state.broadcastChannel = {
    postMessage: (message) => broadcastMessages.push(message),
  };
  const recovering = await withTargetedOpfsRecovery(
    { createStorageInstance: async () => instance },
    { ownsRepairs: () => true },
  ).createStorageInstance({ multiInstance: true });

  assert.equal(await recovering.cleanup(0), false);
  for (const indexState of indexStates) {
    assert.equal(indexState.rows.length, 2);
  }
  assert.equal(broadcastMessages.length, changelogOperations.length);
  assert.deepEqual(
    broadcastMessages.map((message) => message.changelogOperations[0]),
    changelogOperations,
  );
  assert.deepEqual(broadcastMessages[0].info, {
    db: "scope-db",
    col: "orders",
  });
});

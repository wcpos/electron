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
 * (Since `patch-rxdb-premium-cleanup-compaction-batch.mjs` the real function
 * relocates a whole batch per call and bakes the indexes in the same round; the
 * simulation models one relocation, which is all the damage shapes need.)
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
      primaryKeyLength: 4,
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
    getSize: async () => documentBytes.length,
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
          firstIdx: indexStates[0],
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

for (const ownership of ["absent", "revoked in lock"]) {
  test(`whitespace cleanup refuses when ownership is ${ownership}`, async () => {
    const { instance, indexStates, changelogOperations } =
      createFakeOpfsInstance({
        documents: DOCUMENTS,
        corruptId: "bbb",
        gapBefore: "bbb",
      });
    const state = await instance.internals.statePromise;
    const broadcasts = [];
    state.params = { databaseName: "scope-db", collectionName: "orders" };
    state.broadcastChannel = {
      postMessage: (message) => broadcasts.push(message),
    };
    let owns = ownership !== "absent";
    const runCleanup = instance.taskQueue.runCleanup;
    instance.taskQueue.runCleanup = (callback) =>
      runCleanup((runState) => {
        owns = false;
        return callback(runState);
      });
    const before = structuredClone(indexStates.map((index) => index.rows));
    const events = [];
    const previousHook = globalThis.__wcposOnStorageRecovery;
    globalThis.__wcposOnStorageRecovery = (event) => events.push(event);
    const recovering = await withTargetedOpfsRecovery(
      { createStorageInstance: async () => instance },
      { ownsRepairs: () => owns },
    ).createStorageInstance({ ...state.params, multiInstance: true });
    try {
      await assert.rejects(recovering.cleanup(0), /reading '_deleted'/);
    } finally {
      globalThis.__wcposOnStorageRecovery = previousHook;
    }
    assert.deepEqual(
      indexStates.map((index) => index.rows),
      before,
    );
    assert.deepEqual(changelogOperations, []);
    assert.deepEqual(broadcasts, []);
    assert.deepEqual(
      events.filter((event) => event.kind === "hollow-row-refused"),
      [
        {
          kind: "hollow-row-refused",
          target: "scope-db/orders",
          id: "bbb",
          reason: "multi-instance",
        },
      ],
    );
  });
}

test("propagates the retry error and reports the initial cleanup error", async () => {
  const initialError = new Error("initial cleanup failure");
  const retryError = new Error("retry cleanup failure");
  let cleanupCalls = 0;
  const documentFileHandle = {
    // Every range reads blank inside a file large enough to hold it.
    createAccessHandle: async () => ({
      read: async () => Buffer.alloc(0),
      getSize: async () => Number.MAX_SAFE_INTEGER,
    }),
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
          createAccessHandle: async () => ({
            read: async () => bytes,
            getSize: async () => bytes.length,
          }),
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
      createAccessHandle: async () => ({
        read: async () => bytes,
        getSize: async () => bytes.length,
      }),
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

test("a row truncated past EOF between its blank read and the drop is refused, and cleanup fails loudly", async () => {
  const { instance, indexStates, changelogOperations } = createFakeOpfsInstance(
    {
      documents: DOCUMENTS,
      corruptId: "bbb",
      gapBefore: "bbb",
    },
  );
  const state = await instance.internals.statePromise;
  const inner = await state.documentFileHandle.createAccessHandle();
  const fullSize = await inner.getSize();
  let bbbEnd;
  for (const [, start, end] of state.firstIdx.rows) {
    if ((await inner.read(start, end)).every((byte) => byte === 0x20))
      bbbEnd = end;
  }
  assert.ok(
    bbbEnd,
    "the fixture holds exactly the blank row this test truncates under",
  );
  // Another process truncates the file right after this one reads the blank
  // row: the size seen before the read still covered it, the size seen after
  // does not. Independent processes share no task queue.
  let lastReadBlank = false;
  state.documentFileHandle.createAccessHandle = async () => ({
    read: async (start, end) => {
      const bytes = await inner.read(start, end);
      lastReadBlank = bytes.every((byte) => byte === 0x20);
      return bytes;
    },
    getSize: async () => (lastReadBlank ? bbbEnd - 1 : fullSize),
  });
  const events = [];
  const previousHook = globalThis.__wcposOnStorageRecovery;
  globalThis.__wcposOnStorageRecovery = (event) => events.push(event);
  try {
    const recovering = await withTargetedOpfsRecovery({
      createStorageInstance: async () => instance,
    }).createStorageInstance({ multiInstance: false });
    await assert.rejects(() => recovering.cleanup(0), /range-past-eof/);
  } finally {
    globalThis.__wcposOnStorageRecovery = previousHook;
  }
  for (const indexState of indexStates) {
    assert.equal(indexState.rows.length, 3, "no row is dropped past EOF");
  }
  assert.deepEqual(changelogOperations, []);
  assert.deepEqual(
    events
      .filter((event) => event.kind === "hollow-row-refused")
      .map((event) => [event.id, event.reason]),
    [["bbb", "range-past-eof"]],
  );
  assert.ok(
    events.some((event) => event.kind === "cleanup-recovery"),
    "the failed round is reported, not retried into a bake of stale rows",
  );
});

// Index order and file order differ, so the scan meets a droppable blank row
// BEFORE the row that proves the index stale. Dropping as it goes would delete
// a live document's row and broadcast it; the refusal that follows cannot undo
// that. The whole scan is classified first, so nothing is dropped.
test("no row is dropped when a later row in the scan is past EOF", async () => {
  const documents = [
    // File order: the blank one first (compaction's fill over bytes the other
    // process already moved), the row that ends past EOF last.
    { id: "xxx", name: "z", _deleted: false, _meta: { lwt: 100 } },
    { id: "yyy", name: "a", _deleted: false, _meta: { lwt: 200 } },
    { id: "zzz", name: "b", _deleted: false, _meta: { lwt: 300 } },
  ];
  const { instance, indexStates, changelogOperations } = createFakeOpfsInstance(
    {
      documents,
      corruptId: "xxx",
      gapBefore: "xxx",
    },
  );
  const state = await instance.internals.statePromise;
  const inner = await state.documentFileHandle.createAccessHandle();
  const fullSize = await inner.getSize();
  // The other process compacted and truncated by one byte: this instance's
  // last row now ends past EOF.
  const truncatedSize = fullSize - 1;
  state.documentFileHandle.createAccessHandle = async () => ({
    read: async (start, end) => inner.read(start, end),
    getSize: async () => truncatedSize,
  });

  // Premise: index 0 is sorted by name, so the scan (descending) reaches the
  // blank row before the past-EOF one.
  const scan = [];
  for (
    let position = indexStates[0].rows.length - 1;
    position >= 0;
    position -= 1
  ) {
    const [, start, end] = indexStates[0].rows[position];
    const bytes = await inner.read(start, end);
    scan.push({
      position,
      blank: bytes.every((byte) => byte === 0x20),
      pastEof: end > truncatedSize,
    });
  }
  const firstBlank = scan.findIndex((entry) => entry.blank);
  const firstPastEof = scan.findIndex((entry) => entry.pastEof);
  assert.ok(
    firstBlank !== -1 && firstPastEof !== -1,
    "the fixture holds both shapes",
  );
  assert.ok(
    firstBlank < firstPastEof,
    `the droppable row must be scanned first: ${JSON.stringify(scan)}`,
  );

  const events = [];
  const previousHook = globalThis.__wcposOnStorageRecovery;
  globalThis.__wcposOnStorageRecovery = (event) => events.push(event);
  try {
    const recovering = await withTargetedOpfsRecovery({
      createStorageInstance: async () => instance,
    }).createStorageInstance({ multiInstance: false });
    await assert.rejects(() => recovering.cleanup(0), /range-past-eof/);
  } finally {
    globalThis.__wcposOnStorageRecovery = previousHook;
  }
  for (const indexState of indexStates) {
    assert.equal(
      indexState.rows.length,
      3,
      "every row survives the refused scan",
    );
  }
  assert.deepEqual(changelogOperations, [], "nothing is broadcast");
  assert.deepEqual(
    events.filter((event) => event.kind === "hollow-row-dropped"),
    [],
  );
  assert.ok(
    events.some(
      (event) =>
        event.kind === "hollow-row-refused" &&
        event.reason === "range-past-eof",
    ),
    "the refusal is reported by reason",
  );
});

// The read-repair path drops per id, so a batch holding a droppable blank row
// AND a row past EOF must refuse the whole batch: the blank range on a stale
// index is as likely to be compaction's fill over a document the other process
// already moved, and a drop is broadcast and cannot be taken back.
test("a hollow read batch drops nothing when one of its rows is past EOF", async () => {
  const bytes = Buffer.from("        ");
  const ids = ["first", "second"];
  const operations = [];
  // "first" is blank and inside the file; "second" ends past EOF.
  const ranges = new Map([
    ["first", [0, bytes.length]],
    ["second", [bytes.length, bytes.length + 8]],
  ]);
  const indexes = ["primary", "secondary"].map((indexId) => ({
    indexId,
    primaryKeyLength: 6,
    rows: ids.map((rowId) => [`0${rowId}`, ...ranges.get(rowId)]),
    metaIdMap: new Map(
      ids.map((rowId) => [rowId, [`0${rowId}`, ...ranges.get(rowId)]]),
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
      createAccessHandle: async () => ({
        read: async (start, end) => bytes.subarray(start, end),
        getSize: async () => bytes.length,
      }),
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
  const events = [];
  const previousHook = globalThis.__wcposOnStorageRecovery;
  globalThis.__wcposOnStorageRecovery = (event) => events.push(event);
  try {
    await assert.rejects(
      recovering.findDocumentsById(ids, true),
      /range-past-eof/,
    );
  } finally {
    globalThis.__wcposOnStorageRecovery = previousHook;
  }
  for (const index of indexes) {
    assert.equal(index.rows.length, 2, `${index.indexId}: both rows survive`);
  }
  assert.deepEqual(operations, [], "nothing is broadcast");
  assert.deepEqual(
    events.filter((event) => event.kind === "hollow-row-dropped"),
    [],
  );
  assert.deepEqual(
    events
      .filter((event) => event.kind === "hollow-row-refused")
      .map((event) => [event.id, event.reason])
      .sort(),
    [
      ["first", "range-past-eof"],
      ["second", "range-past-eof"],
    ],
  );
});

// A stale SECONDARY row is proof of a stale index too, and the read path only
// ever looks at the primary row. The primary here is blank and inside the
// file — ordinarily droppable — while the id's secondary row ends past EOF.
test("a hollow read drops nothing when the id's secondary row is past EOF", async () => {
  const bytes = Buffer.from("        ");
  const operations = [];
  const indexes = ["primary", "secondary"].map((indexId) => ({
    indexId,
    primaryKeyLength: 5,
    // The secondary row points past the end of the file; the primary does not.
    rows: [
      indexId === "primary"
        ? ["0alpha", 0, bytes.length]
        : ["0alpha", bytes.length, bytes.length + 8],
    ],
    metaIdMap: new Map([["alpha", ["0alpha", 0, bytes.length]]]),
    runChangelogOperation([, position]) {
      const [row] = this.rows.splice(position, 1);
      this.metaIdMap.delete(row[0].slice(1));
    },
  }));
  const state = {
    firstIdx: indexes[0],
    indexStates: indexes,
    documentFileHandle: {
      createAccessHandle: async () => ({
        read: async (start, end) => bytes.subarray(start, end),
        getSize: async () => bytes.length,
      }),
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
  const events = [];
  const previousHook = globalThis.__wcposOnStorageRecovery;
  globalThis.__wcposOnStorageRecovery = (event) => events.push(event);
  try {
    await assert.rejects(
      recovering.findDocumentsById(["alpha"], true),
      /range-past-eof/,
    );
  } finally {
    globalThis.__wcposOnStorageRecovery = previousHook;
  }
  assert.equal(indexes[0].rows.length, 1, "the primary row survives");
  assert.deepEqual(operations, [], "nothing is broadcast");
  assert.deepEqual(
    events.filter((event) => event.kind === "hollow-row-dropped"),
    [],
  );
});

// The write-path exemption drops a past-EOF row and reinserts the document it
// carries. Two ids can share one range, and the retry carries only one of
// them, so the drop must go by identity or the other document is lost.
test("a write repairing a past-EOF range drops only the written id's rows", async () => {
  const bytes = Buffer.from("        ");
  const range = [bytes.length, bytes.length + 8]; // past EOF for both ids
  const ids = ["aaaaa", "bbbbb"];
  const operations = [];
  const indexes = ["primary", "secondary"].map((indexId) => ({
    indexId,
    primaryKeyLength: 5,
    rows: ids.map((rowId) => [`0${rowId}`, ...range]),
    metaIdMap: new Map(ids.map((rowId) => [rowId, [`0${rowId}`, ...range]])),
    runChangelogOperation([, position]) {
      const [row] = this.rows.splice(position, 1);
      this.metaIdMap.delete(row[0].slice(1));
    },
  }));
  const state = {
    firstIdx: indexes[0],
    indexStates: indexes,
    documentFileHandle: {
      createAccessHandle: async () => ({
        read: async (start, end) => bytes.subarray(start, end),
        getSize: async () => bytes.length,
      }),
    },
    changelog: {
      addChangelogOperations: async (_, ops) => operations.push(...ops),
    },
  };
  let rawWrites = 0;
  const instance = {
    primaryPath: "id",
    // The preflight read is malformed, which is what sends the write into the
    // repair; the retry then succeeds.
    findDocumentsById: async () => {
      throw new SyntaxError(
        'Unexpected token \u0000, "[\u0000\u0000" is not valid JSON',
      );
    },
    bulkWrite: async () => {
      rawWrites += 1;
      return { error: [] };
    },
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
  const events = [];
  const previousHook = globalThis.__wcposOnStorageRecovery;
  globalThis.__wcposOnStorageRecovery = (event) => events.push(event);
  try {
    const written = await recovering.bulkWrite(
      [{ document: { id: "aaaaa", value: "new" } }],
      "update",
    );
    assert.deepEqual(written.error, [], "the write lands after the repair");
  } finally {
    globalThis.__wcposOnStorageRecovery = previousHook;
  }
  assert.ok(rawWrites >= 1, "the raw write ran");
  for (const index of indexes) {
    const survivors = index.rows.map((row) => row[0].slice(1));
    assert.deepEqual(
      survivors,
      ["bbbbb"],
      `${index.indexId}: only the written id is dropped`,
    );
  }
  assert.ok(
    events.some(
      (event) => event.kind === "hollow-row-dropped" && event.id === "aaaaa",
    ),
    "the drop is reported for the written id",
  );
});

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { withTargetedOpfsRecovery } from "./opfs-targeted-recovery.mjs";

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
      const indexes = ["primary", "secondary"].map((indexId) => ({
        indexId,
        rows: [[`0${id}`, 0, bytes.length]],
        metaIdMap: new Map([[id, [`0${id}`, 0, bytes.length]]]),
        runChangelogOperation([, position]) {
          this.rows.splice(position, 1);
          this.metaIdMap.delete(id);
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
          runCleanup: async (operation) => operation({ accessHandlers: new Map() }),
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
        for (const index of indexes) {
          assert.equal(index.rows.length, collectionName === "logs" ? 0 : 1);
          assert.equal(index.metaIdMap.has(id), collectionName !== "logs");
        }
        assert.equal(operations.length, collectionName === "logs" ? 2 : 0);
        if (collectionName === "logs") {
          assert.ok(operations.every((operation) => operation[2] === "D"));
          assert.deepEqual(events, [{
            kind: "log-row-discarded", target: "store_v6_test/logs", id, reason,
          }]);
        } else if (reason === "range-holds-foreign-bytes") {
          assert.ok(events.some((event) =>
            event.kind === "hollow-row-refused" && event.reason === reason,
          ));
        }
      } finally {
        globalThis.__wcposOnStorageRecovery = previousHook;
      }
    });
  }
}

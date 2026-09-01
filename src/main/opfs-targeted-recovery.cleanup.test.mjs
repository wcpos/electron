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

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { withTargetedOpfsRecovery } from "./opfs-targeted-recovery.mjs";

test("propagates a persistent cleanup error after recovery retries", async () => {
  const persistentError = new Error("quota exceeded");
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
      throw persistentError;
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
  console.error = () => {};

  try {
    await assert.rejects(
      () => recovering.cleanup(0),
      (error) => error === persistentError,
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(cleanupCalls, 2);
});

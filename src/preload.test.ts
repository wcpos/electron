import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";

import { INVOKE_CHANNELS, SEND_CHANNELS } from "@wcpos/printer/ipc-channels";

import type { TypedIpcRenderer } from "@wcpos/printer/ipc-channels";

const exposures: Record<string, any> = {};
const onCalls: {
  channel: string;
  listener: (...args: unknown[]) => void;
}[] = [];
const postMessageCalls: { channel: string; message: unknown }[] = [];
const invokeCalls: { channel: string; args: unknown }[] = [];
const removeListenerCalls: {
  channel: string;
  listener: (...args: unknown[]) => void;
}[] = [];
const APP_VERSION_ARG_PREFIX = "--wcpos-app-version=";
const mockResourcesPath = path.join("/mock", "resources");

const electronMock = {
  contextBridge: {
    exposeInMainWorld(name: string, value: unknown) {
      exposures[name] = value;
    },
  },
  ipcRenderer: {
    sendSync(channel: string) {
      throw new Error(`Unexpected sendSync channel: ${channel}`);
    },
    send() {},
    invoke(channel: string, args: unknown) {
      invokeCalls.push({ channel, args });
      return Promise.resolve(
        channel === "storage:measure" ? { entries: [] } : undefined,
      );
    },
    on(channel: string, listener: (...args: unknown[]) => void) {
      onCalls.push({ channel, listener });
    },
    once() {},
    removeListener(channel: string, listener: (...args: unknown[]) => void) {
      removeListenerCalls.push({ channel, listener });
    },
    postMessage(channel: string, message: unknown) {
      postMessageCalls.push({ channel, message });
    },
  },
};

type ModuleWithMutableLoad = typeof Module & {
  _load: (
    request: string,
    parent: NodeModule | null,
    isMain: boolean,
  ) => unknown;
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
  request: string,
  parent: NodeModule | null,
  isMain: boolean,
) {
  if (request === "electron") {
    return electronMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function waitFor(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(message);
}

async function main() {
  try {
    Object.defineProperty(process, "resourcesPath", {
      value: mockResourcesPath,
      configurable: true,
    });
    process.argv.push(`${APP_VERSION_ARG_PREFIX}0.0.0-test`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./preload");
  } finally {
    mutableModule._load = originalLoad;
  }

  const exposedElectron = exposures.electron;
  assert.ok(exposedElectron, "preload should expose window.electron");
  assert.equal(
    exposedElectron.basePath,
    `file://${mockResourcesPath}/dist`,
    "preload should expose the resources dist base path without a trailing slash",
  );
  assert.equal(
    exposedElectron.version,
    "0.0.0-test",
    "preload should expose the app version from Electron additionalArguments",
  );

  const exposedIpcRenderer = exposures.ipcRenderer;
  assert.ok(exposedIpcRenderer, "preload should expose window.ipcRenderer");
  assert.equal(
    typeof exposedIpcRenderer.postMessage,
    "function",
    "preload should expose ipcRenderer.postMessage",
  );
  await exposedIpcRenderer.invoke("printer-discovery", { action: "start" });
  assert.deepEqual(
    invokeCalls[invokeCalls.length - 1],
    { channel: "printer-discovery", args: { action: "start" } },
    "preload should allow printer discovery IPC invocations",
  );
  // Typed call: `storage:measure` declares `req: undefined`, so the argument is optional.
  const typedIpcRenderer: TypedIpcRenderer = exposedIpcRenderer;
  const storageMeasurement = await typedIpcRenderer.invoke("storage:measure");
  // Compile-time only: channels with a request payload must still require it.
  const assertPayloadStillRequired = (renderer: TypedIpcRenderer): void => {
    // @ts-expect-error -- print-raw-tcp declares a request payload; omitting it must not compile
    void renderer.invoke("print-raw-tcp");
  };
  void assertPayloadStillRequired;
  assert.deepEqual(
    invokeCalls[invokeCalls.length - 1],
    { channel: "storage:measure", args: undefined },
    "preload should allow storage measurement IPC invocations",
  );
  assert.deepEqual(
    storageMeasurement,
    { entries: [] },
    "preload should return storage measurement results",
  );
  assert.equal(
    typeof exposedIpcRenderer.on,
    "function",
    "preload should expose ipcRenderer.on",
  );
  assert.equal(
    typeof exposedIpcRenderer.removeListener,
    "function",
    "preload should expose ipcRenderer.removeListener",
  );

  const rxdbChannel = "rxdb-ipc-renderer-storage|main-storage";
  const listenerCalls: unknown[][] = [];
  const listener = (...args: unknown[]) => {
    listenerCalls.push(args);
  };
  const unsubscribe = exposedIpcRenderer.on(rxdbChannel, listener);
  assert.equal(
    typeof unsubscribe,
    "function",
    "ipcRenderer.on should return an unsubscribe function",
  );
  assert.equal(
    onCalls[onCalls.length - 1]?.channel,
    rxdbChannel,
    "preload should allow RxDB renderer bridge subscription channels",
  );
  assert.notEqual(
    onCalls[onCalls.length - 1]?.listener,
    listener,
    "preload should wrap RxDB bridge listeners so incoming attachment payloads can be decoded",
  );

  const attachmentBlob = new Blob(["hello world"], { type: "text/plain" });
  exposedIpcRenderer.postMessage(rxdbChannel, {
    method: "bulkWrite",
    params: [
      [
        {
          document: {
            id: "doc-1",
            _attachments: {
              greeting: {
                data: attachmentBlob,
                type: "text/plain",
                length: attachmentBlob.size,
                digest: "digest-1",
              },
            },
          },
        },
      ],
      { context: "unit-test" },
    ],
  });

  await waitFor(
    () => postMessageCalls.length > 0,
    "expected preload to forward the serialized RxDB bulkWrite payload",
  );
  const forwardedBulkWrite = postMessageCalls[postMessageCalls.length - 1];
  assert.equal(
    forwardedBulkWrite.channel,
    rxdbChannel,
    "preload should forward postMessage for the RxDB bridge channel",
  );
  assert.equal(
    typeof (forwardedBulkWrite.message as any).params[0][0].document
      ._attachments.greeting.data,
    "string",
    "preload should serialize Blob attachment data to base64 before crossing Electron IPC",
  );

  const wrappedListener = onCalls[onCalls.length - 1]!.listener;
  wrappedListener(
    { sender: "main" },
    {
      method: "getAttachmentData",
      return: "aGVsbG8gd29ybGQ=",
    },
  );
  await waitFor(
    () => listenerCalls.length > 0,
    "expected wrapped RxDB listener to receive the deserialized attachment payload",
  );
  const [eventArg, messageArg] = listenerCalls[listenerCalls.length - 1] ?? [];
  assert.deepEqual(
    eventArg,
    { sender: "main" },
    "preload should preserve the original event argument",
  );
  assert.ok(messageArg, "preload should forward a RxDB response message");
  assert.ok(
    (messageArg as any).return instanceof Blob,
    "preload should deserialize base64 getAttachmentData responses back into Blob objects",
  );
  assert.equal(
    await (messageArg as any).return.text(),
    "hello world",
    "preload should preserve attachment contents when decoding getAttachmentData responses",
  );

  const duplicateListener = (...args: unknown[]) => {
    void args;
  };
  const firstDuplicateUnsubscribe = exposedIpcRenderer.on(
    rxdbChannel,
    duplicateListener,
  );
  const secondDuplicateUnsubscribe = exposedIpcRenderer.on(
    rxdbChannel,
    duplicateListener,
  );
  const firstDuplicateWrappedListener = onCalls[onCalls.length - 2]!.listener;
  const secondDuplicateWrappedListener = onCalls[onCalls.length - 1]!.listener;
  assert.notEqual(
    firstDuplicateWrappedListener,
    secondDuplicateWrappedListener,
    "preload should create a distinct wrapper for each RxDB listener registration",
  );

  firstDuplicateUnsubscribe();
  assert.equal(
    removeListenerCalls[removeListenerCalls.length - 1]?.listener,
    firstDuplicateWrappedListener,
    "first unsubscribe should remove the matching RxDB wrapper, even when the same listener is registered twice",
  );

  secondDuplicateUnsubscribe();
  assert.equal(
    removeListenerCalls[removeListenerCalls.length - 1]?.listener,
    secondDuplicateWrappedListener,
    "second unsubscribe should remove the second RxDB wrapper",
  );

  exposedIpcRenderer.removeListener(rxdbChannel, listener);
  assert.equal(
    removeListenerCalls[removeListenerCalls.length - 1]?.channel,
    rxdbChannel,
    "preload should forward removeListener for the RxDB bridge channel",
  );
  assert.equal(
    removeListenerCalls[removeListenerCalls.length - 1]?.listener,
    wrappedListener,
    "preload should remove the wrapped RxDB bridge listener function",
  );

  unsubscribe();
  assert.equal(
    removeListenerCalls[removeListenerCalls.length - 1]?.listener,
    wrappedListener,
    "unsubscribe should remove the wrapped RxDB bridge listener",
  );

  // ------------------------------------------------------------------
  // The preload allowlist must cover every channel main actually serves.
  //
  // This test used to invoke two arbitrary channels ('printer-discovery',
  // 'storage:measure') and call the bridge proven. It stayed green through
  // the 1.10.1 release while EVERY HTTP request in the packaged app was
  // rejected at the preload: wcpos/electron#354 renamed the transport channel
  // 'axios' -> 'http-request' in main, but this repo carries its own vendored
  // copy of the channel registry and that copy kept the old name. Main served
  // 'http-request'; the preload allowed 'axios'; the renderer got
  // "Channel http-request is not allowed" before IPC, so nothing reached the
  // main process and nothing appeared in the transport log.
  //
  // Sampling channels cannot catch that. The invariant is the coverage
  // relation itself, so assert it directly against the source.
  // ------------------------------------------------------------------
  const collectSourceFiles = (dir: string, acc: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectSourceFiles(full, acc);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
        acc.push(full);
    }
    return acc;
  };

  const sourceFiles = collectSourceFiles(path.join(__dirname));
  const sources = sourceFiles
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");

  // `handleIpc('x')` is the typed wrapper in src/main/ipc.ts; `ipcMain.handle('x')`
  // is the raw call. `protocol.handle` is a URL scheme, not IPC — hence the anchors.
  const registeredInvokeChannels = new Set(
    [...sources.matchAll(/(?:ipcMain\.handle|handleIpc)\(\s*'([^']+)'/g)].map(
      (m) => m[1],
    ),
  );
  assert.ok(
    registeredInvokeChannels.size > 0,
    "expected to find ipcMain.handle registrations — the scan itself must not silently match nothing",
  );
  assert.ok(
    registeredInvokeChannels.has("http-request"),
    "main must still register the http-request transport channel",
  );
  for (const channel of registeredInvokeChannels) {
    assert.ok(
      (INVOKE_CHANNELS as readonly string[]).includes(channel),
      `main registers invoke channel '${channel}' but the preload allowlist does not permit it — ` +
        'the renderer will get "Channel ' +
        channel +
        ' is not allowed" before IPC',
    );
  }

  const registeredSendChannels = new Set(
    [...sources.matchAll(/ipcMain\.on\(\s*'([^']+)'/g)].map((m) => m[1]),
  );
  for (const channel of registeredSendChannels) {
    assert.ok(
      (SEND_CHANNELS as readonly string[]).includes(channel),
      `main listens on send channel '${channel}' but the preload allowlist does not permit it`,
    );
  }

  // The specific regression, exercised through the real bridge rather than the list.
  await exposedIpcRenderer.invoke("http-request", {
    type: "request",
    requestId: "allowlist-probe",
    config: { url: "https://example.com", method: "get" },
  });
  assert.equal(
    invokeCalls[invokeCalls.length - 1]?.channel,
    "http-request",
    "preload must forward the http-request transport channel to main",
  );

  console.log("preload bridge assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

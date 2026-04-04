import assert from 'node:assert/strict';
import Module from 'node:module';

const exposures: Record<string, any> = {};
const onCalls: {
	channel: string;
	listener: (...args: unknown[]) => void;
}[] = [];
const postMessageCalls: { channel: string; message: unknown }[] = [];
const removeListenerCalls: {
	channel: string;
	listener: (...args: unknown[]) => void;
}[] = [];

const electronMock = {
	contextBridge: {
		exposeInMainWorld(name: string, value: unknown) {
			exposures[name] = value;
		},
	},
	ipcRenderer: {
		sendSync(channel: string) {
			if (channel === 'getBasePathSync') {
				return '/mock-base-path';
			}
			if (channel === 'getAppVersionSync') {
				return '0.0.0-test';
			}
			throw new Error(`Unexpected sendSync channel: ${channel}`);
		},
		send() {},
		invoke() {
			return Promise.resolve(undefined);
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
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') {
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
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require('./preload');
	} finally {
		mutableModule._load = originalLoad;
	}

	const exposedIpcRenderer = exposures.ipcRenderer;
	assert.ok(exposedIpcRenderer, 'preload should expose window.ipcRenderer');
	assert.equal(
		typeof exposedIpcRenderer.postMessage,
		'function',
		'preload should expose ipcRenderer.postMessage'
	);
	assert.equal(typeof exposedIpcRenderer.on, 'function', 'preload should expose ipcRenderer.on');
	assert.equal(
		typeof exposedIpcRenderer.removeListener,
		'function',
		'preload should expose ipcRenderer.removeListener'
	);

	const rxdbChannel = 'rxdb-ipc-renderer-storage|main-storage';
	const listenerCalls: unknown[][] = [];
	const listener = (...args: unknown[]) => {
		listenerCalls.push(args);
	};
	const unsubscribe = exposedIpcRenderer.on(rxdbChannel, listener);
	assert.equal(
		typeof unsubscribe,
		'function',
		'ipcRenderer.on should return an unsubscribe function'
	);
	assert.equal(
		onCalls[onCalls.length - 1]?.channel,
		rxdbChannel,
		'preload should allow RxDB renderer bridge subscription channels'
	);
	assert.notEqual(
		onCalls[onCalls.length - 1]?.listener,
		listener,
		'preload should wrap RxDB bridge listeners so incoming attachment payloads can be decoded'
	);

	const attachmentBlob = new Blob(['hello world'], { type: 'text/plain' });
	exposedIpcRenderer.postMessage(rxdbChannel, {
		method: 'bulkWrite',
		params: [
			[
				{
					document: {
						id: 'doc-1',
						_attachments: {
							greeting: {
								data: attachmentBlob,
								type: 'text/plain',
								length: attachmentBlob.size,
								digest: 'digest-1',
							},
						},
					},
				},
			],
			{ context: 'unit-test' },
		],
	});

	await waitFor(
		() => postMessageCalls.length > 0,
		'expected preload to forward the serialized RxDB bulkWrite payload'
	);
	const forwardedBulkWrite = postMessageCalls[postMessageCalls.length - 1];
	assert.equal(
		forwardedBulkWrite.channel,
		rxdbChannel,
		'preload should forward postMessage for the RxDB bridge channel'
	);
	assert.equal(
		typeof (forwardedBulkWrite.message as any).params[0][0].document._attachments.greeting.data,
		'string',
		'preload should serialize Blob attachment data to base64 before crossing Electron IPC'
	);

	const wrappedListener = onCalls[onCalls.length - 1]!.listener;
	wrappedListener(
		{ sender: 'main' },
		{
			method: 'getAttachmentData',
			return: 'aGVsbG8gd29ybGQ=',
		}
	);
	await waitFor(
		() => listenerCalls.length > 0,
		'expected wrapped RxDB listener to receive the deserialized attachment payload'
	);
	const [eventArg, messageArg] = listenerCalls[listenerCalls.length - 1] ?? [];
	assert.deepEqual(
		eventArg,
		{ sender: 'main' },
		'preload should preserve the original event argument'
	);
	assert.ok(messageArg, 'preload should forward a RxDB response message');
	assert.ok(
		(messageArg as any).return instanceof Blob,
		'preload should deserialize base64 getAttachmentData responses back into Blob objects'
	);
	assert.equal(
		await (messageArg as any).return.text(),
		'hello world',
		'preload should preserve attachment contents when decoding getAttachmentData responses'
	);

	const duplicateListener = (...args: unknown[]) => {
		void args;
	};
	const firstDuplicateUnsubscribe = exposedIpcRenderer.on(rxdbChannel, duplicateListener);
	const secondDuplicateUnsubscribe = exposedIpcRenderer.on(rxdbChannel, duplicateListener);
	const firstDuplicateWrappedListener = onCalls[onCalls.length - 2]!.listener;
	const secondDuplicateWrappedListener = onCalls[onCalls.length - 1]!.listener;
	assert.notEqual(
		firstDuplicateWrappedListener,
		secondDuplicateWrappedListener,
		'preload should create a distinct wrapper for each RxDB listener registration'
	);

	firstDuplicateUnsubscribe();
	assert.equal(
		removeListenerCalls[removeListenerCalls.length - 1]?.listener,
		firstDuplicateWrappedListener,
		'first unsubscribe should remove the matching RxDB wrapper, even when the same listener is registered twice'
	);

	secondDuplicateUnsubscribe();
	assert.equal(
		removeListenerCalls[removeListenerCalls.length - 1]?.listener,
		secondDuplicateWrappedListener,
		'second unsubscribe should remove the second RxDB wrapper'
	);

	exposedIpcRenderer.removeListener(rxdbChannel, listener);
	assert.equal(
		removeListenerCalls[removeListenerCalls.length - 1]?.channel,
		rxdbChannel,
		'preload should forward removeListener for the RxDB bridge channel'
	);
	assert.equal(
		removeListenerCalls[removeListenerCalls.length - 1]?.listener,
		wrappedListener,
		'preload should remove the wrapped RxDB bridge listener function'
	);

	unsubscribe();
	assert.equal(
		removeListenerCalls[removeListenerCalls.length - 1]?.listener,
		wrappedListener,
		'unsubscribe should remove the wrapped RxDB bridge listener'
	);

	console.log('preload bridge assertions passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

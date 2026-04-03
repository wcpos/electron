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
const listener = () => {};
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
assert.equal(
	onCalls[onCalls.length - 1]?.listener,
	listener,
	'preload should pass RxDB bridge listeners through unchanged'
);

exposedIpcRenderer.postMessage(rxdbChannel, { ping: true });
assert.deepEqual(
	postMessageCalls[postMessageCalls.length - 1],
	{ channel: rxdbChannel, message: { ping: true } },
	'preload should forward postMessage for the RxDB bridge channel'
);

exposedIpcRenderer.removeListener(rxdbChannel, listener);
assert.equal(
	removeListenerCalls[removeListenerCalls.length - 1]?.channel,
	rxdbChannel,
	'preload should forward removeListener for the RxDB bridge channel'
);
assert.equal(
	removeListenerCalls[removeListenerCalls.length - 1]?.listener,
	listener,
	'preload should remove the exact RxDB bridge listener function'
);

unsubscribe();
assert.equal(
	removeListenerCalls[removeListenerCalls.length - 1]?.listener,
	listener,
	'unsubscribe should remove the exact RxDB bridge listener'
);

console.log('preload bridge assertions passed');

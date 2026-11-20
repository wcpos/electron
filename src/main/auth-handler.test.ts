import assert from 'assert/strict';
import Module from 'module';

type EventListener = (...args: unknown[]) => void;
const createdWindows: BrowserWindowMock[] = [];
let nextLoadResult: Promise<void>;

class BrowserWindowMock {
	webContentsListeners = new Map<string, EventListener>();
	windowListeners = new Map<string, EventListener>();
	closeCalls = 0;
	webContents = {
		on: (event: string, listener: EventListener) => {
			this.webContentsListeners.set(event, listener);
		},
	};

	constructor() {
		createdWindows.push(this);
	}

	on(event: string, listener: EventListener) {
		this.windowListeners.set(event, listener);
	}
	once(event: string, listener: EventListener) {
		this.windowListeners.set(event, listener);
	}
	emit(event: string, ...args: unknown[]) {
		this.windowListeners.get(event)?.(...args);
	}
	emitWebContents(event: string, ...args: unknown[]) {
		this.webContentsListeners.get(event)?.(...args);
	}
	loadURL(): Promise<void> {
		return nextLoadResult;
	}
	isDestroyed() {
		return false;
	}
	close() {
		this.closeCalls++;
	}
}

type IpcListener = (event: unknown, args: unknown) => Promise<unknown>;
const ipcHandleListeners = new Map<string, IpcListener>();
const electronMock = {
	BrowserWindow: BrowserWindowMock,
	ipcMain: {
		handle(channel: string, listener: IpcListener) {
			ipcHandleListeners.set(channel, listener);
		},
	},
};
const loggerMock = { info() {}, warn() {}, error() {} };

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
	if (request === 'electron') return electronMock;
	if (request === './log') return { logger: loggerMock, logger2: loggerMock };
	if (request === './window') return { getMainWindow: (): null => null };
	return originalLoad.call(this, request, parent, isMain);
};

async function isPending(p: Promise<unknown>): Promise<boolean> {
	const sentinel = Symbol('pending');
	return (
		(await Promise.race([p, new Promise((resolve) => setImmediate(() => resolve(sentinel)))])) ===
		sentinel
	);
}

async function main() {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { initAuthHandler } = require('./auth-handler');
		initAuthHandler();
	} finally {
		mutableModule._load = originalLoad;
	}

	const listener = ipcHandleListeners.get('auth:prompt');
	assert.ok(listener, 'auth-handler should register the auth:prompt handler');

	// Aborted initial load keeps the login open.
	{
		nextLoadResult = Promise.reject(
			Object.assign(
				new Error("ERR_ABORTED (-3) loading 'https://store.example.com/wp-login.php'"),
				{ code: 'ERR_ABORTED', errno: -3 }
			)
		);
		const promise = listener(
			{},
			{ authUrl: 'https://store.example.com/wp-login.php', redirectUri: 'wcpos://auth' }
		);
		const window = createdWindows[0];
		assert.equal(await isPending(promise), true);
		assert.equal(window.closeCalls, 0);
		window.emitWebContents(
			'will-navigate',
			{ preventDefault() {} },
			'wcpos://auth?access_token=abc'
		);
		assert.deepEqual(await promise, { type: 'success', params: { access_token: 'abc' } });
	}

	// Errno -3 alone is also ignored.
	{
		nextLoadResult = Promise.reject(Object.assign(new Error('aborted'), { errno: -3 }));
		const promise = listener(
			{},
			{ authUrl: 'https://store.example.com/wp-login.php', redirectUri: 'wcpos://auth' }
		);
		const window = createdWindows[1];
		assert.equal(await isPending(promise), true);
		assert.equal(window.closeCalls, 0);
		window.emit('closed');
		assert.deepEqual(await promise, { type: 'dismiss' });
	}

	// Other load errors still fail the login.
	{
		nextLoadResult = Promise.reject(
			Object.assign(
				new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'https://store.example.com/wp-login.php'"),
				{ code: 'ERR_NAME_NOT_RESOLVED', errno: -105 }
			)
		);
		const promise = listener(
			{},
			{ authUrl: 'https://store.example.com/wp-login.php', redirectUri: 'wcpos://auth' }
		);
		const window = createdWindows[2];
		assert.deepEqual(await promise, {
			type: 'error',
			error:
				"Failed to load auth page: ERR_NAME_NOT_RESOLVED (-105) loading 'https://store.example.com/wp-login.php'",
		});
		assert.equal(window.closeCalls, 1);
	}

	console.log('auth handler assertions passed');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

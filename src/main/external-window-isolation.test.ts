import assert from 'assert/strict';
import Module from 'module';

/**
 * External-content windows (auth popup, external receipt print) must NOT run
 * in the default session: that session hosts the wcpos-image:// protocol
 * handler, and an external page there could use it as an SSRF read-proxy —
 * encode any http(s) URL, have the main process fetch it, and read the bytes
 * through the wildcard CORS header. Session isolation is the enforceable
 * boundary (verified empirically on Electron 41: a partitioned window's
 * fetch/img of wcpos-image:// fails while the default session's succeeds);
 * header-based gating is not, because Electron never forwards Origin headers
 * to protocol handlers.
 */

const createdWindows: { partition?: string }[] = [];

class BrowserWindowMock {
	webContents = {
		on() {},
		executeJavaScript: () => Promise.resolve(),
	};

	constructor(options: { webPreferences?: { partition?: string } }) {
		createdWindows.push({ partition: options?.webPreferences?.partition });
	}

	once() {}
	on() {}
	loadURL(): Promise<void> {
		return new Promise<void>(() => {});
	}
	isDestroyed() {
		return false;
	}
	close() {}
}

type IpcListener = (event: unknown, args: unknown) => unknown;
const ipcOnListeners = new Map<string, IpcListener>();
const ipcHandleListeners = new Map<string, IpcListener>();

const electronMock = {
	BrowserWindow: BrowserWindowMock,
	ipcMain: {
		on(channel: string, listener: IpcListener) {
			ipcOnListeners.set(channel, listener);
		},
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

async function main() {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require('./print-external-url');
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { initAuthHandler } = require('./auth-handler');
		initAuthHandler();
	} finally {
		mutableModule._load = originalLoad;
	}

	const printListener = ipcOnListeners.get('print-external-url');
	assert.ok(printListener, 'print-external-url should register an ipc listener');
	printListener!(
		{ sender: { send() {} } },
		{ externalURL: 'https://store.example.com/receipt?key=wc_order_x', printJobId: 'job-1' }
	);

	const authListener = ipcHandleListeners.get('auth:prompt');
	assert.ok(authListener, 'auth-handler should register the auth:prompt handler');
	// Fire-and-forget: the promise only settles on user/navigation events.
	void authListener!(
		{},
		{ authUrl: 'https://store.example.com/wp-login.php', redirectUri: 'wcpos://auth' }
	);

	assert.equal(createdWindows.length, 2, 'both external windows should have been created');
	for (const win of createdWindows) {
		assert.ok(
			win.partition && win.partition.length > 0,
			'external-content windows must set a session partition — the default session exposes the wcpos-image:// handler (SSRF read-proxy) to any page loaded there'
		);
	}

	const partitions = createdWindows.map((win) => win.partition);
	assert.equal(
		new Set(partitions).size,
		partitions.length,
		'external windows should not share a partition with each other'
	);

	console.log('external window isolation assertions passed');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

import assert from 'node:assert/strict';
import Module from 'node:module';

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
		return {
			BrowserWindow: class FakeBrowserWindow {},
			app: { whenReady: () => Promise.resolve() },
		};
	}
	if (request === './log') {
		return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
	}
	return originalLoad.call(this, request, parent, isMain);
};

(async () => {
	try {
		const fakeWindow = { id: 'main-window' };
		const calls: string[] = [];
		const updaterWindows: unknown[] = [];
		const mark =
			(name: string): (() => void) =>
			() => {
				calls.push(name);
			};
		const fakeUpdater = {
			init: mark('updater-init'),
			manualCheckForUpdates: async (): Promise<void> => undefined,
			setMainWindow: (): void => {},
		};
		const fakeDeps = {
			whenReady: async (): Promise<void> => undefined,
			loadTranslations: mark('translations'),
			clearPendingAppDataOnStartup: mark('clear-pending-app-data'),
			installExtensions: mark('install-extensions'),
			initializeRxdbStorageBridge: mark('storage-bridge'),
			createWindow: () => {
				calls.push('create-window');
				return fakeWindow as never;
			},
			getMainWindow: () => fakeWindow as never,
			registerBluetoothSelection: mark('bluetooth-selection'),
			initAuthHandler: mark('auth-handler'),
			initProtocolHandling: mark('protocol-handling'),
			registerMenu: mark('menu'),
			createUpdater: (mainWindow: unknown) => {
				updaterWindows.push(mainWindow);
				return fakeUpdater;
			},
			isDevelopment: true,
			logger: { info() {}, warn() {}, error() {} },
		};

		// eslint-disable-next-line @typescript-eslint/no-require-imports -- test installs Module._load fakes before loading boot.ts
		const { bootPlan, boot } = require('./boot') as {
			bootPlan: (deps: typeof fakeDeps) => { name: string }[];
			boot: (deps: typeof fakeDeps) => Promise<{
				mainWindow: typeof fakeWindow;
				updater: typeof fakeUpdater;
			}>;
		};

		const phaseNames = bootPlan(fakeDeps).map((phase) => phase.name);
		assert.deepEqual(phaseNames, [
			'translations',
			'clear-pending-app-data',
			'install-extensions',
			'storage-bridge',
			'create-window',
			'bluetooth-selection',
			'auth-handler',
			'protocol-handling',
			'menu',
			'updater-init',
		]);

		const indexOf = (name: string) => {
			const index = phaseNames.indexOf(name);
			assert.notEqual(index, -1, `Missing boot phase: ${name}`);
			return index;
		};
		assert.ok(indexOf('translations') < indexOf('storage-bridge'));
		assert.ok(indexOf('storage-bridge') < indexOf('create-window'));
		assert.ok(indexOf('create-window') < indexOf('bluetooth-selection'));
		assert.ok(indexOf('create-window') < indexOf('auth-handler'));
		assert.ok(indexOf('create-window') < indexOf('protocol-handling'));
		assert.ok(indexOf('create-window') < indexOf('menu'));
		assert.ok(indexOf('menu') < indexOf('updater-init'));

		const context = await boot(fakeDeps);
		assert.equal(context.mainWindow, fakeWindow);
		assert.equal(context.updater, fakeUpdater);
		assert.deepEqual(updaterWindows, [fakeWindow]);
		assert.deepEqual(calls, phaseNames);
		console.log('boot tests passed');
	} finally {
		mutableModule._load = originalLoad;
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

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
		const scannerWindows: unknown[] = [];
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
			registerScannerDeviceSelection: (mainWindow: unknown): void => {
				scannerWindows.push(mainWindow);
			},
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
		const { bootPlan, boot, recreateMainWindow } = require('./boot') as {
			bootPlan: (deps: typeof fakeDeps) => { name: string }[];
			boot: (deps: typeof fakeDeps) => Promise<{
				mainWindow: typeof fakeWindow;
				updater: typeof fakeUpdater;
			}>;
			recreateMainWindow: (
				deps: typeof fakeDeps,
				ctx: { mainWindow?: unknown; updater?: unknown }
			) => unknown;
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
		assert.deepEqual(scannerWindows, [fakeWindow]);
		assert.deepEqual(calls, phaseNames);

		// Without a main window, boot still registers the window-independent phases
		// (auth handler, protocol, menu) so a window re-created on macOS `activate`
		// is fully usable — then rejects, because the updater needs a window.
		const windowlessCalls: string[] = [];
		const windowlessUpdaterWindows: unknown[] = [];
		const windowlessMark =
			(name: string): (() => void) =>
			() => {
				windowlessCalls.push(name);
			};
		const windowlessDeps = {
			...fakeDeps,
			createWindow: () => {
				windowlessCalls.push('create-window');
				return null as never;
			},
			getMainWindow: () => null as never,
			initAuthHandler: windowlessMark('auth-handler'),
			initProtocolHandling: windowlessMark('protocol-handling'),
			registerMenu: windowlessMark('menu'),
			registerBluetoothSelection: windowlessMark('bluetooth-selection'),
			createUpdater: (mainWindow: unknown) => {
				windowlessCalls.push('updater-init');
				windowlessUpdaterWindows.push(mainWindow);
				return fakeUpdater;
			},
		};
		await assert.rejects(boot(windowlessDeps), /Main window was not created during boot/);
		assert.deepEqual(
			windowlessCalls,
			['create-window', 'auth-handler', 'protocol-handling', 'menu'],
			'window-independent phases still run; window consumers and updater are skipped'
		);
		assert.deepEqual(windowlessUpdaterWindows, [], 'no updater is created without a window');

		// macOS activate: re-creating the window finishes the wiring boot skipped.
		const recreated: { mainWindow?: unknown; updater?: unknown } = {};
		const recreateDeps = { ...windowlessDeps, createWindow: () => fakeWindow as never };
		assert.equal(recreateMainWindow(recreateDeps, recreated), fakeWindow);
		assert.equal(recreated.mainWindow, fakeWindow);
		assert.equal(recreated.updater, fakeUpdater, 'the updater is configured on recreate');
		assert.deepEqual(windowlessUpdaterWindows, [fakeWindow]);
		assert.ok(
			windowlessCalls.includes('bluetooth-selection'),
			'window consumers are wired on recreate'
		);
		assert.equal(recreateMainWindow(windowlessDeps, {}), null, 'no window, nothing to wire');
		console.log('boot tests passed');
	} finally {
		mutableModule._load = originalLoad;
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

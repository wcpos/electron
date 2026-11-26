import assert from 'node:assert/strict';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
type OpenHandler = (details: { url: string }) => { action: string };

const noop = (): void => undefined;
let openHandler: OpenHandler;
class FakeBrowserWindow {
	readonly webContents = {
		on: noop,
		openDevTools: noop,
		setWindowOpenHandler(handler: OpenHandler) {
			openHandler = handler;
		},
	};
	on = noop;
	once = noop;
	show = noop;
	focus = noop;
	minimize = noop;
	isDestroyed = () => false;
	loadURL = noop;
}

async function main() {
	const shellCalls: string[] = [];
	const mutableModule = Module as ModuleWithMutableLoad;
	const originalLoad = mutableModule._load;
	const realResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
	const globals = globalThis as unknown as Record<string, unknown>;
	try {
		mutableModule._load = function (request, parent, isMain) {
			if (request === 'electron') {
				return {
					app: { getVersion: () => '0.0.0-test' },
					BrowserWindow: FakeBrowserWindow,
					ipcMain: { on: noop },
					shell: {
						async openExternal(url: string) {
							shellCalls.push(url);
						},
					},
				};
			}
			if (request === 'electron-serve') return { default: () => noop, __esModule: true };
			if (request === './app-origin') return { guardMainFrameNavigation: noop };
			if (request === './install-id') return { getInstallId: () => 'test-install-id' };
			if (request === './log')
				return { logger: { debug: noop, info: noop, warn: noop, error: noop } };
			if (request === './title-bar') {
				return {
					titleBarOptions: () => ({}),
					applyWindowColorScheme: noop,
					isWindowColorScheme: () => false,
				};
			}
			if (request === './util') return { isDevelopment: false };
			return originalLoad.call(this, request, parent, isMain);
		};
		Object.defineProperty(process, 'resourcesPath', {
			value: '/tmp/wcpos-window-open-handler-test',
			configurable: true,
			writable: true,
		});
		globals.MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY = '/tmp/wcpos-window-open-handler-test/preload.js';
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { createWindow } = require('./window') as typeof import('./window');
		createWindow();
	} finally {
		mutableModule._load = originalLoad;
		if (realResourcesPath) Object.defineProperty(process, 'resourcesPath', realResourcesPath);
		else Reflect.deleteProperty(process, 'resourcesPath');
		delete globals.MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY;
	}

	assert.ok(openHandler);
	assert.deepEqual(openHandler({ url: 'file:///C:/Windows/System32/calc.exe' }), {
		action: 'deny',
	});
	assert.deepEqual(openHandler({ url: 'https://example.com/path' }), { action: 'deny' });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(shellCalls, ['https://example.com/path']);
	console.log('window-open-handler tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

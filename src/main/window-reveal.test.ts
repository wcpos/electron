import assert from 'node:assert/strict';
import Module from 'node:module';

import { revealWhenReady } from './window-reveal';

// Debian 13 GNOME runs Electron 45 under native Wayland, where a `show: false` window never
// paints and so never fires `ready-to-show`. The published .deb loaded the app and never opened
// a window. Linux must reveal its windows at once; macOS and Windows keep waiting for
// `ready-to-show` exactly as before.

type Handler = () => void;

class FakeOnceWindow {
	readonly registrations: { event: string; handler: Handler }[] = [];
	once(event: string, handler: Handler) {
		this.registrations.push({ event, handler });
		return this;
	}
	emit(event: string) {
		for (const r of this.registrations) if (r.event === event) r.handler();
	}
}

const asWindow = (win: FakeOnceWindow) => win as unknown as Parameters<typeof revealWhenReady>[0];

// a. macOS and Windows wait for ready-to-show.
for (const platform of ['darwin', 'win32'] as const) {
	const win = new FakeOnceWindow();
	let reveals = 0;
	revealWhenReady(asWindow(win), () => reveals++, platform);
	assert.equal(reveals, 0, `${platform} must not reveal a window before ready-to-show`);
	assert.equal(win.registrations.length, 1, `${platform} must register exactly one listener`);
	assert.equal(
		win.registrations[0].event,
		'ready-to-show',
		`${platform} must wait for ready-to-show, as it did before the Debian fix`
	);
	win.emit('ready-to-show');
	assert.equal(reveals, 1, `${platform} must reveal the window once on ready-to-show`);
}

// b. Linux reveals at once.
{
	const win = new FakeOnceWindow();
	let reveals = 0;
	revealWhenReady(asWindow(win), () => reveals++, 'linux');
	assert.equal(
		reveals,
		1,
		'Linux must reveal the window synchronously (Wayland never fires ready-to-show for a hidden window)'
	);
	assert.equal(
		win.registrations.length,
		0,
		'Linux must not wait on ready-to-show, which never fires under Debian 13 Wayland'
	);
}

// c. Wiring: createWindow() in ./window goes through revealWhenReady.
type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

class FakeBrowserWindow {
	static instances: FakeBrowserWindow[] = [];
	showCalls = 0;
	minimizeCalls = 0;
	readonly handlers = new Map<string, Handler[]>();
	readonly webContents = {
		on() {},
		openDevTools() {},
		setWindowOpenHandler() {},
	};

	constructor() {
		FakeBrowserWindow.instances.push(this);
	}

	show() {
		this.showCalls++;
	}
	minimize() {
		this.minimizeCalls++;
	}
	on(event: string, handler: Handler) {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
		return this;
	}
	once(event: string, handler: Handler) {
		return this.on(event, handler);
	}
	emit(event: string) {
		for (const handler of this.handlers.get(event) ?? []) handler();
	}
	isDestroyed() {
		return false;
	}
}

const noop = (): void => undefined;
const loggerMock = { info: noop, warn: noop, error: noop, debug: noop };

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
const realPlatform = process.platform;
const realResourcesPath = process.resourcesPath;
const realStartMinimized = process.env.START_MINIMIZED;
const globals = globalThis as unknown as Record<string, unknown>;

const setPlatform = (platform: NodeJS.Platform) =>
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });

try {
	mutableModule._load = function patchedLoad(
		request: string,
		parent: NodeModule | null,
		isMain: boolean
	) {
		if (request === 'electron') {
			return {
				app: { getVersion: () => '0.0.0-test' },
				BrowserWindow: FakeBrowserWindow,
				ipcMain: { on: noop },
				shell: { openExternal: noop },
			};
		}
		if (request === 'electron-serve') return { default: () => noop, __esModule: true };
		if (request === './app-origin') return { guardMainFrameNavigation: noop };
		if (request === './install-id') return { getInstallId: () => 'test-install-id' };
		if (request === './log') return { logger: loggerMock };
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
		value: '/tmp/wcpos-window-reveal-test',
		configurable: true,
		writable: true,
	});
	globals.MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY = '/tmp/wcpos-window-reveal-test/preload.js';
	delete process.env.START_MINIMIZED;

	const { createWindow } = require('./window') as typeof import('./window');
	const latest = () => FakeBrowserWindow.instances[FakeBrowserWindow.instances.length - 1];

	setPlatform('linux');
	createWindow();
	assert.equal(
		latest().showCalls,
		1,
		'Linux must show the main window without waiting for ready-to-show (Wayland never fires it for a hidden window)'
	);
	assert.equal(latest().minimizeCalls, 0, 'Linux must not minimise the main window by default');

	process.env.START_MINIMIZED = '1';
	createWindow();
	assert.equal(
		latest().minimizeCalls,
		1,
		'Linux with START_MINIMIZED must map the main window minimised at once (Wayland never fires ready-to-show)'
	);
	assert.equal(latest().showCalls, 0, 'Linux with START_MINIMIZED must not show() the main window');
	delete process.env.START_MINIMIZED;

	setPlatform('darwin');
	createWindow();
	assert.equal(latest().showCalls, 0, 'macOS must not show the main window before ready-to-show');
	latest().emit('ready-to-show');
	assert.equal(latest().showCalls, 1, 'macOS must show the main window once on ready-to-show');

	console.log('window-reveal.test.ts passed');
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	mutableModule._load = originalLoad;
	setPlatform(realPlatform);
	Object.defineProperty(process, 'resourcesPath', {
		value: realResourcesPath,
		configurable: true,
		writable: true,
	});
	delete globals.MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY;
	if (realStartMinimized === undefined) delete process.env.START_MINIMIZED;
	else process.env.START_MINIMIZED = realStartMinimized;
}

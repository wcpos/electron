import assert from 'node:assert/strict';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

// Regression (Sentry WOOCOMMERCE-POS-2M6/2M7): the updater can run with no main window (macOS
// keeps the app alive after its last window closes), or the main window can be destroyed while
// the download runs. ProgressBar then threw "Cannot read properties of null (reading
// 'setProgressBar')" from its `closed` handler, and would have thrown from updateProgress and
// close too. The taskbar progress is cosmetic; the progress window must keep working without it.

type Handler = () => void;

class FakeBrowserWindow {
	static instances: FakeBrowserWindow[] = [];
	readonly handlers = new Map<string, Handler[]>();
	readonly scripts: string[] = [];
	readonly webContents = {
		executeJavaScript: (script: string) => {
			this.scripts.push(script);
			return Promise.resolve();
		},
	};

	constructor() {
		FakeBrowserWindow.instances.push(this);
	}

	setMenu() {}
	loadURL() {
		return Promise.resolve();
	}
	on(event: string, handler: Handler) {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
	}
	once(event: string, handler: Handler) {
		this.on(event, handler);
	}
	emit(event: string) {
		for (const handler of this.handlers.get(event) ?? []) handler();
	}
	close() {
		this.emit('closed');
	}
}

// A main window electron has already destroyed: every method throws, as the real one does.
const destroyedMainWindow = {
	isDestroyed: () => true,
	setProgressBar: () => {
		throw new TypeError('Object has been destroyed');
	},
};

const progressCalls: number[] = [];
const liveMainWindow = {
	isDestroyed: () => false,
	setProgressBar: (progress: number) => {
		progressCalls.push(progress);
	},
};

let mainWindow: unknown = null;

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return { BrowserWindow: FakeBrowserWindow };
	if (request === './translations') return { t: (key: string) => key };
	if (request === './window') return { getMainWindow: () => mainWindow };
	return originalLoad.call(this, request, parent, isMain);
};

const exercise = (label: string) => {
	const { ProgressBar } = require('./progress-bar') as typeof import('./progress-bar');

	// Closed by the user (window X) mid-download: the `closed` handler must not throw.
	const closedByUser = new ProgressBar();
	const firstWindow = FakeBrowserWindow.instances[FakeBrowserWindow.instances.length - 1];
	assert.doesNotThrow(() => firstWindow.emit('closed'), `${label}: closed handler`);
	assert.doesNotThrow(() => closedByUser.updateProgress(10), `${label}: progress after close`);
	assert.equal(firstWindow.scripts.length, 0, `${label}: no JS into a closed window`);

	// Normal run: progress reaches the window, then the updater closes it.
	const bar = new ProgressBar();
	const win = FakeBrowserWindow.instances[FakeBrowserWindow.instances.length - 1];
	assert.doesNotThrow(() => bar.updateProgress(50), `${label}: updateProgress`);
	assert.equal(win.scripts.length, 1, `${label}: the progress window still gets its JS`);
	assert.match(win.scripts[0], /width = '50%'/);
	assert.doesNotThrow(() => bar.close(), `${label}: close`);
};

try {
	mainWindow = null;
	exercise('no main window');

	mainWindow = destroyedMainWindow;
	exercise('destroyed main window');

	mainWindow = liveMainWindow;
	exercise('live main window');
	assert.deepEqual(
		progressCalls,
		[-1, 0.5, -1, -1],
		'a live main window still gets the taskbar progress and its reset'
	);

	console.log('progress-bar.test.ts passed');
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	mutableModule._load = originalLoad;
}

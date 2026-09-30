import assert from 'assert/strict';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

// title-bar.ts reads nativeTheme at call time; give it a switchable one.
const electronStub = { nativeTheme: { shouldUseDarkColors: false } };
const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return electronStub;
	return originalLoad.call(this, request, parent, isMain);
};

const {
	applyWindowColorScheme,
	isWindowColorScheme,
	TITLE_BAR_HEIGHT,
	titleBarOptions,
	TRAFFIC_LIGHT_POSITION,
} = require('./title-bar') as typeof import('./title-bar');

type OverlayOptions = { height?: number; color?: string; symbolColor?: string };

function fakeWindow(destroyed = false) {
	const calls: OverlayOptions[] = [];
	return {
		calls,
		window: {
			isDestroyed: () => destroyed,
			setTitleBarOverlay: (options: OverlayOptions) => calls.push(options),
		} as unknown as import('electron').BrowserWindow,
	};
}

function onPlatform(platform: NodeJS.Platform, run: () => void) {
	const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	try {
		run();
	} finally {
		Object.defineProperty(process, 'platform', original);
	}
}

// --- window options -------------------------------------------------------

{
	const options = titleBarOptions();
	assert.equal(options.titleBarStyle, 'hidden', 'hides the native title bar (not frame: false)');
	assert.equal(options.frame, undefined, 'keeps the OS frame: shadow, resize edges, snap');
	assert.equal(options.autoHideMenuBar, true);
	assert.deepEqual(options.trafficLightPosition, TRAFFIC_LIGHT_POSITION);
	assert.equal(
		TRAFFIC_LIGHT_POSITION.y + 12 / 2,
		TITLE_BAR_HEIGHT / 2,
		'12px traffic lights are vertically centred in the strip'
	);
	const overlay = options.titleBarOverlay as OverlayOptions;
	assert.equal(overlay.height, TITLE_BAR_HEIGHT, 'overlay height matches the renderer strip');
	assert.equal(Number.isInteger(overlay.height), true, 'Electron requires an integer height');
	assert.match(overlay.color!, /^#[0-9a-f]{6}00$/i, 'overlay background is fully transparent');
}

// --- symbol colour follows the app theme, defaulting to the OS theme ---------

{
	electronStub.nativeTheme.shouldUseDarkColors = true;
	const dark = (titleBarOptions().titleBarOverlay as OverlayOptions).symbolColor;
	electronStub.nativeTheme.shouldUseDarkColors = false;
	const light = (titleBarOptions().titleBarOverlay as OverlayOptions).symbolColor;
	assert.notEqual(
		dark,
		light,
		'OS dark mode picks the dark-rail glyph colour before the renderer reports'
	);
	assert.equal((titleBarOptions('dark').titleBarOverlay as OverlayOptions).symbolColor, dark);
	assert.equal((titleBarOptions('light').titleBarOverlay as OverlayOptions).symbolColor, light);

	onPlatform('win32', () => {
		const { window, calls } = fakeWindow();
		applyWindowColorScheme(window, 'dark');
		applyWindowColorScheme(window, 'light');
		assert.equal(calls.length, 2, 'Windows repaints the overlay on every report');
		assert.equal(calls[0].symbolColor, dark);
		assert.equal(calls[1].symbolColor, light);
		assert.equal(calls[0].height, TITLE_BAR_HEIGHT, 'a repaint keeps the strip height');
		assert.equal(calls[0].color, calls[1].color, 'a repaint keeps the background transparent');
	});
}

// --- macOS paints its own buttons; a destroyed window is left alone ---------

onPlatform('darwin', () => {
	const { window, calls } = fakeWindow();
	applyWindowColorScheme(window, 'dark');
	assert.equal(calls.length, 0, 'setTitleBarOverlay is Windows/Linux only');
});

onPlatform('linux', () => {
	const { window, calls } = fakeWindow(true);
	applyWindowColorScheme(window, 'dark');
	assert.equal(calls.length, 0, 'never touches a destroyed window');
});

// --- channel payload validation ---------------------------------------------

assert.equal(isWindowColorScheme('light'), true);
assert.equal(isWindowColorScheme('dark'), true);
assert.equal(isWindowColorScheme('system'), false, 'the renderer resolves system before sending');
assert.equal(isWindowColorScheme(undefined), false);
assert.equal(isWindowColorScheme({ scheme: 'dark' }), false);

mutableModule._load = originalLoad;
console.log('title-bar tests passed');

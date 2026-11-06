import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

// The compiled module reads util.isDevelopment at call time, so flipping it here
// switches between the production and development app documents.
const utilMock = { isDevelopment: false };
const warnMessages: unknown[][] = [];

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === './util') return utilMock;
	if (request === './log') {
		return {
			logger: {
				debug() {},
				info() {},
				error() {},
				warn(...args: unknown[]) {
					warnMessages.push(args);
				},
			},
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

let appOriginModule: typeof import('./app-origin');
try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	appOriginModule = require('./app-origin') as typeof import('./app-origin');
} finally {
	mutableModule._load = originalLoad;
}
const { appOrigin, isAppUrl, guardMainFrameNavigation } = appOriginModule;

const savedPort = process.env.EXPO_PORT;
function inMode(development: boolean, port: string | undefined, run: () => void) {
	utilMock.isDevelopment = development;
	if (port === undefined) delete process.env.EXPO_PORT;
	else process.env.EXPO_PORT = port;
	try {
		run();
	} finally {
		utilMock.isDevelopment = false;
		if (savedPort === undefined) delete process.env.EXPO_PORT;
		else process.env.EXPO_PORT = savedPort;
	}
}

// --- appOrigin() ---------------------------------------------------------------
inMode(false, undefined, () => {
	assert.equal(appOrigin(), 'wcpos://-', 'production app origin');
});
inMode(true, undefined, () => {
	assert.equal(appOrigin(), 'http://localhost:8088', 'development defaults to port 8088');
});
inMode(true, '80', () => {
	assert.equal(appOrigin(), 'http://localhost', 'the default port is dropped, as a browser does');
});

// --- isAppUrl() ------------------------------------------------------------------
inMode(false, undefined, () => {
	assert.equal(isAppUrl('wcpos://-/'), true);
	assert.equal(isAppUrl('wcpos://-/cart?x=1'), true);
	assert.equal(isAppUrl('wcpos://evil/'), false);
	assert.equal(isAppUrl('https://store.example/'), false);
	assert.equal(isAppUrl(''), false);
	assert.equal(isAppUrl(undefined), false);
	assert.equal(isAppUrl('not a url'), false);
	assert.equal(
		isAppUrl('http://localhost:8088/x'),
		false,
		'the dev server is not the app in production'
	);
});
inMode(true, undefined, () => {
	assert.equal(isAppUrl('http://localhost:8088/x'), true);
	assert.equal(isAppUrl('http://localhost:9999/'), false);
	assert.equal(isAppUrl('wcpos://-/'), false, 'the packaged scheme is not the app in development');
});
inMode(true, 'not-a-port', () => {
	assert.doesNotThrow(
		() => isAppUrl('http://localhost:8088/'),
		'a malformed EXPO_PORT must not throw'
	);
	assert.equal(isAppUrl('http://localhost:8088/'), false, 'a malformed EXPO_PORT trusts nothing');
});

// --- guardMainFrameNavigation() ----------------------------------------------------
type NavEvent = { url: string; isMainFrame: boolean; prevented: boolean; preventDefault(): void };
function navEvent(url: string, isMainFrame: boolean): NavEvent {
	return {
		url,
		isMainFrame,
		prevented: false,
		preventDefault() {
			this.prevented = true;
		},
	};
}

const webContents = new EventEmitter();
guardMainFrameNavigation(webContents as never);

inMode(false, undefined, () => {
	const offNavigate = navEvent('https://store.example/pay?token=secret', true);
	webContents.emit('will-navigate', offNavigate);
	assert.equal(offNavigate.prevented, true, 'off-origin will-navigate is prevented');
	assert.ok(
		warnMessages.some((args) => args[1] === 'https://store.example/pay'),
		'the blocked URL is logged without its query string'
	);
	assert.ok(
		!warnMessages.some((args) => args.some((arg) => String(arg).includes('secret'))),
		'the query string never reaches the log'
	);

	const onNavigate = navEvent('wcpos://-/cart', true);
	webContents.emit('will-navigate', onNavigate);
	assert.equal(onNavigate.prevented, false, 'on-origin will-navigate passes');

	const offMainRedirect = navEvent('https://store.example/', true);
	webContents.emit('will-redirect', offMainRedirect);
	assert.equal(offMainRedirect.prevented, true, 'off-origin main-frame redirect is prevented');

	const offSubRedirect = navEvent('https://store.example/', false);
	webContents.emit('will-redirect', offSubRedirect);
	assert.equal(offSubRedirect.prevented, false, 'a subframe redirect passes, or checkout dies');

	const onMainRedirect = navEvent('wcpos://-/', true);
	webContents.emit('will-redirect', onMainRedirect);
	assert.equal(onMainRedirect.prevented, false, 'on-origin main-frame redirect passes');
});

console.log('app-origin assertions passed');

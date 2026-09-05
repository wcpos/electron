import assert from 'node:assert/strict';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

// `electron-store` needs a running Electron app; give install-id.ts an in-memory one.
const backing = new Map<string, unknown>();
class FakeStore {
	get(key: string) {
		return backing.get(key);
	}
	set(key: string, value: unknown) {
		backing.set(key, value);
	}
	delete(key: string) {
		backing.delete(key);
	}
}

// telemetry-consent.ts registers an ipcMain listener and pulls ./log (Sentry,
// electron-log, dialog) at import; stub both so the pure transition is testable.
const ipcListeners = new Map<string, (...args: unknown[]) => void>();
const electronStub = {
	app: { on() {}, getVersion: () => 'test' },
	BrowserWindow: { getAllWindows: (): unknown[] => [] },
	dialog: {},
	ipcMain: {
		on(channel: string, listener: (...args: unknown[]) => void) {
			ipcListeners.set(channel, listener);
		},
	},
};
const logCalls: string[] = [];
const logStub = {
	enableSentry: () => logCalls.push('enable'),
	disableSentry: () => logCalls.push('disable'),
	logger: { warn: (message: string) => logCalls.push(`warn:${message}`), info() {}, error() {} },
};

const initCalls: { enabled?: boolean }[] = [];
const users: unknown[] = [];
const sentryStub = {
	init: (options: { enabled?: boolean }) => initCalls.push(options),
	getClient: () => ({ getOptions: () => initCalls[0] }),
	setUser: (user: unknown) => users.push(user),
};
const loggerStub = {
	transports: { file: {}, console: {} },
	initialize() {},
	errorHandler: { startCatching() {} },
	error() {},
};
const originalNodeEnv = process.env.NODE_ENV;
const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === '@sentry/electron/main') return sentryStub;
	if (request === 'electron-log/main') return loggerStub;
	if (request === 'electron-store') {
		return { __esModule: true, default: FakeStore };
	}
	if (request === 'electron') {
		return electronStub;
	}
	if (request === './log') {
		return logStub;
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	const { ensureInstallId, getInstallId, resetInstallId } =
		require('./install-id') as typeof import('./install-id');

	const { isAbortedShellLoad, scrubBreadcrumbUrl, shouldDropEvent } =
		require('./sentry-filters') as typeof import('./sentry-filters');

	const { applyTelemetryConsent } =
		require('./telemetry-consent') as typeof import('./telemetry-consent');

	// --- install id -----------------------------------------------------------

	const persisted = new Map<string, unknown>();
	const store = {
		get: (key: string) => persisted.get(key),
		set: (key: string, value: string) => {
			persisted.set(key, value);
		},
	};
	let minted = 0;
	const mint = () => `minted-${++minted}`;

	assert.equal(ensureInstallId(store, mint), 'minted-1', 'mints an id when none is stored');
	assert.equal(persisted.get('installId'), 'minted-1', 'persists the minted id');
	assert.equal(ensureInstallId(store, mint), 'minted-1', 'returns the stored id on later calls');
	assert.equal(minted, 1, 'does not mint again once an id is stored');

	persisted.set('installId', '');
	assert.equal(ensureInstallId(store, mint), 'minted-2', 'treats an empty stored id as missing');
	persisted.set('installId', 42);
	assert.equal(
		ensureInstallId(store, mint),
		'minted-3',
		'treats a non-string stored id as missing'
	);

	const first = getInstallId();
	assert.match(first, /^[0-9a-f-]{36}$/, 'getInstallId mints a UUID through electron-store');
	assert.equal(backing.get('installId'), first, 'getInstallId persists through electron-store');
	assert.equal(getInstallId(), first, 'getInstallId is stable within a process');

	resetInstallId();
	assert.equal(backing.has('installId'), false, 'resetInstallId forgets the persisted id');
	const second = getInstallId();
	assert.notEqual(second, first, 'after a reset the next id is a fresh one');
	assert.equal(backing.get('installId'), second, 'the fresh id is persisted');

	// --- telemetry consent ----------------------------------------------------

	const calls: string[] = [];
	const consentDeps = {
		enable: () => calls.push('enable'),
		disable: () => calls.push('disable'),
		forgetInstallId: () => calls.push('forget'),
		persist: (consent: string) => calls.push(`persist:${consent}`),
	};

	assert.equal(applyTelemetryConsent('allowed', consentDeps), 'allowed');
	assert.deepEqual(calls.splice(0), ['persist:allowed', 'enable'], 'allowed persists then enables');

	assert.equal(applyTelemetryConsent('undecided', consentDeps), 'undecided');
	assert.deepEqual(
		calls.splice(0),
		['persist:undecided', 'disable'],
		'undecided disables but keeps the install id (no explicit refusal yet)'
	);

	assert.equal(applyTelemetryConsent('denied', consentDeps), 'denied');
	assert.deepEqual(
		calls.splice(0),
		['persist:denied', 'disable', 'forget'],
		'denied disables and forgets the install id'
	);

	assert.equal(applyTelemetryConsent('yes please', consentDeps), null);
	assert.equal(applyTelemetryConsent(undefined, consentDeps), null);
	assert.deepEqual(calls, [], 'unknown values change nothing');

	// Module wiring: boot honours a persisted "allowed", and the IPC listener
	// routes through the same transition.
	assert.equal(
		logCalls.includes('enable'),
		false,
		'no persisted consent → Sentry stays off at boot'
	);
	const consentListener = ipcListeners.get('telemetry-consent');
	assert.ok(consentListener, 'registers the telemetry-consent IPC listener');
	consentListener({}, 'allowed');
	assert.deepEqual(logCalls.splice(0), ['enable'], 'IPC allowed → enableSentry');
	assert.equal(backing.get('telemetryConsent'), 'allowed', 'IPC allowed is persisted');
	consentListener({}, 'nope');
	assert.match(logCalls.splice(0).join(), /^warn:/, 'IPC unknown value → warning, no change');

	// --- breadcrumb scrubbing -------------------------------------------------

	assert.deepEqual(
		scrubBreadcrumbUrl({
			data: { url: 'https://shop.example.com/wp-json/wcpos/v1/products?per_page=10' },
		}),
		{ data: { url: '/wp-json/wcpos/v1/products?per_page=10' } },
		'strips the store origin from breadcrumb urls'
	);
	assert.deepEqual(
		scrubBreadcrumbUrl({ data: { url: 'not a url', status_code: 200 } }),
		{ data: { url: 'not a url', status_code: 200 } },
		'leaves non-absolute urls alone'
	);
	assert.deepEqual(
		scrubBreadcrumbUrl({ category: 'electron' } as { data?: Record<string, unknown> }),
		{
			category: 'electron',
		},
		'passes breadcrumbs without a url through untouched'
	);

	// --- beforeSend filters ---------------------------------------------------

	const abortedLoad = {
		exception: { values: [{ type: 'Error', value: "ERR_FAILED (-2) loading 'wcpos://-'" }] },
	};
	const abortedLoadMessage = { message: "Error: ERR_FAILED (-2) loading 'wcpos://-'" };
	const otherError = {
		exception: { values: [{ type: 'TypeError', value: 'Object has been destroyed' }] },
	};

	assert.equal(isAbortedShellLoad(abortedLoad), true, 'matches the aborted shell load exception');
	assert.equal(
		isAbortedShellLoad(abortedLoadMessage),
		true,
		'matches the aborted shell load message'
	);
	assert.equal(isAbortedShellLoad(otherError), false, 'ignores unrelated errors');
	assert.equal(isAbortedShellLoad({}), false, 'tolerates an event with no exception or message');

	assert.equal(
		shouldDropEvent(abortedLoad, { quitting: true, windowsAlive: 1 }),
		true,
		'drops an aborted shell load while quitting'
	);
	assert.equal(
		shouldDropEvent(abortedLoad, { quitting: false, windowsAlive: 0 }),
		true,
		'drops an aborted shell load once every window is gone'
	);
	assert.equal(
		shouldDropEvent(abortedLoad, { quitting: false, windowsAlive: 1 }),
		false,
		'keeps an aborted shell load with a live window: that is a blank-screen bug'
	);
	assert.equal(
		shouldDropEvent(otherError, { quitting: true, windowsAlive: 0 }),
		false,
		'never drops other errors, even during shutdown'
	);

	// Loading log must initialise disabled before any later consent transition.
	process.env.NODE_ENV = 'production';
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- load real log after stubbing dependencies
	const { enableSentry, disableSentry } = require('./log.ts') as typeof import('./log');
	assert.equal(initCalls.length, 1, 'initialises at module load');
	assert.equal(initCalls[0].enabled, false);
	enableSentry();
	assert.equal(initCalls.length, 1, 'consent never reinitialises the SDK');
	assert.equal(initCalls[0].enabled, true);
	assert.deepEqual(users, [{ id: getInstallId() }]);
	disableSentry();
	assert.equal(initCalls[0].enabled, false);
	assert.equal(users[1], null);
	assert.equal(initCalls.length, 1);

	console.log('sentry-hygiene tests passed');
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	mutableModule._load = originalLoad;
	if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = originalNodeEnv;
}

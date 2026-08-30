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
}

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron-store') {
		return { __esModule: true, default: FakeStore };
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	const { ensureInstallId, getInstallId } =
		require('./install-id') as typeof import('./install-id');

	const { isAbortedShellLoad, shouldDropEvent } =
		require('./sentry-filters') as typeof import('./sentry-filters');

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

	console.log('sentry-hygiene tests passed');
} finally {
	mutableModule._load = originalLoad;
}

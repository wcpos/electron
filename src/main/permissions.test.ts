import assert from 'node:assert/strict';
import Module from 'node:module';

import { urlForLog } from './url-for-log';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

type RequestHandler = (
	webContents: unknown,
	permission: string,
	callback: (granted: boolean) => void,
	details: { requestingUrl?: string; isMainFrame?: boolean }
) => void;

class FakeSession {
	requestHandlerCalls = 0;
	requestHandler: RequestHandler | null = null;
	checkHandler: ((...args: unknown[]) => boolean) | null = null;
	deviceHandler: ((...args: unknown[]) => boolean) | null = null;
	setPermissionRequestHandler(handler: RequestHandler) {
		this.requestHandlerCalls += 1;
		this.requestHandler = handler;
	}
	setPermissionCheckHandler(handler: (...args: unknown[]) => boolean) {
		this.checkHandler = handler;
	}
	setDevicePermissionHandler(handler: (...args: unknown[]) => boolean) {
		this.deviceHandler = handler;
	}
}

const defaultSession = new FakeSession();
const partitions = new Map<string, FakeSession>();
const fakeSession = {
	defaultSession,
	fromPartition(name: string) {
		let ses = partitions.get(name);
		if (!ses) {
			ses = new FakeSession();
			partitions.set(name, ses);
		}
		return ses;
	},
};
const warnMessages: unknown[][] = [];

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return { session: fakeSession };
	if (request === './util') return { isDevelopment: false };
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

let permissionsModule: typeof import('./permissions');
try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	permissionsModule = require('./permissions') as typeof import('./permissions');
} finally {
	mutableModule._load = originalLoad;
}
const { registerPermissionHandlers } = permissionsModule;

registerPermissionHandlers();

function request(
	ses: FakeSession,
	permission: string,
	details: { requestingUrl?: string; isMainFrame?: boolean }
): boolean {
	const results: boolean[] = [];
	ses.requestHandler!({}, permission, (granted) => results.push(granted), details);
	assert.equal(results.length, 1, `callback invoked exactly once for ${permission}`);
	return results[0];
}

// --- Default session --------------------------------------------------------
const APP = 'wcpos://-/index.html';
const appMain = { requestingUrl: APP, isMainFrame: true };

assert.ok(defaultSession.requestHandler, 'default session has a request handler');
assert.equal(request(defaultSession, 'media', appMain), true, 'app main frame gets media');
assert.equal(
	request(defaultSession, 'clipboard-sanitized-write', appMain),
	true,
	'app main frame gets clipboard write'
);
assert.equal(
	request(defaultSession, 'fullscreen', appMain),
	true,
	'app main frame gets fullscreen'
);

const denied: [string, { requestingUrl?: string; isMainFrame?: boolean }][] = [
	['media', { requestingUrl: 'https://store.example/checkout', isMainFrame: false }],
	['media', { requestingUrl: APP, isMainFrame: false }],
	['openExternal', appMain],
	['openExternal', { requestingUrl: 'https://store.example/', isMainFrame: false }],
	['geolocation', appMain],
	['notifications', appMain],
	['media', { requestingUrl: undefined, isMainFrame: true }],
];
for (const [permission, details] of denied) {
	const before = warnMessages.length;
	assert.equal(
		request(defaultSession, permission, details),
		false,
		`${permission} from ${details.requestingUrl} (main frame: ${details.isMainFrame}) is denied`
	);
	assert.equal(warnMessages.length, before + 1, `denial of ${permission} logs one warn`);
	const logged = warnMessages[warnMessages.length - 1];
	assert.ok(logged.includes(permission), 'warn names the permission');
	assert.equal(
		logged[logged.length - 1],
		urlForLog(details.requestingUrl ?? ''),
		'warn logs the redacted url'
	);
}

// The redaction is the real one: a query string never reaches the log.
request(defaultSession, 'geolocation', {
	requestingUrl: 'https://store.example/cb?code=secret',
	isMainFrame: false,
});
const lastWarn = warnMessages[warnMessages.length - 1];
assert.equal(lastWarn[lastWarn.length - 1], 'https://store.example/cb');

// --- Isolated partitions ----------------------------------------------------
for (const name of ['persist:external-auth', 'external-print']) {
	const ses = partitions.get(name);
	assert.ok(ses, `fromPartition('${name}') was called`);
	assert.equal(request(ses, 'media', appMain), false, `${name} denies media`);
	assert.equal(request(ses, 'openExternal', appMain), false, `${name} denies openExternal`);
	assert.equal(ses.checkHandler!(null, 'media', 'wcpos://-', {}), false, `${name} check is false`);
	assert.equal(
		ses.deviceHandler!({ deviceType: 'serial', origin: 'wcpos://-' }),
		false,
		`${name} device handler is false`
	);
}

// --- Repeat call --------------------------------------------------------------
registerPermissionHandlers();
assert.equal(defaultSession.requestHandlerCalls, 1, 'second call does not re-register');
for (const ses of partitions.values()) assert.equal(ses.requestHandlerCalls, 1);

console.log('permissions tests passed');

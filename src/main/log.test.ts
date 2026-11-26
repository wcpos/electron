import assert from 'node:assert/strict';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const initializeCalls: unknown[] = [];
type SentryOptions = {
	beforeSend?: (event: { message?: string }, hint: unknown) => { message?: string } | null;
};
const sentryInitCalls: SentryOptions[] = [];
const loggerStub = {
	initialize: (options: unknown) => initializeCalls.push(options),
	transports: { file: { level: '' }, console: { level: '' } },
	errorHandler: { startCatching() {} },
	error() {},
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron-log' || request === 'electron-log/main') {
		return loggerStub;
	}
	if (request === '@sentry/electron/main') {
		return {
			init(options: SentryOptions): void {
				sentryInitCalls.push(options);
			},
			getClient: (): undefined => undefined,
			setUser(): void {},
		};
	}
	if (request === 'electron') {
		return {
			app: { on() {}, getVersion: () => 'test', quit() {} },
			BrowserWindow: { getAllWindows: (): unknown[] => [] },
			dialog: { showMessageBox: async () => ({ response: 2 }) },
		};
	}
	if (request === './install-id') {
		return { getInstallId: () => 'test-install-id' };
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- fakes must be installed before log.ts loads
	require('./log');
	assert.deepEqual(initializeCalls, [{ preload: true }]);
	assert.equal(sentryInitCalls.length, 1, 'initializes Sentry once');
	const { beforeSend } = sentryInitCalls[0];
	assert.ok(beforeSend, 'registers beforeSend');
	const event = beforeSend({ message: 'Order for jane@example.com failed' }, {});
	assert.ok(event?.message, 'beforeSend returns an event with a message');
	assert.doesNotMatch(event.message, /jane@example\.com/);
	assert.match(event.message, /\[EMAIL\]/);
	console.log('renderer-log tests passed');
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	mutableModule._load = originalLoad;
}

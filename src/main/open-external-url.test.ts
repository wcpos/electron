import assert from 'node:assert/strict';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
type Listener = (event: unknown, url: string) => void;

async function main() {
	const listeners = new Map<string, Listener>();
	const shellCalls: string[] = [];
	const noop = (): void => undefined;
	const mutableModule = Module as ModuleWithMutableLoad;
	const originalLoad = mutableModule._load;
	try {
		mutableModule._load = function (request, parent, isMain) {
			if (request === 'electron') {
				return {
					ipcMain: {
						on(channel: string, listener: Listener) {
							listeners.set(channel, listener);
						},
					},
					shell: {
						async openExternal(url: string) {
							shellCalls.push(url);
						},
					},
				};
			}
			if (request === './log')
				return { logger: { debug: noop, info: noop, warn: noop, error: noop } };
			return originalLoad.call(this, request, parent, isMain);
		};
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require('./open-external-url');
	} finally {
		mutableModule._load = originalLoad;
	}

	const listener = listeners.get('open-external-url');
	assert.ok(listener);
	listener({}, 'file:///C:/Windows/System32/calc.exe');
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(shellCalls, []);
	listener({}, 'https://example.com/path');
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(shellCalls, ['https://example.com/path']);
	console.log('open-external-url tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

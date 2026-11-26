import assert from 'node:assert/strict';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

let stored = true;
let disableCount = 0;

class FakeStore {
	get(key: string, fallback: unknown): unknown {
		return key === 'hardwareAcceleration' ? stored : fallback;
	}

	set(_key: string, value: boolean): void {
		stored = value;
	}
}

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') {
		return {
			app: {
				disableHardwareAcceleration: () => {
					disableCount += 1;
				},
				relaunch() {},
				exit() {},
			},
			dialog: { showErrorBox() {}, showMessageBox: () => Promise.resolve({ response: 0 }) },
		};
	}
	if (request === 'electron-store') {
		return { __esModule: true, default: FakeStore };
	}
	if (request === './log') {
		return {
			logger: { error() {}, info() {}, warn() {}, debug() {} },
			Sentry: { captureException() {} },
		};
	}
	if (request === './translations') {
		return { t: (key: string) => key };
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- test installs Module._load fakes before loading config.ts
	const { toggleHardwareAcceleration } = require('./config') as {
		toggleHardwareAcceleration: () => void;
	};

	stored = false;
	toggleHardwareAcceleration();
	assert.equal(
		disableCount,
		1,
		'calls app.disableHardwareAcceleration before ready when the store holds hardwareAcceleration=false'
	);

	stored = true;
	toggleHardwareAcceleration();
	assert.equal(
		disableCount,
		1,
		'leaves hardware acceleration on when the store holds hardwareAcceleration=true'
	);
	console.log('config tests passed');
} finally {
	mutableModule._load = originalLoad;
}

import assert from 'node:assert/strict';
import Module from 'node:module';

import { urlForLog } from './url-for-log';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const shellCalls: string[] = [];
let rejectNextOpen = false;
const logs: { info: unknown[][]; warn: unknown[][]; error: unknown[][] } = {
	info: [],
	warn: [],
	error: [],
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') {
		return {
			shell: {
				async openExternal(url: string) {
					shellCalls.push(url);
					if (rejectNextOpen) {
						rejectNextOpen = false;
						throw new Error('no handler');
					}
				},
			},
		};
	}
	if (request === './log') {
		return {
			logger: {
				debug() {},
				info(...args: unknown[]) {
					logs.info.push(args);
				},
				warn(...args: unknown[]) {
					logs.warn.push(args);
				},
				error(...args: unknown[]) {
					logs.error.push(args);
				},
			},
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

let safeModule: typeof import('./safe-external-url');
try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	safeModule = require('./safe-external-url') as typeof import('./safe-external-url');
} finally {
	mutableModule._load = originalLoad;
}
const { openExternalSafely } = safeModule;

function reset() {
	shellCalls.length = 0;
	logs.info.length = 0;
	logs.warn.length = 0;
	logs.error.length = 0;
}

async function main() {
	const refused: unknown[] = [
		'file:///C:/Windows/System32/calc.exe',
		'ms-msdt:/id PCWDiagnostic',
		'javascript:alert(1)',
		'smb://host/share',
		'not a url',
		'',
		undefined,
	];
	for (const input of refused) {
		reset();
		const label = String(input);
		assert.equal(await openExternalSafely(input), false, `${label} is refused`);
		assert.deepEqual(shellCalls, [], `${label} never reaches the shell`);
		assert.equal(logs.warn.length, 1, `${label} logs one warning`);
		assert.deepEqual(
			logs.warn[0],
			['Refused to open external URL:', urlForLog(String(input))],
			`${label} is logged redacted`
		);
		assert.equal(logs.info.length, 0, `${label} logs no open`);
	}

	const opened = [
		'https://example.com/path?q=1',
		'http://example.com/',
		'mailto:someone@example.com',
		'tel:+15551234567',
		'HTTPS://EXAMPLE.COM/',
	];
	for (const input of opened) {
		reset();
		assert.equal(await openExternalSafely(input), true, `${input} is opened`);
		assert.deepEqual(shellCalls, [input], `${input} reaches the shell once, unchanged`);
		assert.equal(logs.warn.length, 0, `${input} logs no warning`);
		assert.deepEqual(
			logs.info,
			[['Opening external URL:', urlForLog(input)]],
			`${input} is logged redacted`
		);
	}

	reset();
	rejectNextOpen = true;
	const failing = 'https://example.com/fail?token=secret';
	assert.equal(await openExternalSafely(failing), false, 'a shell rejection resolves false');
	assert.deepEqual(shellCalls, [failing], 'the shell was asked once');
	assert.equal(logs.error.length, 1, 'the rejection is logged as an error');
	assert.equal(logs.error[0][0], 'Failed to open external URL:');
	assert.equal(logs.error[0][1], urlForLog(failing), 'the failing URL is logged redacted');
	assert.ok(logs.error[0][2] instanceof Error, 'the error is logged');
	assert.ok(
		![...logs.info, ...logs.error].some((args) =>
			args.some((arg) => String(arg).includes('secret'))
		),
		'the query string never reaches the log'
	);

	console.log('safe-external-url assertions passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

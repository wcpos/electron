import assert from 'node:assert/strict';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

type TimeoutContext = { settled: () => boolean };

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;

const logs = {
	error: [] as string[],
	info: [] as string[],
};

mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === './log') {
		return {
			logger: {
				error(message: string) {
					logs.error.push(message);
				},
				info(message: string) {
					logs.info.push(message);
				},
				warn() {},
				debug() {},
			},
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

function resetLogs() {
	logs.error.length = 0;
	logs.info.length = 0;
}

async function withTrackedTimers<T>(
	fn: () => Promise<T>
): Promise<{ result: T; liveTimers: number }> {
	const liveTimers = new Set<unknown>();
	global.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
		const handle = originalSetTimeout(callback, ms, ...args);
		liveTimers.add(handle);
		return handle;
	}) as typeof setTimeout;
	global.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
		if (handle !== undefined) liveTimers.delete(handle);
		return originalClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
	}) as typeof clearTimeout;

	try {
		const result = await fn();
		return { result, liveTimers: liveTimers.size };
	} finally {
		for (const handle of liveTimers) {
			originalClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
		}
		global.setTimeout = originalSetTimeout;
		global.clearTimeout = originalClearTimeout;
	}
}

async function main() {
	const { sendRawPrint, withTimeout } = require('./raw-print') as typeof import('./raw-print');

	// sendRawPrint owns byte validation, Buffer conversion, success logging, and cleanup.
	resetLogs();
	let cleanupCalls = 0;
	let sentBytes: number[] | null = null;
	await sendRawPrint(
		{ data: [0x1b, 0x40, 0xff] },
		{
			label: 'test-printer',
			timeoutMs: 1_000,
			async send(bytes: Buffer) {
				assert.ok(Buffer.isBuffer(bytes), 'delivery should receive a Buffer');
				sentBytes = Array.from(bytes);
			},
			cleanup() {
				cleanupCalls += 1;
			},
		}
	);
	assert.deepEqual(sentBytes, [0x1b, 0x40, 0xff]);
	assert.equal(cleanupCalls, 1, 'cleanup should run after a successful send');
	assert.deepEqual(logs.error, []);
	assert.equal(logs.info.length, 1);
	assert.match(logs.info[0], /sent 3 bytes to test-printer/);

	await assert.rejects(
		() =>
			sendRawPrint(
				{ data: [0, 256] },
				{
					label: 'test-printer',
					timeoutMs: 1_000,
					async send() {},
					cleanup() {},
				}
			),
		/Invalid data/
	);

	// withTimeout clears its timer and runs cleanup on success.
	const success = await withTrackedTimers(async () => {
		let successCleanupCalls = 0;
		const result = await withTimeout(
			async () => 'ok',
			() => {
				successCleanupCalls += 1;
			},
			1_000,
			'should not time out'
		);
		assert.equal(result, 'ok');
		assert.equal(successCleanupCalls, 1, 'cleanup should run once on success');
		return successCleanupCalls;
	});
	assert.equal(success.result, 1);
	assert.equal(success.liveTimers, 0, 'success path should clear the timeout');

	// withTimeout clears its timer and runs cleanup on failure.
	const failure = await withTrackedTimers(async () => {
		let failureCleanupCalls = 0;
		await assert.rejects(
			() =>
				withTimeout(
					async () => {
						throw new Error('write failed');
					},
					() => {
						failureCleanupCalls += 1;
					},
					1_000,
					'should not time out'
				),
			/write failed/
		);
		assert.equal(failureCleanupCalls, 1, 'cleanup should run once on failure');
		return failureCleanupCalls;
	});
	assert.equal(failure.result, 1);
	assert.equal(failure.liveTimers, 0, 'failure path should clear the timeout');

	// withTimeout rejects on timeout and still runs cleanup.
	const timeout = await withTrackedTimers(async () => {
		let timeoutCleanupCalls = 0;
		await assert.rejects(
			() =>
				withTimeout(
					async () => new Promise<void>(() => undefined),
					() => {
						timeoutCleanupCalls += 1;
					},
					5,
					'raw print timed out'
				),
			/raw print timed out/
		);
		assert.equal(timeoutCleanupCalls, 1, 'cleanup should run when the timeout fires');
		return timeoutCleanupCalls;
	});
	assert.equal(timeout.result, 1);
	assert.equal(timeout.liveTimers, 0, 'timeout path should clear the timeout handle');

	// Ghost-print guard: if a resource opens after the timeout, settled() is true, write is skipped,
	// and cleanup runs again for the now-open resource.
	let lateOpen: (() => void) | null = null;
	let writeCalled = false;
	let ghostCleanupCalls = 0;
	const ghostPrint = withTimeout(
		(ctx: TimeoutContext) =>
			new Promise<void>((resolve) => {
				lateOpen = () => {
					if (!ctx.settled()) {
						writeCalled = true;
					}
					resolve();
				};
			}),
		() => {
			ghostCleanupCalls += 1;
		},
		5,
		'ghost print timed out'
	);
	ghostPrint.catch((_err: unknown): void => undefined);

	await assert.rejects(() => ghostPrint, /ghost print timed out/);
	assert.equal(ghostCleanupCalls, 1, 'cleanup should run when ghost-print timeout fires');
	assert.ok(lateOpen, 'late open callback should be captured');
	lateOpen();
	await new Promise<void>((resolve) => originalSetTimeout(resolve, 0));

	assert.equal(writeCalled, false, 'write should not run after settled() becomes true');
	assert.equal(
		ghostCleanupCalls,
		2,
		'cleanup should run again after the late-open operation settles'
	);

	console.log('raw-print tests passed');
}

main()
	.then(() => {
		mutableModule._load = originalLoad;
		global.setTimeout = originalSetTimeout;
		global.clearTimeout = originalClearTimeout;
	})
	.catch((error) => {
		mutableModule._load = originalLoad;
		global.setTimeout = originalSetTimeout;
		global.clearTimeout = originalClearTimeout;
		console.error(error);
		process.exit(1);
	});

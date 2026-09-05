import assert from 'node:assert/strict';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const logged: { level: string; args: unknown[] }[] = [];
const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === './log') {
		return {
			logger: {
				error: (...args: unknown[]) => logged.push({ level: 'error', args }),
				warn: (...args: unknown[]) => logged.push({ level: 'warn', args }),
			},
			Sentry: {
				captureException: () => {
					throw new Error('the real Sentry must not be reached from tests');
				},
			},
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

type Seams = typeof globalThis & {
	__wcposOnStorageRunFailure?: (failure: { target: string; error: unknown }) => void;
	__wcposOnIndexRebuild?: (rebuild: { target: string; reason: string; documents: number }) => void;
	__wcposOnStorageRecovery?: (event: Record<string, unknown> & { kind: string }) => void;
};

async function main() {
	let telemetry: typeof import('./rxdb-storage-telemetry');
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		telemetry = require('./rxdb-storage-telemetry');
	} finally {
		mutableModule._load = originalLoad;
	}
	const { installRxdbStorageTelemetry, RxdbStorageEvent, KIND_LEVELS } = telemetry;
	type StorageEvent = InstanceType<typeof RxdbStorageEvent>;

	// The registry names every kind the producers emit today — the wrapper's
	// report() calls and the patch prelude — so a renamed kind fails here
	// instead of silently reporting at the wrong level.
	assert.deepEqual(Object.keys(KIND_LEVELS).sort(), [
		'changes-file-discarded',
		'changes-file-salvage',
		'cleanup-recovery',
		'count-recovery',
		'hollow-row-dropped',
		'hollow-row-refused',
		'index-rebuilt',
		'index-reconcile-refused',
		'log-row-discarded',
		'stale-secondary-dropped',
		'stale-secondary-refused',
		'task-queue-run-failed',
	]);

	const captured: { event: StorageEvent; context: any }[] = [];
	installRxdbStorageTelemetry((event, context) => {
		captured.push({ event: event as StorageEvent, context });
		return 'event-id';
	});
	const seams = globalThis as Seams;
	assert.equal(typeof seams.__wcposOnStorageRunFailure, 'function');
	assert.equal(typeof seams.__wcposOnIndexRebuild, 'function');
	assert.equal(typeof seams.__wcposOnStorageRecovery, 'function');

	// A run failure: the message is the code, the offset-bearing error rides as
	// a redacted cause — V8's quoted input slice is merchant data.
	const parseError = new SyntaxError(
		'Unexpected token \'x\', "{"uuid":"a1","customer":"Jane Doe"... is not valid JSON at position 952'
	);
	seams.__wcposOnStorageRunFailure!({ target: 'pos_v4_abc/orders/v0', error: parseError });
	assert.equal(captured.length, 1);
	const runFailure = captured[0];
	assert.ok(runFailure.event instanceof RxdbStorageEvent);
	assert.equal(runFailure.event.message, 'rxdb-fs task-queue-run-failed');
	assert.equal(runFailure.event.name, 'RxdbStorageEvent');
	const cause = runFailure.event.cause as Error;
	assert.ok(cause instanceof Error && cause !== parseError);
	assert.equal(cause.name, 'SyntaxError');
	assert.equal(cause.message, 'Unexpected token \'x\', "…"... is not valid JSON at position 952');
	assert.ok(cause.stack!.startsWith(`SyntaxError: ${cause.message}\n    at `));
	assert.ok(!cause.stack!.includes('Jane Doe'));
	assert.equal(runFailure.context.level, 'error');
	assert.deepEqual(runFailure.context.tags, {
		subsystem: 'rxdb-fs',
		'rxdb-fs.code': 'task-queue-run-failed',
		'rxdb-fs.collection': 'orders',
	});
	assert.deepEqual(runFailure.context.fingerprint, ['rxdb-fs', 'task-queue-run-failed']);
	assert.equal(runFailure.context.extra.target, 'pos_v4_abc/orders/v0');
	assert.equal(
		runFailure.context.extra.cause,
		'SyntaxError: Unexpected token \'x\', "…"... is not valid JSON at position 952'
	);
	assert.ok(!/position 952/.test(runFailure.event.message), 'no offsets in the title');

	// A boot rebuild is a recovery: warning level, details as extra, and a
	// reason that embeds an error message is redacted like one.
	seams.__wcposOnIndexRebuild!({
		target: 'pos_v4_abc/coverageRecords',
		reason: 'boot-failed:Unexpected token \'}\', "{"coverageKey":1}" is not valid JSON',
		documents: 1370,
	});
	const rebuild = captured[1];
	assert.equal(rebuild.event.message, 'rxdb-fs index-rebuilt');
	assert.equal(rebuild.context.level, 'warning');
	assert.equal(rebuild.context.tags['rxdb-fs.collection'], 'coverageRecords');
	assert.deepEqual(rebuild.context.extra, {
		target: 'pos_v4_abc/coverageRecords',
		reason: 'boot-failed:Unexpected token \'}\', "…" is not valid JSON',
		documents: 1370,
		cause: undefined,
	});

	// Recovery-seam kinds: a lossless salvage warns, a discard errors.
	seams.__wcposOnStorageRecovery!({
		kind: 'changes-file-salvage',
		target: 'pos_v4_abc/orders',
		bytes: 1194,
		keptBulks: 1,
		quarantined: true,
		error: parseError,
	});
	const salvage = captured[2];
	assert.equal(salvage.event.message, 'rxdb-fs changes-file-salvage');
	assert.equal(salvage.context.level, 'warning');
	assert.deepEqual(salvage.context.extra, {
		target: 'pos_v4_abc/orders',
		bytes: 1194,
		keptBulks: 1,
		quarantined: true,
		cause: 'SyntaxError: Unexpected token \'x\', "…"... is not valid JSON at position 952',
	});

	seams.__wcposOnStorageRecovery!({
		kind: 'changes-file-discarded',
		target: 'pos_v4_abc/orders',
		reason: 'no-complete-bulk',
		bytes: 600,
		keptBulks: 0,
		quarantined: true,
		error: parseError,
	});
	assert.equal(captured[3].event.message, 'rxdb-fs changes-file-discarded');
	assert.equal(captured[3].context.level, 'error');
	assert.deepEqual(captured[3].context.fingerprint, ['rxdb-fs', 'changes-file-discarded']);

	seams.__wcposOnStorageRecovery!({
		kind: 'hollow-row-dropped',
		target: 'pos_v4_abc/orders',
		id: 'abc',
	});
	assert.equal(captured[4].context.level, 'warning');

	seams.__wcposOnStorageRecovery!({
		kind: 'hollow-row-refused',
		target: 'pos_v4_abc/orders',
		id: 'abc',
		reason: 'range-holds-foreign-bytes',
	});
	assert.equal(captured[5].context.level, 'error');
	assert.equal(captured[5].context.extra.reason, 'range-holds-foreign-bytes');

	const cleanupError = new Error('quota exceeded');
	seams.__wcposOnStorageRecovery!({
		kind: 'cleanup-recovery',
		target: 'pos_v4_abc/products',
		error: cleanupError,
	});
	assert.equal(captured[6].event.message, 'rxdb-fs cleanup-recovery');
	assert.equal((captured[6].event.cause as Error).message, 'quota exceeded');
	assert.equal(captured[6].context.level, 'error');

	// A kind the registry does not know reports at error; a missing target
	// still reports.
	seams.__wcposOnStorageRecovery!({ kind: 'something-new' });
	assert.equal(captured[7].context.level, 'error');
	assert.equal(captured[7].context.tags['rxdb-fs.collection'], 'unknown');

	assert.equal(captured.length, 8);
	assert.deepEqual(
		logged.map(({ level }) => level),
		['error', 'warn', 'warn', 'error', 'warn', 'error', 'error', 'error']
	);

	const discarded = {
		kind: 'log-row-discarded',
		target: 'store_v6_abc/logs',
		id: 'first',
		reason: 'no-valid-document',
	};
	seams.__wcposOnStorageRecovery!(discarded);
	seams.__wcposOnStorageRecovery!(discarded);
	assert.equal(captured.length, 9, 'identical reports capture once');
	assert.equal(captured[8].context.level, 'warning');
	seams.__wcposOnStorageRecovery!({ ...discarded, id: 'second' });
	assert.equal(captured.length, 10, 'a distinct id captures again');
	assert.equal(logged.length, 11, 'every report still logs');

	delete seams.__wcposOnStorageRunFailure;
	delete seams.__wcposOnIndexRebuild;
	delete seams.__wcposOnStorageRecovery;
	console.log('rxdb storage telemetry assertions passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

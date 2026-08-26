/**
 * Pins the containment guarantees of rxdb-premium's abstract-filesystem
 * `TaskQueue` — the queue every OPFS (web), filesystem-node (electron) and
 * expo-filesystem (native) storage instance runs its work through.
 *
 * Upstream runs each batch of tasks inside `abstractLock.request(...)` and ends
 * the run with `cleanupAfterRun(runState)`, which closes every access handle the
 * run opened. Neither `triggerReadTasks` nor `triggerWriteTasks` wraps that in a
 * `finally`, so a task that THROWS skips it:
 *
 *   - a throwing READ task is harmless: `runRead`'s task wrapper swallows the
 *     error (it rejects the caller's promise without rethrowing), so the run
 *     reaches `cleanupAfterRun` normally. Pinned here so that if upstream ever
 *     makes reads rethrow, it fails loudly instead of silently joining the
 *     write case. But the shared PRE-RUN hook (`beforeTaskReadOrWrite`, the
 *     changes-file replay) runs outside every task wrapper on READ and CLEANUP
 *     runs too, and its rejection unwinds those runs past cleanup exactly like
 *     a throwing write — the hook-failure tests below pin that containment.
 *   - a throwing WRITE is not: `runWrite`'s wrapper DOES rethrow. The run unwinds
 *     past `cleanupAfterRun`, leaking every access handle it opened — on OPFS
 *     they stay open for the life of the worker, so any later open of the same
 *     file throws `NoModificationAllowedError: ... another open Access Handle ...`
 *     — and it leaves `this.queue` a rejected promise. Every later task chains
 *     onto it with `.then(...)`, so its callback never runs and the promise
 *     handed to the caller NEVER SETTLES: a silent hang, no error, no rejection,
 *     no timeout. That is a screen spinning forever behind a healthy worker.
 *
 * The storm of identical console errors that accompanies this is one failure
 * being re-printed, not many failures: each later `trigger*Tasks` re-chains onto
 * the still-rejected queue, and the tail `.catch` logs the same original error
 * again.
 *
 * A throwing task is not exotic: every trigger the OPFS arc has chased (#761
 * partial writes, #763/#769/#770 malformed records, #773/#776 damaged indexes,
 * #798 whitespace rows, #1043 the cleanup storm, #1164 the resurrection leak)
 * surfaces as exactly this. Those fixes each retired one trigger; this file
 * pins the amplifier that turns any of them into a dead collection.
 *
 * Patched by `scripts/patch-rxdb-premium-task-queue-containment.mjs` at
 * postinstall — the same vehicle as the resurrection-leak patch, and for the
 * same reason (rxdb-premium's dist/ is materialized by its own license-gated
 * postinstall, so `pnpm patch` cannot reach it).
 *
 * These tests drive the REAL installed TaskQueue, not a stand-in: a fake would
 * only prove the fake behaves, which is the trap this arc has fallen into before.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('rxdb-premium/package.json'));

/**
 * Imported by path, not by specifier: `task-queue.js` is not in rxdb-premium's
 * `exports` map. Same resolution the postinstall patcher uses, so the test and
 * the patch are guaranteed to be talking about the same file on disk.
 */
const { TaskQueue, getAccessHandle } = await import(
	pathToFileURL(join(packageRoot, 'dist/esm/plugins/storage-abstract-filesystem/task-queue.js'))
		.href
);

/** Stands in for `navigator.locks` — the real lock is not the subject here. */
const passthroughLock = { request: async (_lockId, fn) => fn() };

/**
 * How long to wait before calling a promise hung. The queue does its work in
 * microtasks plus a 10ms `promiseWait` idle poll, so anything still unsettled
 * after this is not merely slow — the pre-patch hang never settles at all.
 */
const SETTLE_TIMEOUT_MS = 1000;

function createHarness({ beforeTaskReadOrWrite } = {}) {
	const opened = [];
	const fileHandle = {
		createAccessHandle: async () => {
			const handle = { closed: false, close: () => (handle.closed = true) };
			opened.push(handle);
			return handle;
		},
	};

	// The third constructor argument IS `beforeTaskReadOrWrite` — in production
	// it is the changes-file replay (`processChangesFileIfRequired`), which opens
	// access handles of its own and can genuinely reject (a torn or misapplied
	// changes file — the #1045 class). The hook-failure tests below stand on that.
	// The hook receives an `openHandle` so it can register handles on the run
	// state the way the real replay does, then fail.
	const queue = new TaskQueue(
		'containment-probe',
		passthroughLock,
		beforeTaskReadOrWrite
			? (runState) => beforeTaskReadOrWrite(runState, (rs) => getAccessHandle(fileHandle, rs))
			: async () => {}
	);
	// The queue only reaches for `primaryPath` on the write path; nothing here
	// exercises real storage, so the narrowest possible instance is right.
	queue.setStorageInstance({ primaryPath: 'id' });

	return {
		queue,
		opened,
		read: (task) => queue.runRead(task),
		write: (task) => queue.runWrite({ primaryPath: 'id', documentWrites: [], task }),
		cleanup: (fn) => queue.runCleanup(fn),
		init: (fn) => queue.runInit(fn),
		openHandle: (runState) => getAccessHandle(fileHandle, runState),
		/**
		 * Handles are closed by `cleanupAfterRun` at the END of a run, and a run
		 * only ends after a 10ms idle poll — well after the failing task's own
		 * promise has rejected. Asserting straight off that rejection reports a
		 * leak that is really just a race, so settle the queue first. `awaitIdle`
		 * awaits `this.queue`, which is exactly what a poisoned queue leaves
		 * rejected, so a failure here must not be mistaken for a leak.
		 */
		settleRun: async () => {
			try {
				await Promise.race([
					queue.awaitIdle(),
					new Promise((resolve) => {
						const timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);
						timer.unref?.();
					}),
				]);
			} catch {
				/* a rejected queue is the poisoning assertion's business, not ours */
			}
		},
		leakedHandles: () => opened.filter((handle) => !handle.closed),
	};
}

/**
 * Resolves to a verdict rather than propagating, so a hang is a readable
 * assertion failure instead of the whole test file timing out with no clue
 * which task never came back.
 */
async function settle(promise) {
	let timer;
	const verdict = await Promise.race([
		promise.then(
			(value) => ({ state: 'resolved', value }),
			(error) => ({ state: 'rejected', error })
		),
		new Promise((resolve) => {
			timer = setTimeout(() => resolve({ state: 'hung' }), SETTLE_TIMEOUT_MS);
			timer.unref?.();
		}),
	]);
	clearTimeout(timer);
	return verdict;
}

const boom = () => new Error('deliberate task failure');

test('a throwing read task closes the access handles its run opened', async () => {
	const harness = createHarness();

	const failed = await settle(
		harness.read(async (runState) => {
			await harness.openHandle(runState);
			throw boom();
		})
	);

	assert.equal(failed.state, 'rejected', 'the failing read must reject to its caller');
	await harness.settleRun();
	assert.equal(harness.opened.length, 1, 'the probe should have opened exactly one handle');
	assert.deepEqual(
		harness.leakedHandles(),
		[],
		'a leaked handle is what makes every later OPFS open fail with NoModificationAllowedError'
	);
});

test('a throwing write task closes the access handles its run opened', async () => {
	const harness = createHarness();

	const failed = await settle(
		harness.write(async (runState) => {
			await harness.openHandle(runState);
			throw boom();
		})
	);

	assert.equal(failed.state, 'rejected', 'the failing write must reject to its caller');
	await harness.settleRun();
	assert.equal(harness.opened.length, 1, 'the probe should have opened exactly one handle');
	assert.deepEqual(harness.leakedHandles(), [], 'the run must not leak its access handles');
});

test('a throwing read leaves the queue able to serve later work', async () => {
	const harness = createHarness();

	await settle(
		harness.read(async () => {
			throw boom();
		})
	);

	assert.deepEqual(
		await settle(harness.read(async () => 'read-ok')),
		{ state: 'resolved', value: 'read-ok' },
		'a later read must still settle'
	);
	assert.deepEqual(
		await settle(harness.write(async () => 'write-ok')),
		{ state: 'resolved', value: 'write-ok' },
		'a later write must still settle'
	);
});

test('a throwing write leaves the queue able to serve later work', async () => {
	const harness = createHarness();

	await settle(
		harness.write(async () => {
			throw boom();
		})
	);

	// Pre-patch these both report `hung`: `this.queue` is a rejected promise, so
	// every subsequent `.then(...)` callback is skipped and the caller's promise
	// never settles. That silence is the whole reason this class went unseen.
	assert.deepEqual(
		await settle(harness.read(async () => 'read-ok')),
		{ state: 'resolved', value: 'read-ok' },
		'a later read must still settle after a failed write'
	);
	assert.deepEqual(
		await settle(harness.write(async () => 'write-ok')),
		{ state: 'resolved', value: 'write-ok' },
		'a later write must still settle after a failed write'
	);
});

test('a run failure is reported once, naming the collection that owns it', async () => {
	// Upstream logs a bare "ERROR TaskQueue.triggerWriteTasks.queue errored:" with
	// no database and no collection, straight to the console. That is why past
	// incidents could never be traced back to a collection — the one line that
	// knows the answer does not print it.
	const reports = [];
	globalThis.__wcposOnStorageRunFailure = (report) => reports.push(report);

	try {
		const harness = createHarness();
		harness.queue.setStorageInstance({
			primaryPath: 'id',
			databaseName: 'scope-db',
			collectionName: 'coupons',
			schema: { version: 3 },
		});

		await settle(
			harness.write(async () => {
				throw boom();
			})
		);
		// Drive further work through the queue: pre-patch, every one of these
		// re-chains onto the still-rejected queue and re-reports the SAME failure,
		// which is what an "error storm" of identical messages actually is.
		await settle(harness.read(async () => 'read-ok'));
		await settle(harness.write(async () => 'write-ok'));

		assert.equal(reports.length, 1, 'one failure must be reported exactly once, not restormed');
		assert.equal(reports[0].target, 'scope-db/coupons/v3');
		assert.equal(reports[0].error.message, 'deliberate task failure');
	} finally {
		delete globalThis.__wcposOnStorageRunFailure;
	}
});

test('a failed task does not take its batch-mates down with it', async () => {
	const harness = createHarness();

	// Queued in the same tick so they share one run: the failure must be
	// contained to its own caller rather than rejecting the whole batch.
	const failing = harness.read(async () => {
		throw boom();
	});
	const healthy = harness.read(async () => 'sibling-ok');

	assert.equal((await settle(failing)).state, 'rejected');
	assert.deepEqual(await settle(healthy), { state: 'resolved', value: 'sibling-ok' });
});

// ---------------------------------------------------------------------------
// Pre-run-hook failures.
//
// `beforeTaskReadOrWrite` — the changes-file replay in production — runs at the
// start of READ and CLEANUP runs (and per-batch inside WRITE runs, which the
// write `finally` already covers). Its rejection happens OUTSIDE every per-task
// wrapper, so before the read/cleanup guards it unwound those runs past
// `cleanupAfterRun`: the same leak as a throwing write, reachable from a pure
// read. The replay opens access handles of its own before it can fail (that is
// how a torn changes file presents), so the hook here does exactly that.
//
// Deliberately NOT asserted: the failing run's own callers. Their tasks never
// execute and upstream has nothing that rejects them — a pre-existing, bounded
// semantic surfaced by the app-layer stall diagnostic, not part of what the
// patch changes.
// ---------------------------------------------------------------------------

/** A hook that opens a handle on the run state, then fails — once. */
function failingReplayHook() {
	let failed = false;
	return async (runState, openHandle) => {
		if (failed) return;
		failed = true;
		await openHandle(runState);
		throw new Error('deliberate replay failure');
	};
}

test('a failing replay hook on a READ run closes the handles it opened', async () => {
	const harness = createHarness({ beforeTaskReadOrWrite: failingReplayHook() });

	await settle(harness.read(async () => 'never-runs'));
	await harness.settleRun();

	assert.equal(harness.opened.length, 1, 'the hook should have opened exactly one handle');
	assert.deepEqual(
		harness.leakedHandles(),
		[],
		'a leaked replay handle blocks every later open of that file — across tabs too'
	);
	assert.deepEqual(
		await settle(harness.read(async () => 'read-ok')),
		{ state: 'resolved', value: 'read-ok' },
		'a later read must still settle after the failed run'
	);
	assert.deepEqual(
		await settle(harness.write(async () => 'write-ok')),
		{ state: 'resolved', value: 'write-ok' },
		'a later write must still settle after the failed run'
	);
});

test('a failing replay hook on a CLEANUP run closes the handles it opened', async () => {
	const harness = createHarness({ beforeTaskReadOrWrite: failingReplayHook() });

	await settle(harness.cleanup(async () => 'never-runs'));
	await harness.settleRun();

	assert.equal(harness.opened.length, 1, 'the hook should have opened exactly one handle');
	assert.deepEqual(harness.leakedHandles(), [], 'the cleanup run must not leak its handles');
	assert.deepEqual(
		await settle(harness.read(async () => 'read-ok')),
		{ state: 'resolved', value: 'read-ok' },
		'a later read must still settle after the failed run'
	);
});

test('INIT needs no guard: a failing init callback still cleans up and rejects its caller', async () => {
	// Upstream chains `cleanupAfterRun` AFTER the init callback's own `.catch`,
	// so it always runs — this pin is why the patcher has no INIT anchor. If an
	// upstream refactor breaks that chaining, this fails loudly.
	const harness = createHarness();

	const failed = await settle(
		harness.init(async (runState) => {
			await harness.openHandle(runState);
			throw boom();
		})
	);

	assert.equal(failed.state, 'rejected', 'the failing init must reject to its caller');
	await harness.settleRun();
	assert.equal(harness.opened.length, 1, 'the probe should have opened exactly one handle');
	assert.deepEqual(harness.leakedHandles(), [], 'the init run must not leak its handles');
});

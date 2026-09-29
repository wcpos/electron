import assert from 'node:assert/strict';

import { createStorageLock } from './storage-lock';

async function main() {
	const lock = createStorageLock();

	// Exclusive per name, in arrival order: a callback does not start until the
	// previous holder of the same name has settled.
	const order: string[] = [];
	let releaseFirst!: () => void;
	const first = lock.request('a', async () => {
		order.push('first:start');
		await new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		order.push('first:end');
		return 'first';
	});
	const second = lock.request('a', async () => {
		order.push('second');
		return 'second';
	});
	const other = lock.request('b', async () => {
		order.push('other');
		return 'other';
	});
	await other;
	assert.deepEqual(order, ['first:start', 'other'], 'a different name is not queued behind');
	releaseFirst();
	assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
	assert.deepEqual(order, ['first:start', 'other', 'first:end', 'second']);

	// The callback's rejection reaches the caller — the web-locks package
	// resolves regardless and leaks it as an unhandled rejection — and the
	// lock is released to the next waiter all the same.
	const leaked: unknown[] = [];
	const onUnhandled = (reason: unknown) => leaked.push(reason);
	process.on('unhandledRejection', onUnhandled);
	try {
		const failing = lock.request('a', async () => {
			throw new SyntaxError('run failed');
		});
		const after = lock.request('a', async () => 'after');
		await assert.rejects(failing, { name: 'SyntaxError', message: 'run failed' });
		assert.equal(await after, 'after');
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(leaked, []);
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}

	// The three-argument form (name, options, callback) is the Web Locks
	// signature premium may use; the callback is found either way.
	assert.equal(await lock.request('c', { mode: 'exclusive' }, async (handle) => handle.name), 'c');
	await assert.rejects(
		(lock as unknown as { request: (name: string) => Promise<unknown> }).request('d'),
		{ name: 'TypeError' }
	);

	console.log('storage lock assertions passed');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

/**
 * The task-queue lock for the main process's filesystem-node storage.
 *
 * rxdb-premium's filesystem-node plugin hands its TaskQueue the `web-locks`
 * package as the lock, and that package resolves `request()` whatever the
 * callback did: the callback's rejection is dropped (it surfaces only as an
 * unhandled promise rejection), so a storage run that throws never rejects the
 * queue and the containment patch's run-failure report never fires on desktop.
 * Sentry WOOCOMMERCE-POS-2M8 is that rejection — a write run's parse failure
 * captured as `unhandledPromiseRejection`, with no storage event beside it.
 *
 * `navigator.locks`, which the web worker's storage uses, settles `request()`
 * with the callback's outcome. This lock does the same: exclusive per name,
 * callbacks in arrival order, a rejection released to the caller and the lock
 * released to the next waiter either way. Cross-process exclusion is not
 * needed — the storage bridge is the one holder of these files.
 */
export interface StorageLockHandle {
	name: string;
	mode: 'exclusive';
}

export type StorageLockCallback<T> = (lock: StorageLockHandle) => Promise<T> | T;

export interface StorageLock {
	request<T>(name: string, callback: StorageLockCallback<T>): Promise<T>;
	request<T>(name: string, options: unknown, callback: StorageLockCallback<T>): Promise<T>;
}

export function createStorageLock(): StorageLock {
	const tails = new Map<string, Promise<void>>();
	return {
		request<T>(
			name: string,
			optionsOrCallback: unknown,
			maybeCallback?: StorageLockCallback<T>
		): Promise<T> {
			const callback = (
				typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
			) as StorageLockCallback<T> | undefined;
			if (!callback) return Promise.reject(new TypeError('storage lock: no callback'));
			const previous = tails.get(name) ?? Promise.resolve();
			const run = previous.then(() => callback({ name, mode: 'exclusive' }));
			// The tail only orders the next waiter; its own failure belongs to
			// the caller, never to whoever requests the lock after it.
			const settled: Promise<void> = run.then(
				(): void => undefined,
				(): void => undefined
			);
			tails.set(name, settled);
			void settled.then(() => {
				if (tails.get(name) === settled) tails.delete(name);
			});
			return run;
		},
	};
}

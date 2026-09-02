import { randomUUID } from 'node:crypto';

import Store from 'electron-store';

/**
 * A random, per-installation id for error reports.
 *
 * Sentry counts affected users by `user.id`; with none set every issue reads
 * `users=0`, so 257 events could be one till looping or 257 tills. The id is a
 * UUID minted once and kept in the app's config store (next to
 * `hardwareAcceleration`), so it survives "clear data" (which only removes the
 * database folders) and carries no personal information. src/main/window.ts
 * also hands it to the renderer so the app bundle's own reports share it.
 */
export interface InstallIdStore {
	get(key: 'installId'): unknown;
	set(key: 'installId', value: string): void;
}

export function ensureInstallId(store: InstallIdStore, mint: () => string = randomUUID): string {
	const existing = store.get('installId');
	if (typeof existing === 'string' && existing.length > 0) {
		return existing;
	}
	const id = mint();
	store.set('installId', id);
	return id;
}

let installId: string | undefined;

function openStore() {
	return new Store<{ installId?: string }>();
}

export function getInstallId(): string {
	if (installId === undefined) {
		try {
			const store = openStore();
			installId = ensureInstallId({
				get: (key) => store.get(key),
				set: (key, value) => store.set(key, value),
			});
		} catch {
			// An unwritable userData dir still gets a per-process id rather than none.
			installId = randomUUID();
		}
	}
	return installId;
}

/**
 * Forget the id (consent withdrawn): the next `getInstallId()` mints a fresh
 * one, so events after a later opt-in cannot be linked to events before.
 */
export function resetInstallId(): void {
	installId = undefined;
	try {
		openStore().delete('installId');
	} catch {
		// Nothing persisted to forget.
	}
}

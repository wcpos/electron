import { ipcMain } from 'electron';
import Store from 'electron-store';

import type { TelemetryConsent } from '@wcpos/printer/ipc-channels';

import { resetInstallId } from './install-id';
import { disableSentry, enableSentry, logger } from './log';

/**
 * Gates the main-process Sentry client on the merchant's tracking consent.
 *
 * The plugin owns the switch (POS > Settings > General, `tracking_consent`);
 * the renderer reads it off the store document and forwards it here over the
 * `telemetry-consent` channel. The last answer is persisted so the next boot
 * starts reporting before the renderer has even loaded — startup is where the
 * storage-corruption class fires — and a fresh install reports nothing until
 * the merchant has said yes.
 */
const CONSENT_VALUES: readonly TelemetryConsent[] = ['undecided', 'allowed', 'denied'];

export function isTelemetryConsent(value: unknown): value is TelemetryConsent {
	return typeof value === 'string' && (CONSENT_VALUES as readonly string[]).includes(value);
}

export interface TelemetryConsentDeps {
	enable(): void;
	disable(): void;
	forgetInstallId(): void;
	persist(consent: TelemetryConsent): void;
}

/**
 * Pure transition. `allowed` turns reporting on; anything else turns it off,
 * and an explicit `denied` also forgets the install id so a later `allowed`
 * cannot be linked to earlier events. Unknown values are ignored (returns null).
 */
export function applyTelemetryConsent(
	value: unknown,
	deps: TelemetryConsentDeps
): TelemetryConsent | null {
	if (!isTelemetryConsent(value)) {
		return null;
	}
	deps.persist(value);
	if (value === 'allowed') {
		deps.enable();
	} else {
		deps.disable();
		if (value === 'denied') {
			deps.forgetInstallId();
		}
	}
	return value;
}

const store = new Store<{ telemetryConsent?: TelemetryConsent }>();

const deps: TelemetryConsentDeps = {
	enable: enableSentry,
	disable: disableSentry,
	forgetInstallId: resetInstallId,
	persist: (consent) => store.set('telemetryConsent', consent),
};

// Boot: honour the last known answer.
if (store.get('telemetryConsent') === 'allowed') {
	enableSentry();
}

ipcMain.on('telemetry-consent', (_event, value: unknown) => {
	if (applyTelemetryConsent(value, deps) === null) {
		logger.warn(`[telemetry-consent] ignored unknown consent value: ${String(value)}`);
	}
});

import { session } from 'electron';

import { isAppUrl } from './app-origin';
import { logger } from './log';
import { urlForLog } from './url-for-log';

// Permissions the app document itself uses (camera scanner, clipboard copy, fullscreen).
// Serial, HID and Bluetooth go through the device handlers in device-select.ts and
// bluetooth-select.ts, not through this request handler.
export const APP_GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
	'media',
	'clipboard-read',
	'clipboard-sanitized-write',
	'fullscreen',
]);

// Sessions that only ever host pages the store or an outside site controls
// (auth-handler.ts sign-in, print-external-url.ts receipt print): they get nothing.
export const ISOLATED_PARTITIONS: readonly string[] = ['persist:external-auth', 'external-print'];

/** True only for an app-used permission asked for by the app document's own main frame. */
export function shouldGrantAppPermission(
	permission: string,
	details: { requestingUrl?: string; isMainFrame?: boolean }
): boolean {
	return (
		APP_GRANTED_PERMISSIONS.has(permission) &&
		details.isMainFrame === true &&
		isAppUrl(details.requestingUrl)
	);
}

let registered = false;

/**
 * Replace Electron's default request handler, which grants every request, with
 * explicit answers. The default session's check handler is left to device-select.ts.
 * Call once after app ready; later calls are no-ops.
 */
export function registerPermissionHandlers(): void {
	if (registered) return;
	registered = true;

	session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
		const ok = shouldGrantAppPermission(permission, details);
		if (!ok) {
			logger.warn('Denied permission request:', permission, urlForLog(details.requestingUrl ?? ''));
		}
		callback(ok);
	});

	for (const name of ISOLATED_PARTITIONS) {
		const ses = session.fromPartition(name);
		ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		ses.setPermissionCheckHandler(() => false);
		ses.setDevicePermissionHandler(() => false);
	}
}

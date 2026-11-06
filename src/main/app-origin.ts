import { logger } from './log';
import { urlForLog } from './url-for-log';
import { isDevelopment } from './util';

import type { WebContents } from 'electron';

// electron-serve's default hostname for the packaged app document (wcpos://-).
const PRODUCTION_ORIGIN = 'wcpos://-';

/** The origin string a browser sends for the app document. */
export function appOrigin(): string {
	if (!isDevelopment) return PRODUCTION_ORIGIN;
	// Through the URL parser so a port the scheme defaults (80) is dropped, as a browser does.
	return new URL(`http://localhost:${process.env.EXPO_PORT || '8088'}`).origin;
}

/**
 * True only for a URL on the app's own document origin. Malformed input is false.
 * A custom scheme's URL.origin is 'null' in Node, so production compares the
 * protocol and hostname instead.
 */
export function isAppUrl(value: string | undefined): boolean {
	if (!value) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (!isDevelopment) return url.protocol === 'wcpos:' && url.hostname === '-';
	return url.origin === appOrigin();
}

/**
 * Refuse any main-frame navigation off the app's own origin. The checkout and
 * receipt iframes run store pages in this window; without this, a script there
 * could set top.location and replace the app. Subframe redirects pass, or
 * checkout redirects inside the iframe would die.
 */
export function guardMainFrameNavigation(webContents: WebContents): void {
	webContents.on('will-navigate', (event) => {
		if (isAppUrl(event.url)) return;
		event.preventDefault();
		logger.warn('Blocked main-frame navigation off the app origin:', urlForLog(event.url));
	});
	webContents.on('will-redirect', (event) => {
		if (!event.isMainFrame || isAppUrl(event.url)) return;
		event.preventDefault();
		logger.warn('Blocked main-frame redirect off the app origin:', urlForLog(event.url));
	});
}

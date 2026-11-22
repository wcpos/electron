import { shell } from 'electron';

import { logger } from './log';
import { urlForLog } from './url-for-log';

// Web, email and phone links only: any other scheme hands page content an OS protocol handler.
export const ALLOWED_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set([
	'https:',
	'http:',
	'mailto:',
	'tel:',
]);

export function isAllowedExternalUrl(url: unknown): boolean {
	if (typeof url !== 'string') return false;
	try {
		// The URL parser already lowercases the scheme.
		return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
	} catch {
		return false;
	}
}

/** The one path from page content to shell.openExternal. Logs redacted; never throws. */
export async function openExternalSafely(url: unknown): Promise<boolean> {
	if (!isAllowedExternalUrl(url)) {
		logger.warn('Refused to open external URL:', urlForLog(String(url)));
		return false;
	}
	const allowed = url as string;
	logger.info('Opening external URL:', urlForLog(allowed));
	try {
		await shell.openExternal(allowed);
		return true;
	} catch (error) {
		logger.error('Failed to open external URL:', urlForLog(allowed), error);
		return false;
	}
}

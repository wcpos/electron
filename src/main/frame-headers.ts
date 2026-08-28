import { isDevelopment } from './util';

import type { Session, WebFrameMain } from 'electron';

const CSP_HEADERS = new Set(['content-security-policy', 'content-security-policy-report-only']);

/**
 * The checkout and receipt screens render the store's page in an <iframe> owned
 * by our own document, so a store whose server, CDN or security plugin sends
 * X-Frame-Options (or a CSP frame-ancestors directive) leaves the cashier with
 * a blank frame and no error. The plugin cannot fix that: it only strips a
 * header PHP set, never one the web server or CDN appends afterwards.
 *
 * Relaxing it here is safe ONLY for a frame our own document created. A page
 * nested deeper — a gateway's iframe, or third-party script injected into the
 * store page — is also reported as `subFrame`, and stripping anti-framing
 * headers there would hand a compromised checkout page the ability to frame and
 * clickjack an unrelated site (the merchant's own wp-admin, for one) inside the
 * app. So the relaxation is bounded to a DIRECT child of the app's top document,
 * and anything we cannot positively identify is left untouched.
 */
function isAppOwnedChildFrame(frame: WebFrameMain | null | undefined): boolean {
	// `frame` is null once the frame has navigated or been destroyed: fail closed.
	if (!frame?.parent || !frame.top) return false;
	// Depth 1 only — the parent must itself be the top-level document.
	if (frame.parent !== frame.top) return false;

	const topURL = frame.top.url;
	return topURL.startsWith('wcpos://') || (isDevelopment && topURL.startsWith('http://localhost'));
}

/**
 * A header field may carry several comma-separated policies. Filter each policy
 * independently, or `frame-ancestors 'none', default-src 'self'` would drop
 * `default-src` with it, and `default-src 'self', frame-ancestors 'none'` would
 * keep the blocking directive and leave the frame blank.
 */
function stripFrameAncestors(value: string): string {
	return value
		.split(',')
		.map((policy) =>
			policy
				.split(';')
				.map((directive) => directive.trim())
				.filter((directive) => directive && !/^frame-ancestors(?:\s|$)/i.test(directive))
				.join('; ')
		)
		.filter(Boolean)
		.join(', ');
}

export function registerFrameHeaderRelaxation(session: Session): void {
	session.webRequest.onHeadersReceived((details, callback) => {
		if (details.resourceType !== 'subFrame' || !isAppOwnedChildFrame(details.frame)) {
			callback({});
			return;
		}

		const responseHeaders: Record<string, string[]> = {};
		for (const [name, values] of Object.entries(details.responseHeaders ?? {})) {
			const lowerName = name.toLowerCase();
			if (lowerName === 'x-frame-options') continue;

			if (CSP_HEADERS.has(lowerName)) {
				const filteredValues = values.map(stripFrameAncestors).filter(Boolean);
				if (filteredValues.length > 0) responseHeaders[name] = filteredValues;
				continue;
			}

			responseHeaders[name] = values;
		}

		callback({ responseHeaders });
	});
}

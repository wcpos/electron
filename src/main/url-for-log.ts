/**
 * A URL as main.log may show it: scheme, host and path. The query string and the
 * fragment carry OAuth parameters, so they are never logged.
 */
export function urlForLog(url: string): string {
	try {
		const u = new URL(url);
		// The path of a mailto/tel URL is the address or phone number itself.
		if (u.protocol === 'mailto:' || u.protocol === 'tel:') return u.protocol;
		return `${u.protocol}//${u.host}${u.pathname}`;
	} catch {
		return '<unparsable url>';
	}
}

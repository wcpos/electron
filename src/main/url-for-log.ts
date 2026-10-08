/**
 * A URL as main.log may show it: scheme, host and path. The query string and the
 * fragment carry OAuth parameters, so they are never logged.
 */
export function urlForLog(url: string): string {
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.host}${u.pathname}`;
	} catch {
		return '<unparsable url>';
	}
}

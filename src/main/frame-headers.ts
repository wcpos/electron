import type { Session } from 'electron';

const CSP_HEADERS = new Set(['content-security-policy', 'content-security-policy-report-only']);

export function registerFrameHeaderRelaxation(session: Session): void {
	session.webRequest.onHeadersReceived((details, callback) => {
		if (details.resourceType !== 'subFrame') {
			callback({});
			return;
		}

		const responseHeaders: Record<string, string[]> = {};
		for (const [name, values] of Object.entries(details.responseHeaders ?? {})) {
			const lowerName = name.toLowerCase();
			if (lowerName === 'x-frame-options') continue;

			if (CSP_HEADERS.has(lowerName)) {
				const filteredValues = values
					.map((value) =>
						value
							.split(';')
							.map((directive) => directive.trim())
							.filter((directive) => !/^frame-ancestors(?:\s|$)/i.test(directive))
							.join('; ')
					)
					.filter(Boolean);
				if (filteredValues.length > 0) responseHeaders[name] = filteredValues;
				continue;
			}

			responseHeaders[name] = values;
		}

		callback({ responseHeaders });
	});
}

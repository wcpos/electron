// Ported verbatim from wcpos/monorepo packages/utils/src/logger/redact.ts and sentry-core.ts at d2c6894f2 (email/phone masking only). Keep in sync; do not tune here.

const EMAIL =
	/(^|[^\w.%+\-\u00a1-\uffff])[\w.%+\-\u00a1-\uffff]{1,64}(?:@|%40)(?:[\w\-\u00a1-\uffff]{1,63}\.){1,8}[a-z\u00a1-\uffff]{2,63}/gi;
const PHONE = /(^|[^\w+.-])(\+?\(?\d{1,15}(?:[ .()-]{1,3}\d{1,15}){0,14})(?![\w-]|[.:]\d)/g;
const PHONE_FIELD =
	/(^|[^a-z_])([a-z_]{0,32}(?:phone|tel|mobile)[a-z_]{0,32}["']?\s{0,3}[:=]\s{0,3}["']?)([^\s"'&,;}]{1,64})/gi;
const PHONE_DATE = /^\d{4}[-.]\d{1,2}[-.]\d{1,2}(?!\d)/;
const IPV4 =
	/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\.?\d)/;

export function redactPersonalData(value: string): string {
	return value
		.replace(EMAIL, '$1[EMAIL]')
		.replace(PHONE, (match, prefix, phone) => {
			const digits = phone.replace(/\D/g, '').length;
			const groups = phone.split(/\D+/).filter(Boolean).length;
			return digits >= 7 &&
				digits <= 15 &&
				(phone.startsWith('+') || groups >= (/[ ()-]/.test(phone) ? 2 : 3)) &&
				!PHONE_DATE.test(phone) &&
				!IPV4.test(phone)
				? `${prefix}[PHONE]`
				: match;
		})
		.replace(PHONE_FIELD, (match, prefix, key, phone) =>
			/\d/.test(phone) ? `${prefix}${key}[PHONE]` : match
		);
}

const QUERY_VALUE = /([?&][^=&#\s]{1,64}=)([^&#\s]{1,2048})/g;

function scrubQueryValues(text: string): string {
	return text.replace(QUERY_VALUE, (match, key: string, value: string) => {
		let decoded: string;
		try {
			decoded = decodeURIComponent(value.replace(/\+/g, ' '));
		} catch {
			return match;
		}
		const scrubbed = redactPersonalData(key + decoded);
		return scrubbed === key + decoded ? match : scrubbed;
	});
}

export function scrubPii(value: string): string {
	return redactPersonalData(scrubQueryValues(value));
}

const PHONE_KEY = /phone|tel|mobile/i;
const MAX_SCRUB_DEPTH = 10;

export function scrubPiiValues(value: unknown, ancestors: object[] = []): unknown {
	if (typeof value === 'string') return scrubPii(value);
	if (value === null || typeof value !== 'object') return value;
	if (ancestors.includes(value)) return '[Circular]';
	if (ancestors.length >= MAX_SCRUB_DEPTH) return '[Depth]';
	const next = [...ancestors, value];
	if (value instanceof Error) {
		return {
			name: scrubPii(value.name),
			message: scrubPii(value.message),
			...(typeof value.stack === 'string' ? { stack: scrubPii(value.stack) } : {}),
		};
	}
	if (Array.isArray(value)) return value.map((item) => scrubPiiValues(item, next));
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			typeof item === 'string' && PHONE_KEY.test(key) ? '[PHONE]' : scrubPiiValues(item, next),
		])
	);
}

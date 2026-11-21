import assert from 'node:assert/strict';

import { redactPersonalData, scrubPii, scrubPiiValues } from './pii-redact';
import { maskPersonalDataInBreadcrumb, maskPersonalDataInEvent } from './sentry-filters';

const MASKS: [string, string][] = [
	['jane.doe+pos@example.co.uk', '[EMAIL]'],
	['+61 412 345 678', '[PHONE]'],
	['0412 345 678', '[PHONE]'],
	['+34 612 345 678', '[PHONE]'],
	['+34612345678', '[PHONE]'],
	['(555) 123-4567', '[PHONE]'],
	['06 12 34 56 78', '[PHONE]'],
	['06.12.34.56.78', '[PHONE]'],
	['555.123.4567', '[PHONE]'],
	['jane%40example.com', '[EMAIL]'],
	['/orders?email=jane%40example.com', '/orders?email=[EMAIL]'],
	['jane@exämple.de', '[EMAIL]'],
	['Context: {"phone":"0612345678"}', 'Context: {"phone":"[PHONE]"}'],
	['?mobile=0612345678', '?mobile=[PHONE]'],
	['(02) 9876 5432', '[PHONE]'],
	['555-123-4567', '[PHONE]'],
	['+1 (555) 123-4567', '[PHONE]'],
	['call 0412 345 678.', 'call [PHONE].'],
];

const PRESERVES = [
	'0412345678',
	'1234567',
	'/orders/1234567',
	'1763287940123',
	'Build 20261116',
	'Mon Nov 16 2026 10:12:20 GMT+0100 (Central European Standard Time)',
	'index.js:2:1234567',
	'(1234567)',
	'550e8400-e29b-41d4-a716-446655440000',
	'12345678-1234-1234-1234-123456789012',
	'2.0.4',
	'2026.11.19',
	'192.168.100.200',
	'192.168.1.10:8080',
	'telemetry: allowed',
	'2026-11-16',
	'2026-11-16T10:12:20.123Z',
	'2026-11-16 10:12:20',
	'123e4567-e89b-12d3-a456-426614174000',
	'1.10.18',
	'order 12345',
	'HTTP 503',
	'1234567.89',
	'https://[REDACTED]@shop.example.com/wp-json',
];

for (const [input, expected] of MASKS) {
	assert.equal(redactPersonalData(input), expected, `masks ${input}`);
}
for (const input of PRESERVES) {
	for (const scrub of [redactPersonalData, scrubPii]) {
		assert.equal(scrub(input), input, `${scrub.name} preserves ${input}`);
	}
}

const query = '/customers?q=%2B34%20612%20345%20678';
assert.equal(scrubPii(query).includes('612'), false, `decodes and masks ${query}`);
assert.deepEqual(
	scrubPiiValues({ phone: '0612345678', billing: { mobile: 'x1' } }),
	{ phone: '[PHONE]', billing: { mobile: '[PHONE]' } },
	'masks phone 0612345678 and nested mobile x1'
);
const circular: Record<string, unknown> = {};
circular.self = circular;
assert.deepEqual(scrubPiiValues(circular), { self: '[Circular]' }, 'handles a self reference');

const event = {
	message: 'jane@example.com',
	exception: { values: [{ type: 'jane@example.com', value: 'jane@example.com' }] },
	request: { url: '/customers?email=jane@example.com' },
	extra: { email: 'jane@example.com' },
	contexts: { customer: { email: 'jane@example.com' } },
	breadcrumbs: [{ message: 'jane@example.com', data: { email: 'jane@example.com' } }],
};
const result = maskPersonalDataInEvent(event);
assert.ok(result && !JSON.stringify(result).includes('jane@'), 'masks jane@example.com in event');
assert.deepEqual(
	maskPersonalDataInBreadcrumb({ message: '+34 612 345 678', data: { phone: '0612345678' } }),
	{ message: '[PHONE]', data: { phone: '[PHONE]' } },
	'masks breadcrumb message +34 612 345 678 and phone 0612345678'
);

const throwing = {
	get email(): string {
		throw new Error('getter failed');
	},
};
for (const [name, masked] of [
	['event extra getter', maskPersonalDataInEvent({ extra: throwing })],
	['breadcrumb data getter', maskPersonalDataInBreadcrumb({ data: throwing })],
]) {
	assert.equal(masked, null, `drops ${name} without throwing`);
}
assert.equal(
	maskPersonalDataInEvent({ message: 42 as unknown as string })?.message,
	'42',
	'coerces event message 42 to a string'
);

const PERFORMANCE = [
	'a'.repeat(100_000),
	'1-'.repeat(50_000),
	'1 '.repeat(50_000),
	'1.'.repeat(50_000),
	'tel'.repeat(33_334),
	'a@'.repeat(50_000),
];
for (const input of PERFORMANCE) {
	const start = performance.now();
	scrubPii(input);
	const elapsed = performance.now() - start;
	assert.ok(elapsed < 50, `${input.slice(0, 12)} (${input.length} chars) took ${elapsed} ms`);
}

console.log('pii-redact tests passed');

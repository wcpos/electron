import assert from 'node:assert/strict';

import { redactPersonalData, scrubPii, scrubPiiValues } from './pii-redact';
import {
	maskPersonalDataInBreadcrumb,
	maskPersonalDataInEvent,
	type SentryEventLike,
} from './sentry-filters';

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
assert.equal(
	maskPersonalDataInBreadcrumb({ data: { 'url.query': 'q=%2B61%20412%20345%20678&x=1' } })?.data[
		'url.query'
	],
	'q=[PHONE]&x=1',
	'masks an encoded phone in the first breadcrumb query parameter'
);
assert.equal(
	maskPersonalDataInBreadcrumb({ data: { 'url.query': 'page=2&per_page=10' } })?.data['url.query'],
	'page=2&per_page=10',
	'preserves a non-personal breadcrumb query without adding a question mark'
);

const sdkContexts = () => ({
	os: { name: 'Windows', version: '10.0.26100' },
	chrome: { version: '142.0.7444.59' },
	app: { telemetry: 'on' },
});
assert.deepEqual(
	maskPersonalDataInEvent({ contexts: sdkContexts() })?.contexts,
	sdkContexts(),
	'keeps os 10.0.26100, chrome 142.0.7444.59 and app telemetry contexts'
);
const gpuAndBrowserContexts = () => ({
	gpu: {
		name: 'NVIDIA GeForce RTX 3060',
		vendor_name: 'NVIDIA',
		driver_version: '31.0.15.5222',
		id: 9476,
		vendor_id: 4318,
	},
	gpu_1: { name: 'Intel(R) UHD Graphics 630', driver_version: '31.0.101.2125', id: 16018 },
	browser: { name: 'Chrome', version: '142.0.7444.59' },
});
assert.deepEqual(
	maskPersonalDataInEvent({ contexts: gpuAndBrowserContexts() })?.contexts,
	gpuAndBrowserContexts(),
	'keeps gpu 31.0.15.5222, gpu_1 31.0.101.2125 and browser 142.0.7444.59 contexts'
);
const maskedGpuX = maskPersonalDataInEvent({
	contexts: { gpu_x: { driver_version: '31.0.15.5222' } },
});
assert.equal(maskedGpuX?.contexts.gpu_x.driver_version, '[PHONE]', 'masks gpu_x 31.0.15.5222');
const customer = { email: 'jane@example.com', phone: '+61 412 345 678' };
const mixed = maskPersonalDataInEvent({
	contexts: { ...sdkContexts(), customer: { ...customer } },
});
const maskedCustomer = mixed?.contexts?.customer as Record<string, unknown> | undefined;
assert.ok(maskedCustomer, 'keeps the customer context');
assert.equal(
	String(maskedCustomer.email).includes(customer.email),
	false,
	'masks customer email in contexts'
);
assert.equal(
	String(maskedCustomer.phone).includes(customer.phone),
	false,
	'masks customer phone in contexts'
);
assert.equal(
	(mixed?.contexts?.os as { version?: string } | undefined)?.version,
	'10.0.26100',
	'keeps os version 10.0.26100 next to a masked customer context'
);
assert.equal(
	maskPersonalDataInEvent<SentryEventLike>({ message: 'x' })?.contexts,
	undefined,
	'leaves missing contexts undefined'
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

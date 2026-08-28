import assert from 'assert/strict';

import { registerFrameHeaderRelaxation } from './frame-headers';

import type { Session } from 'electron';

type ResponseHeaders = Record<string, string[]>;
type HeadersReceivedResponse = { responseHeaders?: ResponseHeaders };
type HeadersReceivedListener = (
	details: { resourceType: string; responseHeaders?: ResponseHeaders },
	callback: (response: HeadersReceivedResponse) => void
) => void;

let listener: HeadersReceivedListener | undefined;
const fakeSession = {
	webRequest: {
		onHeadersReceived(nextListener: HeadersReceivedListener) {
			listener = nextListener;
		},
	},
};

registerFrameHeaderRelaxation(fakeSession as unknown as Session);
assert.ok(listener, 'frame-header relaxation should register a headers-received listener');

function receive(resourceType: string, responseHeaders: ResponseHeaders) {
	let response: HeadersReceivedResponse | undefined;
	listener!({ resourceType, responseHeaders }, (nextResponse) => {
		response = nextResponse;
	});
	assert.ok(response, 'headers-received listener should invoke its callback');
	return response;
}

assert.deepEqual(
	receive('subFrame', {
		'X-Frame-Options': ['DENY'],
		'Content-Type': ['text/html'],
	}).responseHeaders,
	{ 'Content-Type': ['text/html'] }
);

assert.deepEqual(
	receive('subFrame', {
		'Content-Security-Policy': ["default-src 'self'; frame-ancestors 'none'; script-src 'self'"],
	}).responseHeaders,
	{ 'Content-Security-Policy': ["default-src 'self'; script-src 'self'"] }
);

assert.deepEqual(
	receive('subFrame', {
		'Content-Security-Policy': ["frame-ancestors 'self'"],
		'Content-Type': ['text/html'],
	}).responseHeaders,
	{ 'Content-Type': ['text/html'] }
);

assert.deepEqual(
	receive('mainFrame', { 'X-Frame-Options': ['DENY'] }),
	{},
	'non-subFrame responses should not be rewritten'
);

assert.deepEqual(
	receive('subFrame', {
		'x-FrAmE-oPtIoNs': ['SAMEORIGIN'],
		'CoNtEnT-SeCuRiTy-PoLiCy-RePoRt-OnLy': ["FRAME-ANCESTORS 'none'; default-src 'self'"],
	}).responseHeaders,
	{ 'CoNtEnT-SeCuRiTy-PoLiCy-RePoRt-OnLy': ["default-src 'self'"] }
);

console.log('frame header relaxation assertions passed');

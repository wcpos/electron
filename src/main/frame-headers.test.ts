import assert from 'assert/strict';

import { registerFrameHeaderRelaxation } from './frame-headers';

import type { Session } from 'electron';

type ResponseHeaders = Record<string, string[]>;
type HeadersReceivedResponse = { responseHeaders?: ResponseHeaders };
type FrameStub = { parent: FrameStub | null; top: FrameStub | null; url: string } | null;
type HeadersReceivedListener = (
	details: { resourceType: string; responseHeaders?: ResponseHeaders; frame?: FrameStub },
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

/** The app's own top document, as electron-serve serves it in production. */
const topFrame: FrameStub = { parent: null, top: null, url: 'wcpos://-/index.html' };
(topFrame as { top: FrameStub }).top = topFrame;

/** The checkout iframe: a direct child of the app document. */
const appChildFrame: FrameStub = {
	parent: topFrame,
	top: topFrame,
	url: 'https://store.example/pay',
};

/** A frame nested inside the store page (gateway iframe, injected content). */
const nestedFrame: FrameStub = {
	parent: appChildFrame,
	top: topFrame,
	url: 'https://third-party.example/',
};

/** A window whose top document is not ours — must never be relaxed. */
const foreignTop: FrameStub = { parent: null, top: null, url: 'https://store.example/' };
(foreignTop as { top: FrameStub }).top = foreignTop;
const foreignChild: FrameStub = {
	parent: foreignTop,
	top: foreignTop,
	url: 'https://bank.example/',
};

function receive(
	resourceType: string,
	responseHeaders: ResponseHeaders,
	frame: FrameStub = appChildFrame
) {
	let response: HeadersReceivedResponse | undefined;
	listener!({ resourceType, responseHeaders, frame }, (nextResponse) => {
		response = nextResponse;
	});
	assert.ok(response, 'headers-received listener should invoke its callback');
	return response;
}

// --- the direct store frame is relaxed -------------------------------------

assert.deepEqual(
	receive('subFrame', { 'X-Frame-Options': ['DENY'], 'Content-Type': ['text/html'] })
		.responseHeaders,
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
	receive('subFrame', {
		'x-FrAmE-oPtIoNs': ['SAMEORIGIN'],
		'CoNtEnT-SeCuRiTy-PoLiCy-RePoRt-OnLy': ["FRAME-ANCESTORS 'none'; default-src 'self'"],
	}).responseHeaders,
	{ 'CoNtEnT-SeCuRiTy-PoLiCy-RePoRt-OnLy': ["default-src 'self'"] }
);

// --- a header field may carry several comma-separated policies --------------

assert.deepEqual(
	receive('subFrame', {
		'Content-Security-Policy': ["frame-ancestors 'none', default-src 'self'"],
	}).responseHeaders,
	{ 'Content-Security-Policy': ["default-src 'self'"] },
	'a sibling policy after the comma must survive'
);

assert.deepEqual(
	receive('subFrame', {
		'Content-Security-Policy': ["default-src 'self', frame-ancestors 'none'"],
	}).responseHeaders,
	{ 'Content-Security-Policy': ["default-src 'self'"] },
	'a blocking policy after the comma must still be stripped'
);

// --- everything else is left untouched --------------------------------------

assert.deepEqual(
	receive('mainFrame', { 'X-Frame-Options': ['DENY'] }),
	{},
	'non-subFrame responses should not be rewritten'
);

assert.deepEqual(
	receive('subFrame', { 'X-Frame-Options': ['DENY'] }, nestedFrame),
	{},
	'a frame nested inside store content keeps its anti-framing headers'
);

assert.deepEqual(
	receive('subFrame', { 'X-Frame-Options': ['DENY'] }, foreignChild),
	{},
	'a frame whose top document is not the app is never relaxed'
);

assert.deepEqual(
	receive('subFrame', { 'X-Frame-Options': ['DENY'] }, null),
	{},
	'an unidentifiable frame fails closed'
);

console.log('frame header relaxation assertions passed');

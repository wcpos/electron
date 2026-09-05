import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseUsbModelReply } from './usb-model-reply';

test('an Epson GS I 67 reply becomes the bare model name', () => {
	assert.equal(parseUsbModelReply(Buffer.from('_TM-m30III\0')), 'TM-m30III');
});

test('control bytes and an empty reply yield null', () => {
	assert.equal(parseUsbModelReply(Buffer.from([0x00, 0x1b, 0x0a])), null);
	assert.equal(parseUsbModelReply(new Uint8Array()), null);
});

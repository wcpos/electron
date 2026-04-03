import assert from 'node:assert/strict';

import { deserializeRxdbIpcMessage, serializeRxdbIpcMessage } from './rxdb-ipc-attachments';

async function main() {
	const originalBulkWriteMessage: any = {
		method: 'bulkWrite',
		params: [
			[
				{
					document: {
						id: 'doc-1',
						_attachments: {
							greeting: {
								data: new Blob(['hello world'], { type: 'text/plain' }),
								type: 'text/plain',
								digest: 'digest-1',
								length: 11,
							},
						},
					},
				},
			],
			{ context: 'unit-test' },
		],
	};

	const serializedBulkWriteMessage = (await serializeRxdbIpcMessage(
		originalBulkWriteMessage
	)) as any;
	assert.equal(
		typeof serializedBulkWriteMessage.params[0][0].document._attachments.greeting.data,
		'string',
		'bulkWrite messages should encode attachment blobs to base64 strings'
	);
	assert.ok(
		originalBulkWriteMessage.params[0][0].document._attachments.greeting.data instanceof Blob,
		'serializing bulkWrite attachments should not mutate the original message'
	);

	const decodedBulkWriteMessage = (await deserializeRxdbIpcMessage(
		serializedBulkWriteMessage
	)) as any;
	assert.ok(
		decodedBulkWriteMessage.params[0][0].document._attachments.greeting.data instanceof Blob,
		'bulkWrite messages should decode base64 attachment strings back into Blobs'
	);
	assert.equal(
		await decodedBulkWriteMessage.params[0][0].document._attachments.greeting.data.text(),
		'hello world',
		'bulkWrite attachment contents should survive encode/decode'
	);

	const originalGetAttachmentDataMessage: any = {
		method: 'getAttachmentData',
		return: new Blob(['hello world'], { type: 'text/plain' }),
	};
	const serializedGetAttachmentDataMessage = (await serializeRxdbIpcMessage(
		originalGetAttachmentDataMessage
	)) as any;
	assert.equal(
		typeof serializedGetAttachmentDataMessage.return,
		'string',
		'getAttachmentData responses should encode Blob returns to base64 strings'
	);
	assert.ok(
		originalGetAttachmentDataMessage.return instanceof Blob,
		'serializing getAttachmentData responses should not mutate the original message'
	);

	const decodedGetAttachmentDataMessage = (await deserializeRxdbIpcMessage(
		serializedGetAttachmentDataMessage
	)) as any;
	assert.ok(
		decodedGetAttachmentDataMessage.return instanceof Blob,
		'getAttachmentData responses should decode base64 returns back into Blobs'
	);
	assert.equal(
		await decodedGetAttachmentDataMessage.return.text(),
		'hello world',
		'getAttachmentData contents should survive encode/decode'
	);

	const pingMessage = { ping: true };
	assert.equal(
		await serializeRxdbIpcMessage(pingMessage),
		pingMessage,
		'non-attachment messages should pass through serialization untouched'
	);
	assert.equal(
		await deserializeRxdbIpcMessage(pingMessage),
		pingMessage,
		'non-attachment messages should pass through deserialization untouched'
	);

	console.log('rxdb ipc attachment codec assertions passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

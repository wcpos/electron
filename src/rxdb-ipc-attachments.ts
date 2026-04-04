import { blobToBase64String, clone, createBlobFromBase64 } from 'rxdb/plugins/utils';

type RxdbIpcMessage = {
	method?: string;
	params?: unknown;
	return?: unknown;
};

type AttachmentWithData = {
	data?: unknown;
	type?: string;
};

function getBulkWriteDocumentWrites(message: unknown): any[] | undefined {
	const rxdbMessage = message as RxdbIpcMessage;
	if (rxdbMessage?.method !== 'bulkWrite' || !Array.isArray(rxdbMessage.params)) {
		return undefined;
	}

	const [documentWrites] = rxdbMessage.params as [unknown];
	return Array.isArray(documentWrites) ? documentWrites : undefined;
}

function getBulkWriteAttachments(message: unknown): AttachmentWithData[] {
	const documentWrites = getBulkWriteDocumentWrites(message);
	if (!documentWrites) {
		return [];
	}

	const attachments: AttachmentWithData[] = [];
	for (const row of documentWrites) {
		const documentAttachments = row?.document?._attachments;
		if (!documentAttachments) {
			continue;
		}

		for (const attachment of Object.values(documentAttachments)) {
			attachments.push(attachment as AttachmentWithData);
		}
	}

	return attachments;
}

export function hasBulkWriteAttachmentBlobs(message: unknown): boolean {
	return getBulkWriteAttachments(message).some(
		(attachment) => typeof Blob !== 'undefined' && attachment.data instanceof Blob
	);
}

export function hasBulkWriteAttachmentBase64Strings(message: unknown): boolean {
	return getBulkWriteAttachments(message).some((attachment) => typeof attachment.data === 'string');
}

export function hasGetAttachmentDataBlobReturn(message: unknown): boolean {
	const rxdbMessage = message as RxdbIpcMessage;
	return (
		rxdbMessage?.method === 'getAttachmentData' &&
		typeof Blob !== 'undefined' &&
		rxdbMessage.return instanceof Blob
	);
}

export function hasGetAttachmentDataBase64Return(message: unknown): boolean {
	const rxdbMessage = message as RxdbIpcMessage;
	return rxdbMessage?.method === 'getAttachmentData' && typeof rxdbMessage.return === 'string';
}

export async function serializeRxdbIpcMessage(message: unknown): Promise<unknown> {
	if (hasBulkWriteAttachmentBlobs(message)) {
		const clonedMessage = clone(message as RxdbIpcMessage) as RxdbIpcMessage;
		const attachments = getBulkWriteAttachments(clonedMessage).filter(
			(attachment) => typeof Blob !== 'undefined' && attachment.data instanceof Blob
		);
		const blobs = attachments.map((attachment) => attachment.data as Blob);
		const base64Results = await Promise.all(blobs.map((blob) => blobToBase64String(blob)));

		for (let index = 0; index < attachments.length; index += 1) {
			attachments[index]!.data = base64Results[index];
		}

		return clonedMessage;
	}

	if (hasGetAttachmentDataBlobReturn(message)) {
		const clonedMessage = clone(message as RxdbIpcMessage) as RxdbIpcMessage;
		clonedMessage.return = await blobToBase64String(clonedMessage.return as Blob);
		return clonedMessage;
	}

	return message;
}

export async function deserializeRxdbIpcMessage(message: unknown): Promise<unknown> {
	if (hasBulkWriteAttachmentBase64Strings(message)) {
		const clonedMessage = clone(message as RxdbIpcMessage) as RxdbIpcMessage;
		const attachments = getBulkWriteAttachments(clonedMessage);

		for (const attachment of attachments) {
			if (typeof attachment.data === 'string') {
				attachment.data = await createBlobFromBase64(attachment.data, attachment.type || '');
			}
		}

		return clonedMessage;
	}

	if (hasGetAttachmentDataBase64Return(message)) {
		const clonedMessage = clone(message as RxdbIpcMessage) as RxdbIpcMessage;
		clonedMessage.return = await createBlobFromBase64(clonedMessage.return as string, '');
		return clonedMessage;
	}

	return message;
}

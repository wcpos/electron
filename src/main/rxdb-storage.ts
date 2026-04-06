import fs from 'fs';
import path from 'path';

import { app, ipcMain } from 'electron';
import { IPC_RENDERER_KEY_PREFIX } from 'rxdb/plugins/electron';
import { exposeRxStorageRemote } from 'rxdb/plugins/storage-remote';
import { getRxStorageFilesystemNode } from 'rxdb-premium/plugins/storage-filesystem-node';
import { Subject } from 'rxjs';

import {
	deserializeRxdbIpcMessage,
	hasBulkWriteAttachmentBase64Strings,
	hasGetAttachmentDataBlobReturn,
	serializeRxdbIpcMessage,
} from '../rxdb-ipc-attachments';
import { logger } from './log';

const MAIN_STORAGE_KEY = 'main-storage';
let bridgeInitializationPromise: Promise<void> | undefined;
let storagePromise: Promise<ReturnType<typeof getRxStorageFilesystemNode>> | undefined;

function exposeIpcMainRxStorageWithAttachmentCodec(args: {
	key: string;
	storage: ReturnType<typeof getRxStorageFilesystemNode>;
	ipcMain: typeof ipcMain;
}) {
	const channelId = [IPC_RENDERER_KEY_PREFIX, args.key].join('|');
	const messages$ = new Subject<any>();
	const openRenderers: Set<any> = new Set();

	const addOpenRenderer = (renderer: any) => {
		if (openRenderers.has(renderer)) {
			return;
		}
		openRenderers.add(renderer);
		renderer.on('destroyed', () => openRenderers.delete(renderer));
	};

	args.ipcMain.on(channelId, (event: any, message: unknown) => {
		addOpenRenderer(event.sender);
		if (!message) {
			return;
		}

		if (!hasBulkWriteAttachmentBase64Strings(message)) {
			messages$.next(message);
			return;
		}

		void deserializeRxdbIpcMessage(message)
			.then((decodedMessage) => {
				messages$.next(decodedMessage);
			})
			.catch((error) => {
				logger.error('Failed to decode RxDB IPC attachment payload in main process', error);
			});
	});

	exposeRxStorageRemote({
		storage: args.storage,
		messages$,
		// The monorepo renderer uses rxdb 17.0.0 while the electron main uses 17.1.0.
		// rxdb-premium is stuck at 17.0.0 and has not yet published a 17.1.0 release,
		// so the renderer will continue sending version '17.0.0' in IPC messages.
		// fakeVersion bypasses the RM1 version-mismatch check until premium catches up.
		fakeVersion: '17.0.0',
		send(message) {
			const sendToRenderers = (payload: unknown) => {
				openRenderers.forEach((sender) => {
					sender.send(channelId, payload);
				});
			};

			if (!hasGetAttachmentDataBlobReturn(message)) {
				sendToRenderers(message);
				return;
			}

			void serializeRxdbIpcMessage(message)
				.then((encodedMessage) => {
					sendToRenderers(encodedMessage);
				})
				.catch((error) => {
					logger.error('Failed to encode RxDB IPC attachment payload in main process', error);
				});
		},
	});
}

export function getLegacySqliteBasePath() {
	return process.env.NODE_ENV === 'development'
		? path.resolve('databases')
		: path.resolve(app.getPath('userData'), 'wcpos_dbs');
}

export function getFilesystemNodeBasePath() {
	return process.env.NODE_ENV === 'development'
		? path.resolve('filesystem-databases')
		: path.resolve(app.getPath('userData'), 'wcpos_fsdbs');
}

async function ensureFilesystemNodeBasePath() {
	const basePath = getFilesystemNodeBasePath();

	if (!fs.existsSync(basePath)) {
		await fs.promises.mkdir(basePath, { recursive: true });
		logger.info(`Created filesystem-node storage folder: ${basePath}`);
	}

	return basePath;
}

export async function getMainRxdbStorage() {
	if (!storagePromise) {
		storagePromise = (async () => {
			try {
				const basePath = await ensureFilesystemNodeBasePath();
				logger.info('Initialising RxDB filesystem-node storage bridge', { basePath });
				return getRxStorageFilesystemNode({ basePath });
			} catch (error) {
				storagePromise = undefined;
				throw error;
			}
		})();
	}

	return storagePromise;
}

export function initializeRxdbStorageBridge() {
	if (bridgeInitializationPromise) {
		return bridgeInitializationPromise;
	}

	bridgeInitializationPromise = app
		.whenReady()
		.then(async () => {
			const storage = await getMainRxdbStorage();
			exposeIpcMainRxStorageWithAttachmentCodec({
				key: MAIN_STORAGE_KEY,
				storage,
				ipcMain,
			});
			logger.info('RxDB Electron storage bridge is ready', { key: MAIN_STORAGE_KEY });
		})
		.catch((error) => {
			bridgeInitializationPromise = undefined;
			logger.error('Failed to initialise RxDB Electron storage bridge', error);
			throw error;
		});

	return bridgeInitializationPromise;
}

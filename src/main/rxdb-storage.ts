import path from 'path';

import { app, ipcMain } from 'electron';
import { IPC_RENDERER_KEY_PREFIX } from 'rxdb/plugins/electron';
import { exposeRxStorageRemote } from 'rxdb/plugins/storage-remote';
import { getRxStorageSQLite } from 'rxdb-premium/plugins/storage-sqlite';
import { Subject } from 'rxjs';

import {
	deserializeRxdbIpcMessage,
	hasBulkWriteAttachmentBase64Strings,
	hasGetAttachmentDataBlobReturn,
	serializeRxdbIpcMessage,
} from '../rxdb-ipc-attachments';
import { logger } from './log';
import { createNodeSqliteBasics } from './sqlite-basics-node';

export const SQLITE_ROOT_DIRNAME = 'wcpos_sqlite';

const MAIN_STORAGE_KEY = 'main-storage';
let bridgeInitializationPromise: Promise<void> | undefined;
let storagePromise: Promise<ReturnType<typeof getRxStorageSQLite>> | undefined;

function exposeIpcMainRxStorageWithAttachmentCodec(args: {
	key: string;
	storage: ReturnType<typeof getRxStorageSQLite>;
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

export function getSqliteBasePath() {
	return process.env.NODE_ENV === 'development'
		? path.resolve('sqlite-databases')
		: path.join(app.getPath('userData'), SQLITE_ROOT_DIRNAME);
}

export async function getMainRxdbStorage() {
	if (!storagePromise) {
		storagePromise = (async () => {
			try {
				const basePath = getSqliteBasePath();
				logger.info('Initialising RxDB SQLite storage bridge', { basePath });
				return getRxStorageSQLite({
					sqliteBasics: createNodeSqliteBasics(basePath),
					storeAttachmentsAsBase64String: true,
				});
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

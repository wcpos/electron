import fs from 'fs';
import path from 'path';

import { app, ipcMain } from 'electron';
import { IPC_RENDERER_KEY_PREFIX } from 'rxdb/plugins/electron';
import { exposeRxStorageRemote } from 'rxdb/plugins/storage-remote';
import { getRxStorageAbstractFilesystem } from 'rxdb-premium/plugins/storage-abstract-filesystem';
import {
	NodeFilesystem,
	RX_STORAGE_NAME_FILESYSTEM_NODE,
} from 'rxdb-premium/plugins/storage-filesystem-node';
import { disableVersionCheck } from 'rxdb-premium/plugins/shared';
import { Subject } from 'rxjs';

import {
	deserializeRxdbIpcMessage,
	hasBulkWriteAttachmentBase64Strings,
	hasGetAttachmentDataBlobReturn,
	serializeRxdbIpcMessage,
} from '../rxdb-ipc-attachments';
import { logger } from './log';
import { withTargetedOpfsRecovery } from './opfs-targeted-recovery.mjs';
import { installRxdbStorageTelemetry } from './rxdb-storage-telemetry';
import { createStorageLock } from './storage-lock';

// rxdb-premium 17.0.0 is installed but rxdb is 17.1.0. storage-abstract-filesystem
// (used by filesystem-node) calls checkVersion() on every createStorageInstance, which
// would throw SNH and break the IPC storage bridge. Disable the check in the main process.
disableVersionCheck();

const MAIN_STORAGE_KEY = 'main-storage';
let bridgeInitializationPromise: Promise<void> | undefined;
let storagePromise: Promise<ReturnType<typeof getFilesystemNodeStorage>> | undefined;

/**
 * rxdb-premium's own `getRxStorageFilesystemNode` with one substitution: the
 * task-queue lock. The plugin's `web-locks` lock drops a run's rejection on
 * the floor (see storage-lock.ts), which is how a failing write run reached
 * Sentry only as an unhandled rejection and never as a storage event.
 */
function getFilesystemNodeStorage(basePath: string) {
	return getRxStorageAbstractFilesystem({
		name: RX_STORAGE_NAME_FILESYSTEM_NODE,
		abstractFilesystem: new NodeFilesystem(basePath),
		abstractLock: createStorageLock(),
		inWorker: false,
	});
}

function exposeIpcMainRxStorageWithAttachmentCodec(args: {
	key: string;
	storage: ReturnType<typeof getFilesystemNodeStorage>;
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
				// The storage's repair paths report through globalThis seams; route
				// them to Sentry before the first instance can fire one.
				installRxdbStorageTelemetry();
				const basePath = await ensureFilesystemNodeBasePath();
				logger.info('Initialising RxDB filesystem-node storage bridge', { basePath });
				// filesystem-node shares the abstract-filesystem on-disk format with the
				// web OPFS worker, so the same in-place corruption recovery wrapper
				// applies. The module is a byte-identical copy of the monorepo's
				// scripts/opfs-targeted-recovery.mjs, enforced by a sync test there.
				return withTargetedOpfsRecovery(getFilesystemNodeStorage(basePath));
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

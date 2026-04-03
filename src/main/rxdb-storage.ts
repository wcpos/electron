import fs from 'fs';
import path from 'path';

import { app, ipcMain } from 'electron';
import { exposeIpcMainRxStorage } from 'rxdb/plugins/electron';
import { getRxStorageFilesystemNode } from 'rxdb-premium/plugins/storage-filesystem-node';

import { logger } from './log';

const MAIN_STORAGE_KEY = 'main-storage';
let bridgeInitializationPromise: Promise<void> | undefined;
let storagePromise: Promise<ReturnType<typeof getRxStorageFilesystemNode>> | undefined;

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
			exposeIpcMainRxStorage({
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

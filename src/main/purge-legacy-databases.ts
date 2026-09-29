import fs from 'node:fs';
import path from 'node:path';

import { ipcMain } from 'electron';

import { logger } from './log';
import { getFilesystemNodeBasePath, getLegacySqliteBasePath } from './rxdb-storage';

ipcMain.handle('purgeLegacyDatabases', async () => {
	const removed: string[] = [];
	const filesystemRoot = getFilesystemNodeBasePath();
	try {
		await fs.promises.rm(filesystemRoot, { recursive: true });
		removed.push(filesystemRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}

	const legacyRoot = getLegacySqliteBasePath();
	let entries: fs.Dirent[] = [];
	try {
		entries = await fs.promises.readdir(legacyRoot, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	for (const entry of entries) {
		// wcpos_dbs still owns the live image-cache; only retired database files go.
		if (!entry.isFile() || !/\.sqlite3(?:-(?:journal|wal|shm))?$/.test(entry.name)) continue;
		const filename = path.join(legacyRoot, entry.name);
		await fs.promises.unlink(filename);
		removed.push(filename);
	}
	logger.info('Purged legacy databases', { removed });
	return { removed };
});

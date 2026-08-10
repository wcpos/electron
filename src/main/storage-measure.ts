import fs from 'node:fs';
import path from 'node:path';

import { ipcMain } from 'electron';

import { logger } from './log';
import { getFilesystemNodeBasePath, getLegacySqliteBasePath } from './rxdb-storage';

type StorageEntry = {
	name: string;
	bytes: number;
	root: 'fsdbs' | 'legacy-sqlite';
};

async function measurePath(entryPath: string): Promise<number | undefined> {
	let stats;
	try {
		stats = await fs.promises.lstat(entryPath);
	} catch {
		return undefined;
	}

	if (stats.isSymbolicLink()) return undefined;
	if (stats.isFile()) return stats.size;
	if (!stats.isDirectory()) return undefined;

	let children;
	try {
		children = await fs.promises.readdir(entryPath, { withFileTypes: true });
	} catch {
		return undefined;
	}

	let bytes = 0;
	for (const child of children) {
		if (child.isSymbolicLink()) continue;
		bytes += (await measurePath(path.join(entryPath, child.name))) ?? 0;
	}
	return bytes;
}

async function readBasePath(basePath: string) {
	try {
		return await fs.promises.readdir(basePath, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

export async function measureStorage(filesystemPath: string, legacyPath: string) {
	const entries: StorageEntry[] = [];

	for (const entry of await readBasePath(filesystemPath)) {
		if (entry.isSymbolicLink()) continue;
		const bytes = await measurePath(path.join(filesystemPath, entry.name));
		if (bytes !== undefined) entries.push({ name: entry.name, bytes, root: 'fsdbs' });
	}

	for (const entry of await readBasePath(legacyPath)) {
		if (!entry.isFile()) continue;
		const bytes = await measurePath(path.join(legacyPath, entry.name));
		if (bytes !== undefined) {
			entries.push({ name: entry.name, bytes, root: 'legacy-sqlite' });
		}
	}

	return { entries };
}

ipcMain.handle('storage:measure', async () => {
	try {
		return await measureStorage(getFilesystemNodeBasePath(), getLegacySqliteBasePath());
	} catch (error) {
		logger.error('Failed to measure storage', error);
		return { entries: [] };
	}
});

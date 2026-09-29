import fs from 'node:fs';
import path from 'node:path';

import { ipcMain } from 'electron';

import { getImageCachePath } from './image-cache-path';
import { logger } from './log';
import {
	getFilesystemNodeBasePath,
	getLegacySqliteBasePath,
	getSqliteBasePath,
} from './rxdb-storage';

type StorageEntry = {
	name: string;
	bytes: number;
	root: 'sqlite' | 'fsdbs' | 'legacy-sqlite' | 'image-cache';
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

export async function measureStorage(
	filesystemPath: string,
	legacyPath: string,
	imageCachePath: string,
	sqlitePath: string
) {
	const entries: StorageEntry[] = [];
	const databases = new Map<string, number>();
	for (const entry of await readBasePath(sqlitePath)) {
		if (!entry.isFile()) continue;
		const match = /^(.*)\.sqlite(?:-(?:wal|shm))?$/.exec(entry.name);
		if (!match) continue;
		const bytes = await measurePath(path.join(sqlitePath, entry.name));
		if (bytes !== undefined) databases.set(match[1], (databases.get(match[1]) ?? 0) + bytes);
	}
	for (const [name, bytes] of databases) entries.push({ name, bytes, root: 'sqlite' });

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

	const imageCacheBytes = await measurePath(imageCachePath);
	if (imageCacheBytes !== undefined) {
		entries.push({ name: 'image-cache', bytes: imageCacheBytes, root: 'image-cache' });
	}

	return { entries };
}

ipcMain.handle('storage:measure', async () => {
	try {
		return await measureStorage(
			getFilesystemNodeBasePath(),
			getLegacySqliteBasePath(),
			getImageCachePath(),
			getSqliteBasePath()
		);
	} catch (error) {
		logger.error('Failed to measure storage', error);
		return { entries: [] };
	}
});

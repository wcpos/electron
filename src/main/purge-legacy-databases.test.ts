import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-legacy-test-'));
const handlers = new Map<string, () => Promise<{ removed: string[] }>>();
const infoLines: unknown[][] = [];
const mutableModule = Module as typeof Module & { _load: (...args: any[]) => any };
const originalLoad = mutableModule._load;
mutableModule._load = function (request: string, ...args: any[]) {
	if (request === 'electron') {
		return {
			app: { getPath: () => fixture },
			ipcMain: {
				handle: (channel: string, handler: () => Promise<{ removed: string[] }>) =>
					handlers.set(channel, handler),
				on() {},
			},
		};
	}
	if (request === './log')
		return { logger: { info: (...values: unknown[]) => infoLines.push(values), error() {} } };
	if (request === './translations') return { t: (key: string) => key };
	return originalLoad.call(this, request, ...args);
};

async function main() {
	let clearPendingAppDataOnStartup: typeof import('./clear-data').clearPendingAppDataOnStartup;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require('./purge-legacy-databases');
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		({ clearPendingAppDataOnStartup } = require('./clear-data'));
	} finally {
		mutableModule._load = originalLoad;
	}
	const purge = handlers.get('purgeLegacyDatabases');
	assert.ok(purge, 'purge IPC channel is registered');
	assert.deepEqual(await purge(), { removed: [] });
	const filesystemRoot = path.join(fixture, 'wcpos_fsdbs');
	const legacyRoot = path.join(fixture, 'wcpos_dbs');
	const newRoot = path.join(fixture, 'wcpos_sqlite');
	const imageCache = path.join(legacyRoot, 'image-cache');
	fs.mkdirSync(filesystemRoot);
	fs.writeFileSync(path.join(filesystemRoot, 'old-data'), 'old');
	fs.mkdirSync(imageCache, { recursive: true });
	fs.writeFileSync(path.join(imageCache, 'image.png'), 'image');
	fs.writeFileSync(path.join(legacyRoot, 'keep.txt'), 'keep');
	fs.mkdirSync(path.join(legacyRoot, 'keep.sqlite3'));
	const files = [
		'store.sqlite3',
		'store.sqlite3-journal',
		'store.sqlite3-wal',
		'store.sqlite3-shm',
		'orphan.sqlite3-wal',
	];
	for (const file of files) fs.writeFileSync(path.join(legacyRoot, file), 'old');
	fs.mkdirSync(newRoot);
	const live = new DatabaseSync(path.join(newRoot, 'sales.sqlite'));
	try {
		live.exec(
			"PRAGMA journal_mode = WAL; CREATE TABLE sales (id TEXT); INSERT INTO sales VALUES ('sale-1');"
		);
		const before = infoLines.length;
		const result = await purge();
		assert.deepEqual(
			result.removed.sort(),
			[filesystemRoot, ...files.map((name) => path.join(legacyRoot, name))].sort()
		);
		assert.equal(infoLines.length, before + 1, 'one info line per purge');
		assert.equal(fs.existsSync(filesystemRoot), false);
		assert.deepEqual(fs.readdirSync(legacyRoot).sort(), [
			'image-cache',
			'keep.sqlite3',
			'keep.txt',
		]);
		assert.equal(fs.readFileSync(path.join(imageCache, 'image.png'), 'utf8'), 'image');
		assert.deepEqual(await purge(), { removed: [] });
		assert.equal(live.prepare('SELECT id FROM sales').get().id, 'sale-1');
		live.exec("INSERT INTO sales VALUES ('sale-2')");
	} finally {
		live.close();
	}

	fs.mkdirSync(filesystemRoot);
	process.argv.push('--clear-app-data-on-startup');
	try {
		await clearPendingAppDataOnStartup();
		for (const root of [filesystemRoot, legacyRoot, newRoot]) {
			assert.equal(fs.existsSync(root), false, 'Clear data deletes all three roots');
		}
	} finally {
		process.argv.pop();
	}
	console.log('legacy purge and Clear data assertions passed');
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => fs.rmSync(fixture, { recursive: true, force: true }));

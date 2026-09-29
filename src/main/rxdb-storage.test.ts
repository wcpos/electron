import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

import { fillWithDefaultSettings } from 'rxdb/plugins/core';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'rxdb-storage-test-'));
const mutableModule = Module as typeof Module & { _load: (...args: any[]) => any };
const originalLoad = mutableModule._load;
mutableModule._load = function (request: string, ...args: any[]) {
	if (request === 'electron') return { app: { getPath: () => fixture }, ipcMain: {} };
	if (request === './log') return { logger: { info() {}, error() {} } };
	return originalLoad.call(this, request, ...args);
};

async function main() {
	let getMainRxdbStorage: typeof import('./rxdb-storage').getMainRxdbStorage;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		({ getMainRxdbStorage } = require('./rxdb-storage'));
	} finally {
		mutableModule._load = originalLoad;
	}
	const storage = await getMainRxdbStorage();
	const instance = await storage.createStorageInstance({
		databaseInstanceToken: 'storage-test',
		databaseName: 'sales',
		collectionName: 'orders',
		schema: fillWithDefaultSettings({
			version: 0,
			primaryKey: 'id',
			type: 'object',
			properties: { id: { type: 'string', maxLength: 100 }, total: { type: 'number' } },
			required: ['id', 'total'],
		}),
		options: {},
		multiInstance: false,
		devMode: false,
	});
	const document = {
		id: 'sale-1',
		total: 42,
		_deleted: false,
		_attachments: {},
		_rev: '1-test',
		_meta: { lwt: Date.now() },
	};
	try {
		const result = await instance.bulkWrite([{ document }], 'durability-test');
		assert.deepEqual(result.error, []);
	} finally {
		await instance.close();
	}
	const filename = path.join(fixture, 'wcpos_sqlite', 'sales.sqlite');
	assert.ok(fs.existsSync(filename), 'main storage persists to the new SQLite root');
	const db = new DatabaseSync(filename);
	try {
		const row = db.prepare('SELECT data FROM "orders-0" WHERE id = ?').get('sale-1');
		assert.ok(row, 'acknowledged sale survives closing the storage');
		assert.deepEqual(JSON.parse(row.data as string), document);
		assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
	} finally {
		db.close();
	}
	console.log('main RxDB SQLite storage assertions passed');
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => fs.rmSync(fixture, { recursive: true, force: true }));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createNodeSqliteBasics } from './sqlite-basics-node';

async function main() {
	const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sqlite-basics-test-'));
	const root = path.join(fixture, 'new-root');
	try {
		const basics = createNodeSqliteBasics(root);
		for (const name of ['../escape', 'nested/name', 'nested\\name', 'bad..name']) {
			await assert.rejects(() => basics.open(name), /database name/i);
		}
		assert.equal(fs.existsSync(root), false, 'refuse unsafe names before creating the root');
		for (const name of ['orders', 'logs']) {
			const db = await basics.open(name);
			try {
				assert.equal(fs.existsSync(path.join(root, `${name}.sqlite`)), true);
				assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
				assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
				assert.equal(basics.journalMode, 'WAL');
			} finally {
				await basics.close(db);
			}
		}
		assert.deepEqual((await fs.promises.readdir(root)).sort(), ['logs.sqlite', 'orders.sqlite']);
	} finally {
		await fs.promises.rm(fixture, { recursive: true, force: true });
	}
	console.log('Node SQLite basics assertions passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

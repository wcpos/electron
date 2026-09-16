import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
	MARKER,
	PATCH_VERSION,
	preparePatch,
} from './patch-rxdb-premium-cleanup-compaction-batch.mjs';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('rxdb-premium/package.json'));
const esmRxdb = await import('rxdb');
const esmFilesystem = await import('rxdb-premium/plugins/storage-filesystem-node');
const cjsRxdb = require('rxdb');
const cjsFilesystem = require('rxdb-premium/plugins/storage-filesystem-node');
const runtimes = [
	{
		dist: 'esm',
		createRxDatabase: esmRxdb.createRxDatabase,
		getStorage: esmFilesystem.getRxStorageFilesystemNode,
		writablePrototype: esmFilesystem.NodeFilesystemWritable.prototype,
	},
	{
		dist: 'cjs',
		createRxDatabase: cjsRxdb.createRxDatabase,
		getStorage: cjsFilesystem.getRxStorageFilesystemNode,
		writablePrototype: cjsFilesystem.NodeFilesystemWritable.prototype,
	},
];
// Every patched value keeps its byte length (`before` → `after!`, `original` →
// `modified`), so each compaction move takes the direct path and yields exactly
// one operation per index. The op-count arithmetic below depends on that.
const schema = {
	version: 0,
	primaryKey: 'id',
	type: 'object',
	properties: {
		id: { type: 'string', maxLength: 32 },
		status: { type: 'string', maxLength: 32 },
		note: { type: 'string', maxLength: 128 },
	},
	required: ['id', 'status', 'note'],
	indexes: [['status'], ['note']],
};

function makeDirectory(prefix) {
	return mkdtempSync(join(tmpdir(), `wcpos-compaction-${prefix}-`));
}

async function openDatabase(runtime, basePath, multiInstance = false) {
	const db = await runtime.createRxDatabase({
		name: join(basePath, 'database'),
		storage: runtime.getStorage({ basePath }),
		multiInstance,
	});
	const { c } = await db.addCollections({ c: { schema } });
	return { db, collection: c };
}

function storageInternals(collection) {
	let instance = collection.storageInstance;
	while (instance && !instance.internals?.statePromise) instance = instance.originalStorageInstance;
	assert.ok(instance?.internals?.statePromise, 'reached the abstract-filesystem storage instance');
	return instance.internals;
}

async function findAll(collection) {
	return (await collection.find().exec())
		.map((doc) => {
			const { id, status, note } = doc.toJSON();
			return { id, status, note };
		})
		.sort((left, right) => left.id.localeCompare(right.id));
}

async function fullCleanup(collection) {
	for (let rounds = 1; rounds <= 100; rounds++) {
		if (await collection.storageInstance.cleanup(0)) return rounds;
	}
	assert.fail('cleanup did not finish in 100 rounds');
}

async function seedGaps(collection, count) {
	const documents = Array.from({ length: count }, (_, i) => ({
		id: `k-${String(i).padStart(3, '0')}`,
		status: 'before',
		note: 'original',
	}));
	assert.equal((await collection.bulkInsert(documents)).error.length, 0);
	await fullCleanup(collection);
	for (const doc of await collection.find().exec()) {
		await doc.incrementalPatch({ status: 'after!', note: 'modified' });
	}
	await storageInternals(collection).taskQueue.awaitIdle();
	return documents.map((doc) => ({ ...doc, status: 'after!', note: 'modified' }));
}

function countPersists(state) {
	const counts = state.indexStates.map(() => 0);
	state.indexStates.forEach((index, i) => {
		const persist = index.persistInMemoryRows;
		index.persistInMemoryRows = function (...args) {
			counts[i]++;
			return persist.apply(this, args);
		};
	});
	return counts;
}

for (const runtime of runtimes) {
	test(`${runtime.dist}: 300 gaps compact in bounded rounds and index persists`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-rounds`);
		let db;
		try {
			const opened = await openDatabase(runtime, basePath);
			db = opened.db;
			const { collection } = opened;
			const expected = await seedGaps(collection, 300);
			const state = await storageInternals(collection).statePromise;
			const counts = countPersists(state);
			const directory = readdirSync(basePath).find((entry) => entry.includes('-c-0'));
			assert.ok(directory);
			const path = join(basePath, directory, 'documents.json');
			const before = statSync(path).size;
			// Pin the time arm: 300 moves on a loaded CI box could cross the 250 ms
			// default and legitimately split the batch. Only the document cap is under test.
			globalThis.__wcposCompactionBatch = { documents: 1000, ms: 60000 };
			const rounds = await fullCleanup(collection);
			assert.ok(rounds <= 3, `${rounds} rounds, expected at most 3`);
			for (const count of counts) assert.ok(count <= 2, `${count} persists, expected at most 2`);
			assert.deepEqual(await findAll(collection), expected);
			assert.ok(statSync(path).size < before, 'documents.json shrank');
			await db.close();
			const reopened = await openDatabase(runtime, basePath);
			db = reopened.db;
			assert.deepEqual(await findAll(reopened.collection), expected);
		} finally {
			delete globalThis.__wcposCompactionBatch;
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`${runtime.dist}: seven-document budget resumes across three batches`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-budget`);
		let db;
		try {
			const opened = await openDatabase(runtime, basePath);
			db = opened.db;
			const expected = await seedGaps(opened.collection, 20);
			const counts = countPersists(await storageInternals(opened.collection).statePromise);
			globalThis.__wcposCompactionBatch = { documents: 7, ms: 60000 };
			assert.equal(await fullCleanup(opened.collection), 5);
			for (const count of counts) assert.equal(count, 4);
			assert.deepEqual(await findAll(opened.collection), expected);
			await db.close();
			const reopened = await openDatabase(runtime, basePath);
			db = reopened.db;
			assert.deepEqual(await findAll(reopened.collection), expected);
		} finally {
			delete globalThis.__wcposCompactionBatch;
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`${runtime.dist}: broadcasts once per batch with every operation in append order`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-broadcast`);
		let db, state, channel, add;
		try {
			const opened = await openDatabase(runtime, basePath, true);
			db = opened.db;
			const expected = await seedGaps(opened.collection, 20);
			assert.equal(await opened.collection.storageInstance.cleanup(0), false);
			state = await storageInternals(opened.collection).statePromise;
			channel = state.broadcastChannel;
			const messages = [],
				appended = [];
			state.broadcastChannel = {
				postMessage(message) {
					messages.push(structuredClone(message));
				},
			};
			add = state.changelog.addChangelogOperations;
			state.changelog.addChangelogOperations = async function (runState, operations) {
				appended.push(...structuredClone(operations));
				return add.call(this, runState, operations);
			};
			globalThis.__wcposCompactionBatch = { documents: 7, ms: 60000 };
			await fullCleanup(opened.collection);
			assert.equal(messages.length, 3);
			for (const message of messages) assert.equal(message.type, 'event');
			assert.equal(messages[0].changelogOperations.length, 7 * state.indexStates.length);
			const operations = messages.flatMap((message) => message.changelogOperations);
			assert.equal(operations.length, 20 * state.indexStates.length);
			assert.deepEqual(operations, appended);
			assert.deepEqual(await findAll(opened.collection), expected);
		} finally {
			delete globalThis.__wcposCompactionBatch;
			if (state) {
				state.broadcastChannel = channel;
				if (add) state.changelog.addChangelogOperations = add;
			}
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	// Peers learn positions only from the broadcast, and the lock is released when
	// the call ends however it ends. A move that throws after earlier moves already
	// appended their ops must still broadcast those ops, or other tabs keep reading
	// bytes that a later move overwrote (Codex review finding on the first draft).
	test(`${runtime.dist}: a move that fails mid-batch still broadcasts the completed moves`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-midbatch`);
		const originalWrite = runtime.writablePrototype.write;
		let db, state, channel, add;
		try {
			const opened = await openDatabase(runtime, basePath, true);
			db = opened.db;
			const expected = await seedGaps(opened.collection, 20);
			assert.equal(await opened.collection.storageInstance.cleanup(0), false);
			state = await storageInternals(opened.collection).statePromise;
			channel = state.broadcastChannel;
			const messages = [],
				appended = [];
			state.broadcastChannel = {
				postMessage(message) {
					messages.push(structuredClone(message));
				},
			};
			add = state.changelog.addChangelogOperations;
			state.changelog.addChangelogOperations = async function (runState, operations) {
				appended.push(...structuredClone(operations));
				return add.call(this, runState, operations);
			};
			const directory = readdirSync(basePath).find((entry) => entry.includes('-c-0'));
			const documentsPath = join(basePath, directory, 'documents.json');
			// A direct move writes documents.json exactly once, so the fourth write is
			// the fourth move: three moves have appended their ops when it throws.
			let documentWrites = 0;
			runtime.writablePrototype.write = async function (...args) {
				if (this.accessHandle.fileHandle.filepath === documentsPath && ++documentWrites === 4) {
					throw new Error('simulated write failure on the fourth move');
				}
				return originalWrite.apply(this, args);
			};
			await assert.rejects(opened.collection.storageInstance.cleanup(0), /simulated write failure/);
			runtime.writablePrototype.write = originalWrite;
			assert.equal(messages.length, 1);
			assert.equal(messages[0].changelogOperations.length, 3 * state.indexStates.length);
			assert.deepEqual(messages[0].changelogOperations, appended);
			await db.close();
			const reopened = await openDatabase(runtime, basePath, true);
			db = reopened.db;
			await fullCleanup(reopened.collection);
			assert.deepEqual(await findAll(reopened.collection), expected);
		} finally {
			runtime.writablePrototype.write = originalWrite;
			if (state) {
				state.broadcastChannel = channel;
				if (add) state.changelog.addChangelogOperations = add;
			}
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});
}

test('both dists carry the audit marker in cleanup.js', () => {
	for (const dist of ['esm', 'cjs']) {
		const source = readFileSync(
			join(packageRoot, `dist/${dist}/plugins/storage-abstract-filesystem/cleanup.js`),
			'utf8'
		);
		assert.ok(source.includes(`${MARKER}=${PATCH_VERSION};`), dist);
	}
});

test('patch preparation rejects a moved anchor', () => {
	const directory = makeDirectory('patch-anchor');
	const path = join(directory, 'fixture.js');
	writeFileSync(path, '__moved__');
	try {
		assert.throws(
			() =>
				preparePatch(path, {
					prelude: `globalThis.${MARKER}=${PATCH_VERSION};\n`,
					rewrites: [{ name: 'fixture', before: '__anchor__', after: '__patched__' }],
				}),
			/anchor fixture matched 0 times/
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('patch preparation refuses a dist patched by an older script version', () => {
	const directory = makeDirectory('patch-version');
	const path = join(directory, 'fixture.js');
	writeFileSync(path, `globalThis.${MARKER}=${PATCH_VERSION - 1};\n__patched__`);
	try {
		assert.throws(
			() =>
				preparePatch(path, {
					prelude: `globalThis.${MARKER}=${PATCH_VERSION};\n`,
					rewrites: [{ name: 'fixture', before: '__anchor__', after: '__patched__' }],
				}),
			/carries patch v0 but this script is v\d+: restore the pristine dist/
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

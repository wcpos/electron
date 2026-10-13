import assert from 'node:assert/strict';
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
	MARKER,
	PATCH_VERSION,
	preparePatch,
} from './patch-rxdb-premium-changelog-replay-safety.mjs';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('rxdb-premium/package.json'));

const esmRxdb = await import('rxdb');
const esmCleanup = await import('rxdb/plugins/cleanup');
const esmFilesystem = await import('rxdb-premium/plugins/storage-filesystem-node');
const cjsRxdb = require('rxdb');
const cjsCleanup = require('rxdb/plugins/cleanup');
const cjsFilesystem = require('rxdb-premium/plugins/storage-filesystem-node');

const runtimes = [
	{
		dist: 'esm',
		createRxDatabase: esmRxdb.createRxDatabase,
		getStorage: esmFilesystem.getRxStorageFilesystemNode,
		accessPrototype: esmFilesystem.NodeFilesystemFileSyncAccessHandle.prototype,
	},
	{
		dist: 'cjs',
		createRxDatabase: cjsRxdb.createRxDatabase,
		getStorage: cjsFilesystem.getRxStorageFilesystemNode,
		accessPrototype: cjsFilesystem.NodeFilesystemFileSyncAccessHandle.prototype,
	},
];

esmRxdb.addRxPlugin(esmCleanup.RxDBCleanupPlugin);
cjsRxdb.addRxPlugin(cjsCleanup.RxDBCleanupPlugin);

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
	indexes: [['status']],
};

const HUNG = Symbol('hung');

function makeDirectory(prefix) {
	return mkdtempSync(join(tmpdir(), `wcpos-${prefix}-`));
}

function collectionDirectory(basePath) {
	const name = readdirSync(basePath).find((entry) => entry.includes('-c-0'));
	assert.ok(name, 'collection storage directory exists');
	return join(basePath, name);
}

function indexFiles(basePath) {
	return readdirSync(collectionDirectory(basePath))
		.filter((entry) => entry.startsWith('index-'))
		.sort()
		.map((entry) => join(collectionDirectory(basePath), entry));
}

function readIndexRows(path) {
	const stored = JSON.parse(readFileSync(path, 'utf8'));
	return Array.isArray(stored) ? stored : stored.rows;
}

function writeIndexRows(path, rows) {
	const stored = JSON.parse(readFileSync(path, 'utf8'));
	writeFileSync(path, JSON.stringify(Array.isArray(stored) ? rows : { ...stored, rows }));
}

function replaceRowWithNull(path, rowIndex = 0) {
	const rows = readIndexRows(path);
	assert.ok(rows.length > rowIndex, `${path} has a row to corrupt`);
	rows[rowIndex] = null;
	writeIndexRows(path, rows);
}

function assertNoNullRows(basePath) {
	for (const path of indexFiles(basePath)) {
		assert.ok(!readFileSync(path, 'utf8').includes('null'), `${path} was rebuilt without null`);
	}
}

async function openDatabase(runtime, basePath, collectionSchema = schema, multiInstance = false) {
	const db = await runtime.createRxDatabase({
		name: join(basePath, 'database'),
		storage: runtime.getStorage({ basePath }),
		multiInstance,
	});
	const { c } = await db.addCollections({ c: { schema: collectionSchema } });
	return { db, collection: c };
}

async function openWithRebuildEvents(runtime, basePath, collectionSchema = schema) {
	const events = [];
	const onRebuild = (event) => events.push(event);
	globalThis.__wcposOnIndexRebuild = onRebuild;
	return {
		...(await openDatabase(runtime, basePath, collectionSchema)),
		events,
		stopCapture() {
			if (globalThis.__wcposOnIndexRebuild === onRebuild) delete globalThis.__wcposOnIndexRebuild;
		},
	};
}

async function fullCleanup(collection) {
	// Upstream cleanup is intentionally incremental; run until it reports done.
	for (;;) {
		if (await collection.storageInstance.cleanup(0)) return;
	}
}

/** Walk RxDB's storage wrappers down to the abstract-filesystem instance. */
function storageInternals(collection) {
	let instance = collection.storageInstance;
	while (instance && !instance.internals?.statePromise) instance = instance.originalStorageInstance;
	assert.ok(instance?.internals?.statePromise, 'reached the abstract-filesystem storage instance');
	return instance.internals;
}

async function findAll(collection) {
	const result = await Promise.race([
		collection.find().exec(),
		new Promise((resolve) => setTimeout(() => resolve(HUNG), 3000)),
	]);
	assert.notEqual(result, HUNG, 'find-all query settles within 3 seconds');
	return result
		.map((doc) => {
			const { id, status, note } = doc.toJSON();
			return { id, status, note };
		})
		.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Cleanup bakes epoch-tagged index files, then dies before changelog.empty.
 * Also cover death before the first persist and between index persists: each
 * index must skip only its own baked prefix on the next open (upstream #30).
 */
async function seedCrashWindow(runtime, basePath, { dieAt = 'empty' } = {}) {
	const { db, collection } = await openDatabase(runtime, basePath);
	for (let index = 0; index < 10; index++) {
		const suffix = String(index).padStart(2, '0');
		await collection.insert({
			id: `k-${suffix}`,
			status: `s-${suffix}`,
			note: 'original',
		});
	}
	await fullCleanup(collection);
	for (const id of ['k-09', 'k-08', 'k-07']) {
		await (await collection.findOne(id).exec()).incrementalPatch({ note: 'patched' });
	}
	for (const id of ['k-00', 'k-01', 'k-02', 'k-03']) {
		await (await collection.findOne(id).exec()).remove();
	}
	// Upstream `cleanup()` short-circuits after the tombstone pass when it removed
	// anything, so run that pass first; the next call reaches the compaction.
	await collection.storageInstance.cleanup(0);
	const state = await storageInternals(collection).statePromise;
	const death = new Error(`simulated death at ${dieAt}`);
	if (dieAt === 'empty') {
		state.changelog.empty = async () => {
			throw death;
		};
	} else {
		state.indexStates[dieAt === 'partial' ? 1 : 0].persistInMemoryRows = async () => {
			throw death;
		};
	}
	let died;
	try {
		await collection.storageInstance.cleanup(0);
	} catch (error) {
		died = error;
	}
	assert.match(
		String(died?.message ?? died),
		/simulated death/,
		'compaction died inside the window'
	);
	await db.close();
	const directory = collectionDirectory(basePath);
	const raw = readFileSync(join(directory, 'changelog.txt'), 'utf8');
	assert.ok(raw.length > 0, 'the stale changelog survived the simulated death');
	const operations = JSON.parse(`[${raw}]`);
	assert.equal(typeof operations[0].e, 'string', 'upstream wrote a changelog epoch');
	if (dieAt !== 'persist') {
		const stored = JSON.parse(readFileSync(indexFiles(basePath)[0], 'utf8'));
		assert.equal(stored.changelogEpoch, operations[0].e, 'cleanup persisted the epoch');
		assert.equal(stored.changelogOperations, operations.filter((op) => op[0] === 0).length);
	}
	return Array.from({ length: 6 }, (_, offset) => {
		const index = offset + 4;
		const suffix = String(index).padStart(2, '0');
		return {
			id: `k-${suffix}`,
			status: `s-${suffix}`,
			note: index >= 7 ? 'patched' : 'original',
		};
	});
}

/**
 * The pre-patch corruption that leaves NO structural trace: a store compacted
 * a deletion and died before emptying a legacy, epoch-less changelog. The
 * stale `D` op is in range on the baked rows, so replaying it removes a
 * different, valid document from every index while lengths, order and
 * uniqueness all still hold.
 */
async function seedLegacyStaleDeletion(runtime, basePath) {
	const { db, collection } = await openDatabase(runtime, basePath);
	const documents = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
		id: `k-${id}`,
		status: `s-${id}`,
		note: 'kept',
	}));
	for (const document of documents) await collection.insert(document);
	await fullCleanup(collection);
	await (await collection.findOne('k-c').exec()).remove();
	// Tombstone pass: records the `D` ops for k-c in the changelog.
	await collection.storageInstance.cleanup(0);
	const directory = collectionDirectory(basePath);
	const staleChangelog = readFileSync(join(directory, 'changelog.txt'), 'utf8');
	assert.match(staleChangelog, /"D"/, 'fixture captured a deletion op');
	// Bake it, then model legacy array indexes and an epoch-less stale changelog.
	await fullCleanup(collection);
	await db.close();
	writeFileSync(join(directory, 'changelog.txt'), staleChangelog);
	makeLegacyStore(basePath);
	return documents.filter((document) => document.id !== 'k-c');
}

function makeLegacyStore(basePath) {
	for (const path of indexFiles(basePath)) {
		writeFileSync(path, JSON.stringify(readIndexRows(path)));
	}
	const path = join(collectionDirectory(basePath), 'changelog.txt');
	const operations = JSON.parse(`[${readFileSync(path, 'utf8')}]`);
	assert.equal(typeof operations[0].e, 'string');
	writeFileSync(
		path,
		operations
			.slice(1)
			.map((op) => JSON.stringify(op))
			.join(',')
	);
}

async function seedHealthy(runtime, basePath, documents) {
	const { db, collection } = await openDatabase(runtime, basePath);
	for (const document of documents) await collection.insert(document);
	await fullCleanup(collection);
	await db.close();
}

for (const runtime of runtimes) {
	test(`${runtime.dist}: the desktop cap does not change multi-instance changelog reads`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-changelog-multi`);
		const originalSize = runtime.accessPrototype.getSize;
		const originalRead = runtime.accessPrototype.read;
		let db;
		try {
			const opened = await openDatabase(runtime, basePath, schema, true);
			db = opened.db;
			await opened.collection.insert({ id: 'kept', status: 'kept', note: 'kept' });
			const state = await storageInternals(opened.collection).statePromise;
			const changelogPath = join(collectionDirectory(basePath), 'changelog.txt');
			const bytes = readFileSync(changelogPath);
			let reads = 0;
			runtime.accessPrototype.getSize = async function () {
				return this.fileHandle.filepath === changelogPath
					? 256 * 1024 * 1024 + 1
					: originalSize.call(this);
			};
			runtime.accessPrototype.read = async function (offset, end) {
				if (this.fileHandle.filepath === changelogPath) {
					reads++;
					return bytes;
				}
				return originalRead.call(this, offset, end);
			};
			await state.taskQueue.runCleanup((run) => state.changelog.getChangelogOperations(run));
			assert.equal(reads, 1, 'multi-instance retains its existing replay path');
		} finally {
			runtime.accessPrototype.getSize = originalSize;
			runtime.accessPrototype.read = originalRead;
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});
	test(`${runtime.dist}: oversized live cleanup preserves a reinserted record over old tombstone bytes`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-changelog-reinsert`);
		let db;
		try {
			const opened = await openDatabase(runtime, basePath);
			db = opened.db;
			const collection = opened.collection;
			await collection.insert({ id: 'reused', status: 'kept', note: 'old' });
			for (let i = 0; i < 5; i++) {
				await (await collection.findOne('reused').exec()).incrementalPatch({ note: `old-${i}` });
			}
			await (await collection.findOne('reused').exec()).remove();
			await collection.storageInstance.cleanup(0); // Purge indexes, not document bytes.
			await collection.insert({ id: 'reused', status: 'kept', note: 'new' });
			const state = await storageInternals(collection).statePromise;
			const getOperations = state.changelog.getChangelogOperations;
			state.changelog.getChangelogOperations = async function (...args) {
				state.changelog.getChangelogOperations = getOperations;
				throw Object.assign(new Error('oversized'), {
					name: 'WcposChangelogOversized',
					size: 256 * 1024 * 1024 + 1,
				});
			};
			await fullCleanup(collection);
			await db.close();
			const reopened = await openDatabase(runtime, basePath);
			db = reopened.db;
			assert.deepEqual(await findAll(reopened.collection), [
				{ id: 'reused', status: 'kept', note: 'new' },
			]);
		} finally {
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});
	for (const phase of ['cleanup', 'boot']) {
		test(`${runtime.dist}: oversized changelog ${phase} avoids the read and reclaims persisted files`, async () => {
			const basePath = makeDirectory(`${runtime.dist}-changelog-${phase}`);
			const originalRead = runtime.accessPrototype.read;
			const originalTruncate = runtime.accessPrototype.truncate;
			const oversizedBytes = 3 * 1024 * 1024 * 1024;
			const events = [];
			let oversized = false;
			let attemptedReads = 0;
			const recoveryKind =
				phase === 'boot' ? 'changelog-oversized-rebuilt' : 'changelog-oversized-compacted';
			let db;
			try {
				const opened = await openDatabase(runtime, basePath);
				db = opened.db;
				let collection = opened.collection;
				await collection.bulkInsert([
					{ id: 'kept', status: 'kept', note: 'original' },
					{ id: 'deleted', status: 'gone', note: 'original' },
				]);
				for (let i = 0; i < 20; i++) {
					await (await collection.findOne('kept').exec()).incrementalPatch({ note: `update-${i}` });
				}
				await (await collection.findOne('deleted').exec()).remove();
				// Finish the write run before observing the physical files.
				await storageInternals(collection).taskQueue.awaitIdle();
				const directory = collectionDirectory(basePath);
				const documentsPath = join(directory, 'documents.json');
				const before = statSync(documentsPath).size;
				assert.ok(statSync(join(directory, 'changelog.txt')).size > 0);
				if (phase === 'boot') await db.close();
				// A real sparse 3 GiB file: exercise stat/truncate without allocating GBs.
				truncateSync(join(directory, 'changelog.txt'), oversizedBytes);
				oversized = true;
				globalThis.__wcposOnStorageRecovery = (event) => events.push(event);
				runtime.accessPrototype.read = async function (offset, end) {
					if (oversized && this.fileHandle.filepath === join(directory, 'changelog.txt')) {
						attemptedReads++;
						throw new RangeError('simulated oversized changelog allocation');
					}
					return originalRead.call(this, offset, end);
				};
				runtime.accessPrototype.truncate = async function (size) {
					await originalTruncate.call(this, size);
					if (this.fileHandle.filepath === join(directory, 'changelog.txt') && size === 0)
						oversized = false;
				};
				if (phase === 'boot') {
					const reopened = await openDatabase(runtime, basePath);
					db = reopened.db;
					collection = reopened.collection;
				}
				await fullCleanup(collection);
				assert.equal(attemptedReads, 0, 'never allocates the oversized changelog');
				assert.equal(events.filter((event) => event.kind === recoveryKind).length, 1);
				assert.ok(events.find((event) => event.kind === recoveryKind).bytes >= oversizedBytes);
				assert.equal(statSync(join(directory, 'changelog.txt')).size, 0);
				assert.ok(statSync(documentsPath).size < before, 'documents.json shrinks after recovery');
				await db.close();
				const reopened = await openDatabase(runtime, basePath);
				db = reopened.db;
				assert.deepEqual(await findAll(reopened.collection), [
					{ id: 'kept', status: 'kept', note: 'update-19' },
				]);
			} finally {
				runtime.accessPrototype.read = originalRead;
				runtime.accessPrototype.truncate = originalTruncate;
				delete globalThis.__wcposOnStorageRecovery;
				await db?.close();
				rmSync(basePath, { recursive: true, force: true });
			}
		});
	}
	test(`${runtime.dist}: compaction shrinks dead gaps under a simulated string cap`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-large-gap`);
		let db;
		try {
			const opened = await openDatabase(runtime, basePath);
			db = opened.db;
			const collection = opened.collection;
			const documents = Array.from({ length: 80 }, (_, i) => ({
				id: `k-${String(i).padStart(2, '0')}`,
				status: 'kept',
				note: 'original',
			}));
			await collection.bulkInsert(documents);
			for (let i = 0; i < 20; i++) {
				await (await collection.findOne('k-79').exec()).incrementalPatch({ note: `update-${i}` });
			}
			for (const document of documents.slice(0, 10)) {
				await (await collection.findOne(document.id).exec()).remove();
			}
			const path = join(collectionDirectory(basePath), 'documents.json');
			const before = statSync(path).size;
			const repeat = String.prototype.repeat;
			try {
				String.prototype.repeat = function (count) {
					if (count > 256) throw new RangeError('Invalid string length');
					return repeat.call(this, count);
				};
				while (!(await collection.cleanup(0))) {
					/* cleanup is incremental */
				}
			} finally {
				String.prototype.repeat = repeat;
			}
			assert.ok(statSync(path).size < before, 'documents.json shrank');
			await db.close();
			const reopened = await openDatabase(runtime, basePath);
			db = reopened.db;
			const expected = documents
				.slice(10)
				.map((doc) => (doc.id === 'k-79' ? { ...doc, note: 'update-19' } : doc));
			assert.deepEqual(
				await findAll(reopened.collection),
				expected,
				'all live contents survive reopen'
			);
		} finally {
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`${runtime.dist}: windowed rebuild preserves documents across the 8 MiB boundary`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-windowed`);
		const windowBytes = 8 * 1024 * 1024;
		const largeSchema = {
			...schema,
			properties: {
				...schema.properties,
				note: { type: 'string', maxLength: 2048 },
			},
		};
		const documents = Array.from({ length: 9000 }, (_, i) => ({
			id: `k-${String(i).padStart(5, '0')}`,
			status: 'kept',
			note: `${i}: Ü🍕 "quoted" \\ {braces} ` + 'x'.repeat(1024),
		}));
		const originalRead = runtime.accessPrototype.read;
		let db;
		try {
			const initial = await openDatabase(runtime, basePath, largeSchema);
			db = initial.db;
			for (let i = 0; i < documents.length; i += 500) {
				const result = await initial.collection.bulkInsert(documents.slice(i, i + 500));
				assert.equal(result.error.length, 0);
			}
			await fullCleanup(initial.collection);
			await db.close();
			const bytes = readFileSync(join(collectionDirectory(basePath), 'documents.json'));
			assert.ok(bytes.length > windowBytes);
			const rows = readIndexRows(indexFiles(basePath)[0]);
			const crossing = rows.find((row) => row[1] < windowBytes && row[2] > windowBytes);
			assert.ok(crossing, 'fixture has a document straddling the window boundary');
			const crossingDoc = JSON.parse(bytes.subarray(crossing[1], crossing[2]).toString());
			const crossingIndex = documents.findIndex((doc) => doc.id === crossingDoc.id);
			replaceRowWithNull(indexFiles(basePath)[0]);
			runtime.accessPrototype.read = async function (offset, end) {
				if (this.fileHandle.name === 'documents.json') {
					assert.ok(
						end !== undefined && end - offset <= windowBytes,
						'document reads are bounded to 8 MiB'
					);
				}
				return originalRead.call(this, offset, end);
			};
			const opened = await openWithRebuildEvents(runtime, basePath, largeSchema);
			db = opened.db;
			await storageInternals(opened.collection).statePromise;
			assert.equal(opened.events.length, 1);
			assert.equal(opened.events[0].documents, documents.length, 'every live document was rebuilt');
			for (const index of [
				0,
				crossingIndex - 1,
				crossingIndex,
				crossingIndex + 1,
				documents.length - 1,
			]) {
				const doc = await opened.collection.findOne(documents[index].id).exec();
				assert.ok(doc);
				assert.equal(
					doc.note,
					documents[index].note,
					'contents and absolute offsets survive the boundary'
				);
			}
		} finally {
			runtime.accessPrototype.read = originalRead;
			delete globalThis.__wcposOnIndexRebuild;
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`${runtime.dist}: rebuild re-reads a document larger than a window instead of scanning inside it`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-oversized`);
		const windowBytes = 8 * 1024 * 1024;
		const nestedSchema = {
			...schema,
			properties: {
				...schema.properties,
				note: { type: 'string' },
				nested: { type: 'object' },
			},
		};
		// A nested object carrying the primary-key field is the decoy: scanned from
		// inside the oversized document it would parse as a document of its own.
		const documents = [
			{ id: 'before', status: 'kept', note: 'small', nested: { id: 'decoy-before' } },
			{
				id: 'oversized',
				status: 'kept',
				note: 'x'.repeat(windowBytes + 4096),
				nested: { id: 'decoy-inside', status: 'kept', note: 'nested' },
			},
			{ id: 'after', status: 'kept', note: 'small', nested: { id: 'decoy-after' } },
		];
		let db;
		try {
			const initial = await openDatabase(runtime, basePath, nestedSchema);
			db = initial.db;
			const result = await initial.collection.bulkInsert(documents);
			assert.equal(result.error.length, 0);
			await fullCleanup(initial.collection);
			await db.close();
			replaceRowWithNull(indexFiles(basePath)[0]);
			const opened = await openWithRebuildEvents(runtime, basePath, nestedSchema);
			db = opened.db;
			await storageInternals(opened.collection).statePromise;
			assert.equal(opened.events.length, 1);
			assert.equal(opened.events[0].documents, documents.length, 'exactly the three documents');
			assert.deepEqual(
				(await findAll(opened.collection)).map((doc) => doc.id),
				['after', 'before', 'oversized'],
				'no nested object became a document'
			);
			const oversized = await opened.collection.findOne('oversized').exec();
			assert.equal(oversized.note.length, windowBytes + 4096, 'the oversized document is whole');
		} finally {
			delete globalThis.__wcposOnIndexRebuild;
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`${runtime.dist}: rebuild skips a document past the window cap whole, never its nested objects`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-overcap`);
		const nestedSchema = {
			...schema,
			properties: { ...schema.properties, note: { type: 'string' }, nested: { type: 'object' } },
		};
		const documents = [
			{ id: 'before', status: 'kept', note: 'small', nested: { id: 'decoy-before' } },
			{
				id: 'huge',
				status: 'kept',
				note: 'x'.repeat(300 * 1024),
				nested: { id: 'decoy-inside', status: 'kept', note: 'nested' },
			},
			{ id: 'after', status: 'kept', note: 'small', nested: { id: 'decoy-after' } },
		];
		let db;
		try {
			const initial = await openDatabase(runtime, basePath, nestedSchema);
			db = initial.db;
			assert.equal((await initial.collection.bulkInsert(documents)).error.length, 0);
			await fullCleanup(initial.collection);
			await db.close();
			replaceRowWithNull(indexFiles(basePath)[0]);
			// Shrink the window and its cap below the huge document so the skip path runs.
			globalThis.__wcposRebuildWindowBytes = { bytes: 64 * 1024, max: 128 * 1024 };
			const opened = await openWithRebuildEvents(runtime, basePath, nestedSchema);
			db = opened.db;
			await storageInternals(opened.collection).statePromise;
			assert.equal(opened.events.length, 1);
			assert.equal(opened.events[0].documents, 2, 'the two documents that fit were rebuilt');
			assert.equal(opened.events[0].skipped, 1, 'the over-cap document was skipped whole');
			assert.deepEqual(
				(await findAll(opened.collection)).map((doc) => doc.id),
				['after', 'before'],
				'no nested object of the skipped document became a document'
			);
		} finally {
			delete globalThis.__wcposRebuildWindowBytes;
			delete globalThis.__wcposOnIndexRebuild;
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});
	for (const dieAt of ['empty', 'persist', 'partial']) {
		test(`${runtime.dist}: compaction dying at ${dieAt} preserves documents without double-applying baked operations`, async () => {
			const basePath = makeDirectory(`${runtime.dist}-crash-${dieAt}`);
			try {
				const expected = await seedCrashWindow(runtime, basePath, { dieAt });
				let opened = await openWithRebuildEvents(runtime, basePath);
				assert.deepEqual(await findAll(opened.collection), expected);
				opened.stopCapture();
				if (dieAt === 'empty') {
					// Every index was persisted under the changelog's epoch, so the first reopen
					// skips all of it; a rebuild here would mean the epoch skip was ignored.
					assert.deepEqual(opened.events, [], 'no rebuild on the first reopen');
				} else {
					// An index that never persisted replays the whole changelog over its older
					// rows. Only the op-by-op verifier may send that to a rebuild (never a
					// double-apply, which the document assertion above would catch).
					for (const event of opened.events) {
						assert.match(event.reason, /^stale-changelog-op:/, 'rebuild reason');
					}
				}

				await opened.db.close();

				opened = await openWithRebuildEvents(runtime, basePath);
				assert.deepEqual(await findAll(opened.collection), expected);
				opened.stopCapture();
				assert.deepEqual(opened.events, []);
				await opened.db.close();
			} finally {
				rmSync(basePath, { recursive: true, force: true });
			}
		});
	}

	for (const count of ['x', undefined]) {
		test(`${runtime.dist}: invalid persisted count ${String(count)} rebuilds once`, async () => {
			const basePath = makeDirectory(`${runtime.dist}-invalid-persisted-count`);
			let db;
			try {
				const expected = await seedCrashWindow(runtime, basePath, { dieAt: 'empty' });
				const path = indexFiles(basePath)[0];
				const stored = JSON.parse(readFileSync(path, 'utf8'));
				if (count === undefined) delete stored.changelogOperations;
				else stored.changelogOperations = count;
				writeFileSync(path, JSON.stringify(stored));

				let opened = await openWithRebuildEvents(runtime, basePath);
				db = opened.db;
				assert.deepEqual(await findAll(opened.collection), expected);
				assert.equal(opened.events.length, 1);
				assert.equal(opened.events[0].reason, 'invalid-persisted-count:index-0');
				opened.stopCapture();
				await db.close();

				opened = await openWithRebuildEvents(runtime, basePath);
				db = opened.db;
				assert.deepEqual(await findAll(opened.collection), expected);
				assert.deepEqual(opened.events, []);
				opened.stopCapture();
			} finally {
				delete globalThis.__wcposOnIndexRebuild;
				await db?.close();
				rmSync(basePath, { recursive: true, force: true });
			}
		});
	}

	test(`${runtime.dist}: null rows in primary and secondary indexes self-heal`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-null-rows`);
		const expected = [
			{ id: 'one', status: 'a', note: 'first' },
			{ id: 'two', status: 'b', note: 'second' },
		];
		try {
			await seedHealthy(runtime, basePath, expected);
			const files = indexFiles(basePath);
			replaceRowWithNull(files[0]);
			replaceRowWithNull(files[1], 1);
			let opened = await openWithRebuildEvents(runtime, basePath);
			assert.deepEqual(await findAll(opened.collection), expected);
			opened.stopCapture();
			assert.equal(opened.events.length, 1);
			assert.match(opened.events[0].reason, /^(boot-failed:|hole:)/);
			assertNoNullRows(basePath);
			await opened.db.close();

			opened = await openWithRebuildEvents(runtime, basePath);
			assert.deepEqual(await findAll(opened.collection), expected);
			opened.stopCapture();
			assert.deepEqual(opened.events, []);
			await opened.db.close();
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`${runtime.dist}: a legacy stale changelog is refused before it can punch holes`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-legacy-stale`);
		try {
			const expected = await seedCrashWindow(runtime, basePath);
			makeLegacyStore(basePath);
			const opened = await openWithRebuildEvents(runtime, basePath);
			assert.deepEqual(await findAll(opened.collection), expected);
			opened.stopCapture();
			assert.equal(opened.events.length, 1);
			// Op verification refuses the stale replay before it can punch a hole;
			// the structural validators behind it are the second line of defence.
			assert.match(
				opened.events[0].reason,
				/^(stale-changelog-op:|hole:|length-mismatch|duplicate-primary)/
			);
			await opened.db.close();
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`${runtime.dist}: a legacy stale deletion that leaves no structural trace is caught by op verification`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-legacy-delete`);
		try {
			const expected = await seedLegacyStaleDeletion(runtime, basePath);
			const opened = await openWithRebuildEvents(runtime, basePath);
			assert.deepEqual(await findAll(opened.collection), expected);
			opened.stopCapture();
			assert.equal(opened.events.length, 1);
			assert.match(opened.events[0].reason, /^stale-changelog-op:D:/);
			await opened.db.close();
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`${runtime.dist}: epoch replay skips each baked prefix but still verifies and applies the tail`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-epoch-tail`);
		let db;
		try {
			const initial = await openDatabase(runtime, basePath);
			db = initial.db;
			const expected = ['base', 'prefix', 'tail'].map((id) => ({ id, status: id, note: id }));
			await initial.collection.insert(expected[0]);
			await fullCleanup(initial.collection);
			await initial.collection.insert(expected[1]);
			const state = await storageInternals(initial.collection).statePromise;
			await state.taskQueue.runCleanup(async (run) => {
				const operations = await state.changelog.getChangelogOperations(run);
				// Only one index has the current epoch; siblings still carry the old one.
				await state.indexStates[0].persistInMemoryRows(
					run,
					state.changelog.epoch,
					operations.get(0).length
				);
			});
			await initial.collection.insert(expected[2]);
			await db.close();
			const opened = await openWithRebuildEvents(runtime, basePath);
			db = opened.db;
			assert.deepEqual(await findAll(opened.collection), expected);
			assert.deepEqual(opened.events, [], 'valid mixed-epoch indexes replay without a rebuild');
			opened.stopCapture();
		} finally {
			delete globalThis.__wcposOnIndexRebuild;
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`${runtime.dist}: ordinary pending changelog operations replay without rebuilding`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-pending`);
		const expected = [
			{ id: 'one', status: 'a', note: 'first' },
			{ id: 'two', status: 'b', note: 'second' },
		];
		try {
			const initial = await openDatabase(runtime, basePath);
			for (const document of expected) await initial.collection.insert(document);
			await initial.db.close();
			const opened = await openWithRebuildEvents(runtime, basePath);
			assert.deepEqual(await findAll(opened.collection), expected);
			opened.stopCapture();
			assert.deepEqual(opened.events, []);
			await opened.db.close();
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	// monorepo#2280: boot replay used to run all primary-index history before any
	// secondary op, so the linked range gate compared a historical secondary A/R
	// with the primary's FINAL bytes, skipped it, and the next op on that row
	// rebuilt every index on every reopen.
	const histories = {
		'insert → replace': async (collection) => {
			await collection.insert({ id: 'k', status: 'a', note: 'v1' });
			await (await collection.findOne('k').exec()).incrementalPatch({ note: 'v2' });
		},
		'insert → replace that moves the secondary string': async (collection) => {
			await collection.insert({ id: 'k', status: 'a', note: 'v1' });
			await (await collection.findOne('k').exec()).incrementalPatch({ status: 'b' });
		},
		'insert → delete': async (collection) => {
			await collection.insert({ id: 'k', status: 'a', note: 'v1' });
			await collection.insert({ id: 'gone', status: 'a', note: 'v1' });
			await (await collection.findOne('gone').exec()).remove();
		},
		'replace → replace': async (collection) => {
			await collection.insert({ id: 'k', status: 'a', note: 'v1' });
			await fullCleanup(collection);
			const doc = await collection.findOne('k').exec();
			const patched = await doc.incrementalPatch({ note: 'v2' });
			await patched.incrementalPatch({ status: 'b', note: 'v3' });
		},
	};
	for (const [name, write] of Object.entries(histories)) {
		test(`${runtime.dist}: ${name} replays through linked indexes without rebuilding`, async () => {
			const basePath = makeDirectory(`${runtime.dist}-history`);
			let db;
			try {
				const initial = await openDatabase(runtime, basePath);
				db = initial.db;
				await write(initial.collection);
				const expected = await findAll(initial.collection);
				await db.close();
				for (let reopen = 0; reopen < 2; reopen++) {
					const opened = await openWithRebuildEvents(runtime, basePath);
					db = opened.db;
					assert.deepEqual(await findAll(opened.collection), expected);
					assert.deepEqual(opened.events, [], `reopen ${reopen} replays without a rebuild`);
					opened.stopCapture();
					await db.close();
				}
				db = undefined;
			} finally {
				delete globalThis.__wcposOnIndexRebuild;
				await db?.close();
				rmSync(basePath, { recursive: true, force: true });
			}
		});
	}

	test(`${runtime.dist}: a secondary A whose bytes never matched the primary still rebuilds`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-forged-secondary`);
		let db;
		try {
			const initial = await openDatabase(runtime, basePath);
			db = initial.db;
			const expected = [
				{ id: 'one', status: 'a', note: 'first' },
				{ id: 'two', status: 'b', note: 'second' },
			];
			for (const document of expected) await initial.collection.insert(document);
			await db.close();
			const path = join(collectionDirectory(basePath), 'changelog.txt');
			const operations = JSON.parse(`[${readFileSync(path, 'utf8')}]`);
			const forged = operations.find((op) => Array.isArray(op) && op[0] !== 0 && op[2] === 'A');
			assert.ok(forged, 'fixture holds a secondary A');
			forged[3] = [forged[3][0], forged[3][1] + 1, forged[3][2] + 1];
			writeFileSync(path, operations.map((op) => JSON.stringify(op)).join(','));
			const opened = await openWithRebuildEvents(runtime, basePath);
			db = opened.db;
			assert.deepEqual(await findAll(opened.collection), expected);
			assert.equal(opened.events.length, 1, 'the range gate still runs during boot replay');
			opened.stopCapture();
		} finally {
			delete globalThis.__wcposOnIndexRebuild;
			await db?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`${runtime.dist}: rebuild preserves multibyte document byte offsets`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-multibyte`);
		const expected = [
			{
				id: 'unicode',
				status: 'kept',
				note: 'Ünïcødé 🍕 “quotes” \\ and {braces}',
			},
		];
		try {
			await seedHealthy(runtime, basePath, expected);
			replaceRowWithNull(indexFiles(basePath)[0]);
			const opened = await openWithRebuildEvents(runtime, basePath);
			assert.deepEqual(await findAll(opened.collection), expected);
			opened.stopCapture();
			assert.equal(opened.events.length, 1);
			await opened.db.close();
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});
}

test('both dists carry the audit marker in every patched file', () => {
	for (const dist of ['esm', 'cjs']) {
		for (const file of ['changelog.js', 'cleanup.js', 'helpers.js']) {
			const source = readFileSync(
				join(packageRoot, `dist/${dist}/plugins/storage-abstract-filesystem/${file}`),
				'utf8'
			);
			assert.ok(source.includes(`${MARKER}=${PATCH_VERSION};`), `${dist}/${file}`);
			assert.doesNotMatch(source, /wcpos-changelog-baked|__wcposHash|__wcposLastRaw/);
		}
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
					prelude: `globalThis.${MARKER}=1;\n`,
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
			/carries patch v\d+ but this script is v\d+: restore the pristine dist/
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

for (const fixture of [
	{
		name: 'a duplicate anchor',
		source: '__anchor__ __anchor__',
		error: /anchor fixture matched 2 times/,
	},
	{
		name: 'a missing rewrite',
		source: `globalThis.${MARKER}=${PATCH_VERSION};\n__anchor__`,
		error: /rewrite fixture is missing/,
	},
	{
		name: 'an already patched file',
		source: `globalThis.${MARKER}=${PATCH_VERSION};\n__patched__`,
	},
]) {
	test(`patch preparation handles ${fixture.name}`, () => {
		const directory = makeDirectory('patch-contract');
		const path = join(directory, 'fixture.js');
		writeFileSync(path, fixture.source);
		try {
			const prepare = () =>
				preparePatch(path, {
					prelude: `globalThis.${MARKER}=${PATCH_VERSION};\n`,
					rewrites: [{ name: 'fixture', before: '__anchor__', after: '__patched__' }],
				});
			if (fixture.error) assert.throws(prepare, fixture.error);
			else assert.deepEqual(prepare(), { path, status: 'already patched' });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

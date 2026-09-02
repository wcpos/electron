import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { MARKER, preparePatch } from './patch-rxdb-premium-changelog-replay-safety.mjs';

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
	},
	{
		dist: 'cjs',
		createRxDatabase: cjsRxdb.createRxDatabase,
		getStorage: cjsFilesystem.getRxStorageFilesystemNode,
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

const STAMP_FILE = 'wcpos-changelog-baked.txt';
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

function replaceRowWithNull(path, rowIndex = 0) {
	const rows = JSON.parse(readFileSync(path, 'utf8').trim());
	assert.ok(rows.length > rowIndex, `${path} has a row to corrupt`);
	rows[rowIndex] = null;
	writeFileSync(path, JSON.stringify(rows));
}

function assertNoNullRows(basePath) {
	for (const path of indexFiles(basePath)) {
		assert.ok(!readFileSync(path, 'utf8').includes('null'), `${path} was rebuilt without null`);
	}
}

async function openDatabase(runtime, basePath) {
	const db = await runtime.createRxDatabase({
		name: join(basePath, 'database'),
		storage: runtime.getStorage({ basePath }),
		multiInstance: false,
	});
	const { c } = await db.addCollections({ c: { schema } });
	return { db, collection: c };
}

async function openWithRebuildEvents(runtime, basePath) {
	const events = [];
	const onRebuild = (event) => events.push(event);
	globalThis.__wcposOnIndexRebuild = onRebuild;
	return {
		...(await openDatabase(runtime, basePath)),
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
 * Reproduces #1605's crash window for real: a compaction that has stamped and
 * (optionally) baked the index base files, then dies before `changelog.empty`.
 * `dieAt: 'empty'` kills it after every index persisted; `dieAt: 'persist'`
 * kills it on the first persist. Either way the stale changelog and the stamp
 * the PATCHED cleanup wrote are what the next boot finds on disk.
 */
async function seedCrashWindow(runtime, basePath, { dieAt = 'empty', keepStamp = true } = {}) {
	const { db, collection } = await openDatabase(runtime, basePath);
	for (let index = 0; index < 10; index++) {
		const suffix = String(index).padStart(2, '0');
		await collection.insert({ id: `k-${suffix}`, status: `s-${suffix}`, note: 'original' });
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
		state.indexStates[0].persistInMemoryRows = async () => {
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
	assert.ok(
		readFileSync(join(directory, STAMP_FILE), 'utf8').length > 0,
		'compaction stamped before baking'
	);
	if (!keepStamp) writeFileSync(join(directory, STAMP_FILE), '');
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
 * a deletion, died before emptying the changelog, and carries no stamp. The
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
	// Bake it, then restore the pre-compaction changelog with no stamp.
	await fullCleanup(collection);
	await db.close();
	writeFileSync(join(directory, 'changelog.txt'), staleChangelog);
	writeFileSync(join(directory, STAMP_FILE), '');
	return documents.filter((document) => document.id !== 'k-c');
}

async function seedHealthy(runtime, basePath, documents) {
	const { db, collection } = await openDatabase(runtime, basePath);
	for (const document of documents) await collection.insert(document);
	await fullCleanup(collection);
	await db.close();
}

for (const runtime of runtimes) {
	for (const dieAt of ['empty', 'persist']) {
		test(`${runtime.dist}: compaction dying at ${dieAt} rebuilds instead of replaying baked operations`, async () => {
			const basePath = makeDirectory(`${runtime.dist}-crash-${dieAt}`);
			try {
				const expected = await seedCrashWindow(runtime, basePath, { dieAt });
				let opened = await openWithRebuildEvents(runtime, basePath);
				assert.deepEqual(await findAll(opened.collection), expected);
				opened.stopCapture();
				assert.deepEqual(
					opened.events.map((event) => event.reason),
					['stale-changelog-after-compaction']
				);
				const directory = collectionDirectory(basePath);
				assert.equal(readFileSync(join(directory, 'changelog.txt'), 'utf8'), '');
				assert.equal(readFileSync(join(directory, STAMP_FILE), 'utf8'), '');
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

	test(`${runtime.dist}: a stale changelog without a stamp is refused before it can punch holes`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-unstamped`);
		try {
			const expected = await seedCrashWindow(runtime, basePath, { keepStamp: false });
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

	test(`${runtime.dist}: rebuild preserves multibyte document byte offsets`, async () => {
		const basePath = makeDirectory(`${runtime.dist}-multibyte`);
		const expected = [
			{ id: 'unicode', status: 'kept', note: 'Ünïcødé 🍕 “quotes” \\ and {braces}' },
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
			assert.ok(source.includes('WCPOS_CHANGELOG_REPLAY_SAFETY_PATCH=1'), `${dist}/${file}`);
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

/**
 * Pins `scripts/patch-rxdb-premium-changes-file-salvage.mjs` against the
 * installed rxdb-premium, for BOTH dists (the web worker bundles esm; the
 * electron main process requires cjs — a suite that imported only one could go
 * green while the other rewrite was malformed).
 *
 * The changes file (`changes.json`) is the per-run write-ahead log of the
 * abstract-filesystem storage: `bulkWrite` appends each non-direct event bulk
 * there before resolving, and the pre-run hook folds the bulks into
 * documents.json and truncates the file. Upstream never advances the offset it
 * appends at, so a run's second bulk overwrites the head of a longer first one,
 * and a crash mid-run leaves `{bulk N}` + tail-of-bulk-N-1 for the next boot's
 * bare `JSON.parse` to choke on — every boot, forever, with that run's callers
 * pending (Sentry WOOCOMMERCE-POS-2GA).
 *
 * These tests drive the REAL storage instance: the writes are spied on at the
 * access-handle level to pin the on-disk shape, and the crash residue is built
 * from genuine captured bulks (mutated so the replay is observable) rather than
 * hand-written JSON that might not match what the reader expects.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
	DISTS,
	MARKER,
	MAX_SALVAGE_BYTES,
	preparePatch,
	QUARANTINE_FILE,
} from './patch-rxdb-premium-changes-file-salvage.mjs';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('rxdb-premium/package.json'));

const esmFilesystem = await import('rxdb-premium/plugins/storage-filesystem-node');
const cjsFilesystem = require('rxdb-premium/plugins/storage-filesystem-node');

const runtimes = [
	{ dist: 'esm', getStorage: esmFilesystem.getRxStorageFilesystemNode },
	{ dist: 'cjs', getStorage: cjsFilesystem.getRxStorageFilesystemNode },
];

const schema = {
	version: 0,
	primaryKey: 'id',
	type: 'object',
	properties: {
		id: { type: 'string', maxLength: 32 },
		value: { type: 'string' },
		_deleted: { type: 'boolean' },
		_rev: { type: 'string', minLength: 1 },
		_meta: {
			type: 'object',
			properties: {
				lwt: { type: 'number', minimum: 1, maximum: 1_000_000_000_000_000, multipleOf: 0.01 },
			},
			required: ['lwt'],
			additionalProperties: false,
		},
		_attachments: { type: 'object' },
	},
	required: ['id', 'value', '_deleted', '_rev', '_meta', '_attachments'],
	indexes: [['_deleted', 'id']],
};

function storageParams(token) {
	return {
		databaseName: 'salvage-db',
		collectionName: 'orders',
		schema,
		options: {},
		multiInstance: false,
		devMode: false,
		databaseInstanceToken: token,
	};
}

function document(id, value, sequence) {
	return {
		id,
		value,
		_deleted: false,
		_rev: `1-seed${sequence}`,
		_meta: { lwt: Date.now() + sequence },
		_attachments: {},
	};
}

function collectionDirectory(basePath) {
	const name = readdirSync(basePath).find((entry) => entry.includes('-orders-'));
	assert.ok(name, 'collection storage directory exists');
	return join(basePath, name);
}

function changesFile(basePath) {
	return join(collectionDirectory(basePath), 'changes.json');
}

/**
 * Records every write `bulkWrite` makes to the changes file — offset and bytes —
 * by wrapping the file handle the storage opens its access handle from.
 */
async function captureChangesFileWrites(instance) {
	const state = await instance.internals.statePromise;
	const original = state.changesFileHandle;
	const writes = [];
	state.changesFileHandle = {
		createAccessHandle: async () => {
			const handle = await original.createAccessHandle();
			const getWritable = handle.getWritable.bind(handle);
			handle.getWritable = () => {
				const writable = getWritable();
				const write = writable.write.bind(writable);
				writable.write = async (bytes, options) => {
					writes.push({ at: options.at, bytes: Buffer.from(bytes) });
					return write(bytes, options);
				};
				return writable;
			};
			return handle;
		},
	};
	return writes;
}

function byId(documents) {
	return Object.fromEntries(documents.map((item) => [item.id, item.value]));
}

/**
 * Seeds two documents, waits for that run to end, then issues two updates in
 * ONE fresh run (neither document touched yet, so no hook runs between them —
 * the exact shape whose second append overwrote the first upstream). Returns
 * the captured appends and the documents as stored afterwards.
 */
async function seedAndUpdateInOneRun(runtime, basePath) {
	const storage = runtime.getStorage({ basePath });
	const instance = await storage.createStorageInstance(storageParams('seed'));
	const alpha = document('order:alpha', 'a'.repeat(400), 0);
	const beta = document('order:beta', 'b', 1);
	assert.deepEqual(
		(await instance.bulkWrite([{ document: alpha }, { document: beta }], 'seed')).error,
		[]
	);
	await instance.taskQueue.awaitIdle();
	const writes = await captureChangesFileWrites(instance);
	const emitted = [];
	const subscription = instance.changeStream().subscribe((bulk) => emitted.push(bulk));
	const [alphaResult, betaResult] = await Promise.all([
		instance.bulkWrite(
			[
				{
					previous: alpha,
					document: {
						...alpha,
						value: 'A'.repeat(400),
						_rev: '2-alpha',
						_meta: { lwt: Date.now() + 10 },
					},
				},
			],
			'update-alpha'
		),
		instance.bulkWrite(
			[
				{
					previous: beta,
					document: { ...beta, value: 'B', _rev: '2-beta', _meta: { lwt: Date.now() + 11 } },
				},
			],
			'update-beta'
		),
	]);
	assert.deepEqual([alphaResult.error, betaResult.error], [[], []]);
	await instance.taskQueue.awaitIdle();
	subscription.unsubscribe();
	const stored = await instance.findDocumentsById(['order:alpha', 'order:beta'], false);
	await instance.close();
	return { writes, stored, emitted };
}

/** A genuine captured bulk, re-targeted so its replay is observable. */
function rewriteBulk(bytes, stored, value, revision) {
	const bulk = JSON.parse(bytes.toString().replace(/^,/, ''));
	assert.equal(bulk.events.length, 1);
	const [event] = bulk.events;
	const previous = stored.find((item) => item.id === event.documentId);
	event.previousDocumentData = previous;
	event.documentData = {
		...previous,
		value,
		_rev: revision,
		_meta: { lwt: previous._meta.lwt + 1000 },
	};
	bulk.checkpoint = { id: event.documentId, lwt: event.documentData._meta.lwt };
	return Buffer.from(JSON.stringify(bulk));
}

async function bootWithRecoveryEvents(runtime, basePath, prepare) {
	const events = [];
	const hook = (event) => events.push(event);
	globalThis.__wcposOnStorageRecovery = hook;
	try {
		const instance = await runtime
			.getStorage({ basePath })
			.createStorageInstance(storageParams('boot'));
		prepare?.(instance);
		const documents = await Promise.race([
			instance.findDocumentsById(['order:alpha', 'order:beta'], false),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('boot read never settled')), 3000)
			),
		]);
		await instance.close();
		return { documents, events };
	} finally {
		if (globalThis.__wcposOnStorageRecovery === hook) delete globalThis.__wcposOnStorageRecovery;
	}
}

test('both dists carry the marker and every rewrite', () => {
	for (const { dist, prelude, rewrites } of DISTS) {
		const path = join(
			packageRoot,
			`dist/${dist}/plugins/storage-abstract-filesystem/bulk-write.js`
		);
		const source = readFileSync(path, 'utf8');
		assert.ok(source.includes(`${MARKER}=1`), `${dist} carries the marker`);
		for (const rewrite of rewrites) {
			assert.ok(source.includes(rewrite.after), `${dist} carries rewrite ${rewrite.name}`);
			if (rewrite.before !== rewrite.after) {
				assert.ok(
					!source.includes(rewrite.before),
					`${dist} no longer carries the anchor ${rewrite.name}`
				);
			}
		}
		assert.equal(preparePatch(path, { prelude, rewrites }).status, 'already patched');
	}
	assert.equal(globalThis[MARKER], 1);
});

test('preparePatch fails closed when an anchor is missing', () => {
	const directory = mkdtempSync(join(tmpdir(), 'wcpos-salvage-anchor-'));
	try {
		const path = join(directory, 'bulk-write.js');
		writeFileSync(path, 'export async function bulkWrite(){}');
		assert.throws(
			() => preparePatch(path, { prelude: DISTS[0].prelude, rewrites: DISTS[0].rewrites }),
			/anchor getAccessHandleBinding matched 0 times/
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('preparePatch fails closed on a marker with an outdated prelude', () => {
	const directory = mkdtempSync(join(tmpdir(), 'wcpos-salvage-stale-'));
	try {
		const path = join(directory, 'bulk-write.js');
		// The shape an older revision of this script leaves behind: marker and
		// rewrites present, but not the current prelude.
		writeFileSync(
			path,
			`globalThis.${MARKER}=1;\n${DISTS[0].rewrites.map(({ after }) => after).join('\n')}`
		);
		assert.throws(
			() => preparePatch(path, { prelude: DISTS[0].prelude, rewrites: DISTS[0].rewrites }),
			/outdated prelude/
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

for (const runtime of runtimes) {
	test(`[${runtime.dist}] appends successive bulks of one run instead of overwriting the first`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), `wcpos-salvage-append-${runtime.dist}-`));
		try {
			const { writes, stored, emitted } = await seedAndUpdateInOneRun(runtime, basePath);
			assert.equal(writes.length, 2, 'both updates went through the changes file');
			assert.equal(writes[0].at, 0);
			assert.equal(writes[0].bytes[0], 0x7b, 'first bulk opens an object');
			assert.equal(writes[1].at, writes[0].bytes.length, 'second bulk appended after the first');
			assert.equal(writes[1].bytes[0], 0x2c, 'second bulk is comma-separated');
			// The change stream carries the bulk, never the separator that only
			// belongs in the file.
			assert.equal(emitted.length, 2);
			for (const bulk of emitted) {
				const parsed = typeof bulk === 'string' ? JSON.parse(bulk) : bulk;
				assert.equal(parsed.events.length, 1);
			}
			assert.ok(
				writes[0].bytes.length > writes[1].bytes.length,
				'fixture: first bulk is the longer one'
			);
			assert.deepEqual(byId(stored), { 'order:alpha': 'A'.repeat(400), 'order:beta': 'B' });
			assert.equal(readFileSync(changesFile(basePath)).length, 0, 'run end cleared the file');
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`[${runtime.dist}] salvages the complete leading bulk from an overwritten changes file`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), `wcpos-salvage-overwrite-${runtime.dist}-`));
		try {
			const { writes, stored } = await seedAndUpdateInOneRun(runtime, basePath);
			// What upstream left behind: the shorter second bulk written at offset
			// 0 over the longer first one, then a crash before the run's hook.
			const short = rewriteBulk(writes[1].bytes, stored, 'from-wal', '3-beta');
			const residue = Buffer.concat([short, writes[0].bytes.subarray(short.length)]);
			writeFileSync(changesFile(basePath), residue);
			assert.throws(() => JSON.parse(`[${residue}]`), {
				name: 'SyntaxError',
				message: new RegExp(`after array element in JSON at position ${short.length + 1}`),
			});

			const { documents, events } = await bootWithRecoveryEvents(runtime, basePath);
			assert.deepEqual(byId(documents), {
				'order:alpha': 'A'.repeat(400),
				'order:beta': 'from-wal',
			});
			assert.equal(readFileSync(changesFile(basePath)).length, 0, 'the damaged file was cleared');
			assert.ok(
				readFileSync(join(collectionDirectory(basePath), QUARANTINE_FILE)).equals(residue),
				'the raw residue was quarantined for support'
			);
			assert.equal(events.length, 1);
			const [event] = events;
			assert.equal(event.kind, 'changes-file-salvage');
			assert.equal(event.target, 'salvage-db/orders');
			assert.equal(event.keptBulks, 1);
			assert.equal(event.bytes, residue.length);
			assert.equal(event.quarantined, true);
			assert.equal(event.error.name, 'SyntaxError');

			// Healed for good: the next boot finds a clean file and reports nothing.
			const second = await bootWithRecoveryEvents(runtime, basePath);
			assert.deepEqual(second.events, []);
			assert.deepEqual(byId(second.documents), byId(documents));
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`[${runtime.dist}] clears a changes file with no complete bulk`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), `wcpos-salvage-truncated-${runtime.dist}-`));
		try {
			const { writes, stored } = await seedAndUpdateInOneRun(runtime, basePath);
			const truncated = writes[0].bytes.subarray(0, Math.floor(writes[0].bytes.length / 2));
			writeFileSync(changesFile(basePath), truncated);

			const { documents, events } = await bootWithRecoveryEvents(runtime, basePath);
			assert.deepEqual(byId(documents), byId(stored));
			assert.equal(readFileSync(changesFile(basePath)).length, 0);
			assert.equal(events.length, 1);
			assert.equal(events[0].kind, 'changes-file-discarded');
			assert.equal(events[0].reason, 'no-complete-bulk');
			assert.equal(events[0].keptBulks, 0);
			assert.ok(
				readFileSync(join(collectionDirectory(basePath), QUARANTINE_FILE)).equals(truncated)
			);
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`[${runtime.dist}] replays every bulk of a crashed run now that appends are separated`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), `wcpos-salvage-replay-${runtime.dist}-`));
		try {
			const { writes, stored } = await seedAndUpdateInOneRun(runtime, basePath);
			const residue = Buffer.concat([
				rewriteBulk(writes[0].bytes, stored, 'alpha-from-wal', '3-alpha'),
				Buffer.from(','),
				rewriteBulk(writes[1].bytes, stored, 'beta-from-wal', '3-beta'),
			]);
			writeFileSync(changesFile(basePath), residue);

			const { documents, events } = await bootWithRecoveryEvents(runtime, basePath);
			assert.deepEqual(events, [], 'a well-formed log needs no salvage');
			assert.deepEqual(byId(documents), {
				'order:alpha': 'alpha-from-wal',
				'order:beta': 'beta-from-wal',
			});
			assert.equal(readFileSync(changesFile(basePath)).length, 0);
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});
}

for (const runtime of runtimes) {
	test(`[${runtime.dist}] discards a bulk the replay could not consume even when it parses`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), `wcpos-salvage-invalid-${runtime.dist}-`));
		try {
			const { writes, stored } = await seedAndUpdateInOneRun(runtime, basePath);
			// Valid JSON, invalid bulk: the replay sorts on `_meta.lwt` and keys
			// the index by the document's own primary key — a bulk missing
			// either would throw inside the run lock, exactly the hang this
			// patch removes.
			const bulk = JSON.parse(rewriteBulk(writes[1].bytes, stored, 'unsafe', '3-beta').toString());
			delete bulk.events[0].documentData._meta;
			const residue = Buffer.from(JSON.stringify(bulk));
			assert.doesNotThrow(() => JSON.parse(`[${residue}]`));
			writeFileSync(changesFile(basePath), residue);

			const { documents, events } = await bootWithRecoveryEvents(runtime, basePath);
			assert.deepEqual(byId(documents), byId(stored), 'the unsafe bulk was not replayed');
			assert.equal(readFileSync(changesFile(basePath)).length, 0);
			assert.equal(events.length, 1);
			assert.equal(events[0].kind, 'changes-file-discarded');
			assert.equal(events[0].reason, 'no-complete-bulk');
			assert.match(events[0].error.message, /event bulk 0 failed validation/);
			assert.ok(readFileSync(join(collectionDirectory(basePath), QUARANTINE_FILE)).equals(residue));
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`[${runtime.dist}] clears an oversized damaged changes file without scanning or copying it`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), `wcpos-salvage-oversized-${runtime.dist}-`));
		try {
			const { stored } = await seedAndUpdateInOneRun(runtime, basePath);
			const oversized = Buffer.alloc(MAX_SALVAGE_BYTES + 1, 0x78);
			writeFileSync(changesFile(basePath), oversized);

			// The field case dies inside the decode itself (a 512 MB string), so
			// the guard has to fire before the bytes are ever decoded.
			let oversizedDecodes = 0;
			const { documents, events } = await bootWithRecoveryEvents(runtime, basePath, (instance) => {
				const decode = instance._decode.bind(instance);
				instance._decode = (bytes) => {
					if (bytes.byteLength > MAX_SALVAGE_BYTES) oversizedDecodes += 1;
					return decode(bytes);
				};
			});
			assert.equal(oversizedDecodes, 0, 'the oversized file was never decoded');
			assert.deepEqual(byId(documents), byId(stored));
			assert.equal(readFileSync(changesFile(basePath)).length, 0);
			assert.equal(events.length, 1);
			assert.equal(events[0].kind, 'changes-file-discarded');
			assert.equal(events[0].reason, 'oversized');
			assert.equal(events[0].bytes, oversized.length);
			assert.equal(events[0].quarantined, false);
			assert.ok(
				!existsSync(join(collectionDirectory(basePath), QUARANTINE_FILE)),
				'no quarantine copy of an oversized file'
			);
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});
}

function attachmentsStorageParams(token) {
	return { ...storageParams(token), schema: { ...schema, attachments: {} } };
}

/**
 * With attachments enabled EVERY bulk rides the changes file, and the replay
 * walks `previousDocumentData._attachments` / `documentData._attachments[k]`
 * (premium's `clearDeletedAttachments`) BEFORE the truncate — so a replayed
 * bulk missing those maps throws inside the run lock and recreates the exact
 * permanent boot failure this patch removes. Seeds one document in an
 * attachments-enabled collection, folds the seed bulk away, and returns a
 * genuine captured update bulk against the stored document.
 */
async function seedAttachmentsRun(runtime, basePath) {
	const storage = runtime.getStorage({ basePath });
	const instance = await storage.createStorageInstance(attachmentsStorageParams('seed'));
	const alpha = document('order:alpha', 'a', 0);
	assert.deepEqual((await instance.bulkWrite([{ document: alpha }], 'seed')).error, []);
	await instance.taskQueue.awaitIdle();
	// A read run folds the seed bulk into documents.json and truncates the
	// changes file, so the residue written below is the file's only content.
	const [seeded] = await instance.findDocumentsById(['order:alpha'], false);
	assert.equal(seeded.value, 'a');
	const writes = await captureChangesFileWrites(instance);
	assert.deepEqual(
		(
			await instance.bulkWrite(
				[
					{
						previous: seeded,
						document: {
							...seeded,
							value: 'captured',
							_rev: '2-alpha',
							_meta: { lwt: seeded._meta.lwt + 500 },
						},
					},
				],
				'update-alpha'
			)
		).error,
		[]
	);
	await instance.taskQueue.awaitIdle();
	const stored = await instance.findDocumentsById(['order:alpha'], false);
	await instance.close();
	assert.equal(writes.length, 1, 'the update went through the changes file');
	assert.equal(readFileSync(changesFile(basePath)).length, 0, 'residue starts from an empty file');
	return { bulkBytes: writes[0].bytes, stored };
}

async function bootAttachmentsWithRecoveryEvents(runtime, basePath) {
	const events = [];
	const hook = (event) => events.push(event);
	globalThis.__wcposOnStorageRecovery = hook;
	try {
		const instance = await runtime
			.getStorage({ basePath })
			.createStorageInstance(attachmentsStorageParams('boot'));
		const documents = await Promise.race([
			instance.findDocumentsById(['order:alpha'], false),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('boot read never settled')), 3000)
			),
		]);
		await instance.close();
		return { documents, events };
	} finally {
		if (globalThis.__wcposOnStorageRecovery === hook) delete globalThis.__wcposOnStorageRecovery;
	}
}

for (const runtime of runtimes) {
	test(`[${runtime.dist}] discards a bulk whose previous document lacks the attachment map the replay walks`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), `wcpos-salvage-attachments-${runtime.dist}-`));
		try {
			const { bulkBytes, stored } = await seedAttachmentsRun(runtime, basePath);
			const bulk = JSON.parse(rewriteBulk(bulkBytes, stored, 'unsafe', '3-alpha').toString());
			delete bulk.events[0].previousDocumentData._attachments;
			const residue = Buffer.from(JSON.stringify(bulk));
			assert.doesNotThrow(() => JSON.parse(`[${residue}]`));
			writeFileSync(changesFile(basePath), residue);

			const { documents, events } = await bootAttachmentsWithRecoveryEvents(runtime, basePath);
			assert.deepEqual(byId(documents), byId(stored), 'the unsafe bulk was not replayed');
			assert.equal(readFileSync(changesFile(basePath)).length, 0);
			assert.equal(events.length, 1);
			assert.equal(events[0].kind, 'changes-file-discarded');
			assert.equal(events[0].reason, 'no-complete-bulk');
			assert.match(events[0].error.message, /event bulk 0 failed validation/);
			assert.ok(readFileSync(join(collectionDirectory(basePath), QUARANTINE_FILE)).equals(residue));
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`[${runtime.dist}] replays a bulk whose attachment maps are intact`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), `wcpos-salvage-attachments-ok-${runtime.dist}-`));
		try {
			const { bulkBytes, stored } = await seedAttachmentsRun(runtime, basePath);
			const residue = rewriteBulk(bulkBytes, stored, 'replayed', '3-alpha');
			writeFileSync(changesFile(basePath), residue);

			const { documents, events } = await bootAttachmentsWithRecoveryEvents(runtime, basePath);
			assert.deepEqual(byId(documents), { 'order:alpha': 'replayed' });
			assert.equal(readFileSync(changesFile(basePath)).length, 0);
			assert.deepEqual(events, [], 'a valid attachment bulk replays without recovery');
		} finally {
			rmSync(basePath, { recursive: true, force: true });
		}
	});
}

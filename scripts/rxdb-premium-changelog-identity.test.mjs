import assert from 'node:assert/strict';
import {
	closeSync,
	fstatSync,
	ftruncateSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
	getPrimaryKeyFromIndexableString,
	normalizeMangoQuery,
	prepareQuery,
} from 'rxdb/plugins/core';

import { withTargetedOpfsRecovery } from './opfs-targeted-recovery.mjs';
import {
	applyChangelogOperation,
	DISTS,
	MARKER,
	preparePatch,
} from './patch-rxdb-premium-changelog-identity.mjs';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('rxdb-premium/package.json'));
const dists = await Promise.all(
	['esm', 'cjs'].map(async (dist) => ({
		dist,
		index: await import(
			pathToFileURL(
				join(packageRoot, `dist/${dist}/plugins/storage-abstract-filesystem/index-state.js`)
			).href
		),
		storage: await import(
			pathToFileURL(join(packageRoot, `dist/${dist}/plugins/storage-filesystem-node/index.js`)).href
		),
	}))
);

function stateFor(rows, primary = true) {
	rows = structuredClone(rows);
	return {
		rows,
		primaryKeyLength: 3,
		metaIdMap: primary
			? new Map(rows.map((row) => [getPrimaryKeyFromIndexableString(row[0], 3), row]))
			: undefined,
	};
}

// The upstream positional algorithm, retained to compare identical inputs and
// prove the stale-delete regression would remove an unrelated neighbour.
function upstreamApply(state, op) {
	const pos = op[1];
	const row = op[3];
	const key = getPrimaryKeyFromIndexableString(row[0], state.primaryKeyLength);
	if (op[2] === 'A') {
		state.rows.splice(pos, 0, row);
		state.metaIdMap?.set(key, row);
	} else if (op[2] === 'D') {
		state.rows.splice(pos, 1);
		state.metaIdMap?.delete(key);
	} else {
		if (op[2] !== 'R') throw new Error('unknown operation key ' + op[2]);
		state.rows[pos] = row;
		state.metaIdMap?.set(key, row);
	}
}

const a = ['a001', 10, 20];
const b = ['b002', 20, 30];
const c = ['c003', 30, 40];
const updatedB = ['b002', 100, 120];
const movedB = ['d002', 100, 120];
const cases = [
	...['A', 'R'].flatMap((kind) =>
		[0, 9].map((pos) => ({
			name: `stale ${kind} old-string at position ${pos} after D old/A new is ignored`,
			rows: [a, b, c],
			ops: [
				[0, 1, 'D', b],
				[0, 2, 'A', movedB],
				[0, pos, kind, b],
			],
			want: [a, c, movedB],
		}))
	),
	...[1, 0, 9].flatMap((pos) => [
		{
			name: `tagged D at ${pos} preserves a same-string re-add`,
			rows: [a, b, c],
			ops: [
				[0, 1, 'D', b],
				[0, 1, 'A', updatedB],
				[0, pos, 'D', b, 'wcpos-exact'],
			],
			want: [a, updatedB, c],
		},
		{
			name: `tagged D at ${pos} removes the exact row`,
			rows: [a, b, c],
			ops: [[0, pos, 'D', b, 'wcpos-exact']],
			want: [a, c],
		},
	]),
	{
		name: 'duplicate D leaves the neighbour and map intact',
		rows: [a, b, c],
		ops: [
			[0, 1, 'D', b],
			[0, 1, 'D', b],
		],
		want: [a, c],
	},
	{
		name: 'D at a wrong position removes the matching string elsewhere',
		rows: [a, b, c],
		ops: [[0, 0, 'D', b]],
		want: [a, c],
	},
	{
		name: 'write-shaped D identifies the old string, not the new byte range',
		rows: [a, b, c],
		ops: [[0, 1, 'D', updatedB]],
		want: [a, c],
	},
	{
		name: 'write-shaped D also finds the old string at a shifted position',
		rows: [a, b, c],
		ops: [[0, 9, 'D', updatedB]],
		want: [a, c],
	},
	{
		name: 'mixed-version untagged D still removes a same-string re-add',
		rows: [a, b, c],
		ops: [
			[0, 1, 'D', b],
			[0, 1, 'A', updatedB],
			[0, 1, 'D', b],
		],
		want: [a, c],
	},
	{
		name: 'A at a wrong position lands sorted',
		rows: [a, c],
		ops: [[0, 0, 'A', b]],
		want: [a, b, c],
	},
	{
		name: 'A beyond the current end lands sorted',
		rows: [a, c],
		ops: [[0, 9, 'A', b]],
		want: [a, b, c],
	},
	{
		name: 'duplicate A is a no-op',
		rows: [a, b, c],
		ops: [[0, 1, 'A', b]],
		want: [a, b, c],
	},
	{
		name: 'duplicate A at a stale position does not insert a duplicate string',
		rows: [a, b, c],
		ops: [[0, 0, 'A', b]],
		want: [a, b, c],
	},
	{
		name: 'A for an existing document replaces its row',
		rows: [a, b, c],
		ops: [[0, 1, 'A', updatedB]],
		want: [a, updatedB, c],
	},
	{
		name: 'A for an existing document at a stale position replaces its row',
		rows: [a, b, c],
		ops: [[0, 3, 'A', updatedB]],
		want: [a, updatedB, c],
	},
	{
		name: 'R at a wrong position updates the right document',
		rows: [a, b, c],
		ops: [[0, 0, 'R', updatedB]],
		want: [a, updatedB, c],
	},
	{
		name: 'R for an unknown document inserts sorted',
		rows: [a, c],
		ops: [[0, 0, 'R', b]],
		want: [a, b, c],
	},
	{
		name: 'R after the current end appends without a hole',
		rows: [a, b],
		ops: [[0, 9, 'R', c]],
		want: [a, b, c],
	},
	{
		name: 'A before the first string inserts at the start',
		rows: [b, c],
		ops: [[0, 2, 'A', a]],
		want: [a, b, c],
	},
	{
		name: 'A into an empty index ignores a stale position',
		rows: [],
		ops: [[0, 4, 'A', a]],
		want: [a],
	},
	{
		name: 'R into an empty index inserts the missing row',
		rows: [],
		ops: [[0, 4, 'R', a]],
		want: [a],
	},
	{
		name: 'D into an empty index is a no-op',
		rows: [],
		ops: [[0, 4, 'D', a]],
		want: [],
	},
];

const implementations = dists.map(({ dist, index }) => ({
	name: dist,
	apply: (state, op) => index.IndexState.prototype.runChangelogOperation.call(state, op),
}));

implementations.push({
	name: 'exported',
	apply: (state, op) => applyChangelogOperation(state, op, getPrimaryKeyFromIndexableString),
});

for (const { name, apply } of implementations) {
	for (const kind of ['A', 'R']) {
		for (const pos of [0, 1, 9]) {
			test(`[${name}/linked] stale ${kind} at position ${pos} is ignored`, () => {
				const state = stateFor([a, b, c], false);
				state.__wcposIndexStates = [stateFor([a, movedB, c]), state];
				for (const op of [
					[1, 1, 'D', b],
					[1, 2, 'A', movedB],
					[1, pos, kind, b],
				]) {
					apply(state, structuredClone(op));
				}
				assert.deepEqual(state.rows, [a, c, movedB]);
			});
			for (const known of [true, false]) {
				test(`[${name}/linked] ${kind} at ${pos}, primary knows document: ${known}`, () => {
					const state = stateFor([a, c], false);
					state.__wcposIndexStates = [stateFor(known ? [a, updatedB, c] : [a, c]), state];
					apply(state, [1, pos, kind, updatedB]);
					assert.deepEqual(state.rows, known ? [a, updatedB, c] : [a, c]);
				});
			}
		}
		for (const current of [
			['b002', 21, 30],
			['b002', 20, 31],
		]) {
			test(`[${name}/linked] ${kind} cannot overwrite a different current range ${current}`, () => {
				const state = stateFor([a, current, c], false);
				state.__wcposIndexStates = [stateFor([a, current, c]), state];
				apply(state, [1, 1, kind, b]);
				assert.deepEqual(state.rows, [a, current, c]);
			});
		}
	}
	test(`[${name}/linked] primary-first D/A batch converges`, () => {
		const states = [stateFor([a, b, c]), stateFor([a, b, c], false)];
		for (const state of states) state.__wcposIndexStates = states;
		for (const op of [
			[0, 1, 'D', b],
			[0, 1, 'A', updatedB],
			[1, 1, 'D', b],
			[1, 2, 'A', movedB],
		]) {
			apply(states[op[0]], structuredClone(op));
		}
		assert.deepEqual(states[0].rows, [a, updatedB, c]);
		assert.deepEqual(states[1].rows, [a, c, movedB]);
		assert.strictEqual(states[0].metaIdMap.get('002'), states[0].rows[1]);
	});

	for (const primary of [true, false]) {
		const label = `${name}/${primary ? 'primary' : 'secondary'}`;
		for (const pos of [1, 0, 9, 2]) {
			test(`[${label}] tagged D at ${pos} removes the second same-string row`, () => {
				const state = stateFor([a, b, updatedB, c], primary);
				apply(state, [0, pos, 'D', structuredClone(updatedB), 'wcpos-exact']);
				assert.deepEqual(state.rows, [a, b, c]);
				if (primary) {
					assert.equal(state.metaIdMap.has('002'), false);
					assert.strictEqual(state.metaIdMap.get('001'), state.rows[0]);
					assert.strictEqual(state.metaIdMap.get('003'), state.rows[2]);
				}
			});
			test(`[${label}] tagged D at ${pos} preserves same-string rows when neither range matches`, () => {
				const state = stateFor([a, b, updatedB, c], primary);
				const mapped = state.metaIdMap?.get('002');
				apply(state, [0, pos, 'D', ['b002', 20, 120], 'wcpos-exact']);
				assert.deepEqual(state.rows, [a, b, updatedB, c]);
				if (primary) assert.strictEqual(state.metaIdMap.get('002'), mapped);
			});
		}
		for (const kind of ['A', 'D', 'R']) {
			test(`[${label}] correct-position ${kind} matches upstream`, () => {
				const rows = kind === 'A' ? [a, c] : [a, b, c];
				const actual = stateFor(rows, primary);
				const expected = stateFor(rows, primary);
				const op = [0, 1, kind, kind === 'R' ? updatedB : b];
				upstreamApply(expected, structuredClone(op));
				apply(actual, structuredClone(op));
				assert.deepEqual(actual, expected);
			});
		}
		for (const { name: scenario, rows, ops, want } of cases) {
			test(`[${label}] ${scenario}`, () => {
				const state = stateFor(rows, primary);
				for (const op of structuredClone(ops)) apply(state, op);
				assert.deepEqual(state, stateFor(want, primary));
				for (const row of state.rows) {
					if (primary) assert.strictEqual(state.metaIdMap.get(row[0].slice(-3)), row);
				}
			});
		}
		test(`[${label}] unknown op throws the upstream message`, () => {
			assert.throws(() => apply(stateFor([a], primary), [0, 0, 'X', a]), {
				message: 'unknown operation key X',
			});
		});
	}

	test(`[${name}] tagged D of the second same-string row preserves a map pointing at the first`, () => {
		const state = stateFor([a, b, updatedB, c]);
		const first = state.rows[1];
		state.metaIdMap.set('002', first);
		apply(state, [0, 1, 'D', structuredClone(updatedB), 'wcpos-exact']);
		assert.deepEqual(state.rows, [a, b, c]);
		assert.strictEqual(state.metaIdMap.get('002'), first);
	});

	test(`[${name}] duplicate A at the correct position preserves row object identity`, () => {
		const state = stateFor([a, b, c]);
		const original = state.rows[1];
		apply(state, [0, 1, 'A', structuredClone(b)]);
		assert.strictEqual(state.rows[1], original);
		assert.strictEqual(state.metaIdMap.get('002'), original);
		assert.equal(state.rows.length, 3);
	});

	test(`[${name}] D removes a map entry containing a distinct but equal row`, () => {
		const state = stateFor([a, b, c]);
		state.metaIdMap.set('002', structuredClone(b));
		apply(state, [0, 1, 'D', updatedB]);
		assert.deepEqual(state, stateFor([a, c]));
	});

	for (const mapped of [
		['z002', 20, 30],
		['b002', 21, 30],
		['b002', 20, 31],
	]) {
		test(`[${name}] D preserves a map entry for a different row ${mapped}`, () => {
			const state = stateFor([a, b, c]);
			state.metaIdMap.set('002', mapped);
			apply(state, [0, 1, 'D', updatedB]);
			assert.deepEqual(state.rows, [a, c]);
			assert.strictEqual(state.metaIdMap.get('002'), mapped);
		});
	}

	test(`[${name}] absent D leaves an existing map entry untouched`, () => {
		const state = stateFor([a, c]);
		state.metaIdMap.set('002', updatedB);
		apply(state, [0, 1, 'D', b]);
		assert.deepEqual(state.rows, [a, c]);
		assert.strictEqual(state.metaIdMap.get('002'), updatedB);
	});
}

const schema = {
	title: 'changelog identity probe',
	version: 0,
	primaryKey: 'id',
	type: 'object',
	properties: {
		id: { type: 'string', maxLength: 3 },
		value: { type: 'string', maxLength: 20 },
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
	indexes: [
		['_deleted', 'id'],
		['value', 'id'],
	],
};

// Subscribe after premium's own handler: resolving this barrier means the
// message has actually been applied, not merely sent. No timing sleeps.
function nextEvent(state) {
	return new Promise((resolve) => {
		const subscription = state.broadcastChannelMessages$.subscribe((message) => {
			if (message.type !== 'event') return;
			subscription.unsubscribe();
			resolve(message);
		});
	});
}

for (const { dist, storage } of dists) {
	test(`[${dist}] exact write and cleanup deletes persist and boot replay without rebuilding`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), 'wcpos-delete-replay-'));
		const instances = [];
		const states = [];
		const previousHook = globalThis.__wcposOnIndexRebuild;
		const rebuilds = [];
		globalThis.__wcposOnIndexRebuild = (event) => rebuilds.push(event);
		try {
			const engine = storage.getRxStorageFilesystemNode({ basePath });
			const params = {
				databaseName: `replay-${dist}`,
				collectionName: 'products',
				schema,
				options: {},
				multiInstance: true,
				devMode: false,
			};
			const open = async (token) => {
				const instance = await engine.createStorageInstance({
					...params,
					databaseInstanceToken: token,
				});
				instances.push(instance);
				states.push(await instance.internals.statePromise);
				return instance;
			};
			const writer = await open('writer');
			const first = {
				id: '001',
				value: 'original',
				_rev: '1-original',
				_deleted: false,
				_meta: { lwt: Date.now() - 1000 },
				_attachments: {},
			};
			assert.deepEqual((await writer.bulkWrite([{ document: first }], 'seed')).error, []);
			await writer.taskQueue.awaitIdle();
			await writer.taskQueue.runCleanup(async (run) => {
				for (const index of states[0].indexStates) await index.persistInMemoryRows(run);
				await states[0].changelog.empty(run);
			});
			const current = { ...first, value: 'changed', _rev: '2-deleted', _deleted: true };
			assert.deepEqual(
				(await writer.bulkWrite([{ previous: first, document: current }], 'delete')).error,
				[]
			);
			await writer.close();
			const reopened = await open('reopened');
			assert.deepEqual(await reopened.findDocumentsById(['001'], true), [current]);
			assert.deepEqual(rebuilds, [], 'tagged write delete replays without a rebuild');
			const state = states.at(-1);
			const rows = structuredClone(state.indexStates.map((index) => index.rows[0]));
			const cleanup = await import(
				pathToFileURL(
					join(packageRoot, `dist/${dist}/plugins/storage-abstract-filesystem/cleanup.js`)
				).href
			);
			await reopened.taskQueue.runCleanup(async (run) => {
				for (const index of state.indexStates) await index.persistInMemoryRows(run);
				await state.changelog.empty(run);
				assert.deepEqual(await cleanup.cleanupDeletedDocuments(reopened, run, 0), ['001']);
				const operations = [...(await state.changelog.getChangelogOperations(run)).values()].flat();
				assert.deepEqual(
					operations,
					rows.map((row, index) => [index, 0, 'D', row, 'wcpos-exact'])
				);
			});
			await reopened.close();
			const afterCleanup = await open('after-cleanup');
			assert.deepEqual(await afterCleanup.findDocumentsById(['001'], true), []);
			assert.ok(states.at(-1).indexStates.every((index) => index.rows.length === 0));
			assert.deepEqual(rebuilds, [], 'tagged cleanup delete replays without a rebuild');
		} finally {
			for (const instance of instances) await instance.close();
			for (const state of states) state.broadcastChannel?.close();
			globalThis.__wcposOnIndexRebuild = previousHook;
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`[${dist}] recovery dispatches before a queued peer cleanup persists and empties the changelog`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), 'wcpos-repair-dispatch-'));
		const instances = [];
		const states = [];
		const prototype = storage.NodeFilesystemFileHandle.prototype;
		const createAccessHandle = prototype.createAccessHandle;
		const previousHook = globalThis.__wcposOnStorageRecovery;
		globalThis.__wcposOnStorageRecovery = () => {};
		// OPFS access handles do synchronous I/O. Node's async fs otherwise yields
		// during close and masks the missing broadcast yield. Keep real disk bytes,
		// premium instances, the real BroadcastChannel and the shared Web Lock.
		prototype.createAccessHandle = async function () {
			const fd = openSync(this.filepath, 'r+');
			return {
				getSize: async () => fstatSync(fd).size,
				read: async (start, end = fstatSync(fd).size) => {
					const bytes = new Uint8Array(end - start);
					readSync(fd, bytes, 0, bytes.length, start);
					return bytes;
				},
				getWritable: async () => ({
					write: async (bytes, { at }) => {
						writeSync(fd, bytes, 0, bytes.length, at);
					},
				}),
				truncate: async (size) => ftruncateSync(fd, size),
				close: async () => closeSync(fd),
			};
		};
		try {
			const engine = storage.getRxStorageFilesystemNode({ basePath });
			const params = {
				databaseName: `dispatch-${dist}`,
				collectionName: 'products',
				schema,
				options: {},
				multiInstance: true,
				devMode: false,
			};
			for (const token of ['owner', 'peer']) {
				const instance = await withTargetedOpfsRecovery(engine, {
					ownsRepairs: () => token === 'owner',
				}).createStorageInstance({ ...params, databaseInstanceToken: token });
				instances.push(instance);
				states.push(await instance.internals.statePromise);
			}
			const [owner, peer] = instances;
			const [ownerState, peerState] = states;
			const documents = ['001', '002'].map((id) => ({
				id,
				value: id,
				_rev: '1-seed',
				_deleted: false,
				_meta: { lwt: Date.now() },
				_attachments: {},
			}));
			const seeded = nextEvent(ownerState);
			assert.deepEqual(
				(
					await peer.bulkWrite(
						documents.map((document) => ({ document })),
						'seed'
					)
				).error,
				[]
			);
			await seeded;
			await peer.taskQueue.awaitIdle();
			await (
				await peerState.dirHandle
			).getFileHandle('wcpos-changelog-baked.txt', { create: true });
			const row = ownerState.firstIdx.metaIdMap.get('001');
			await owner.taskQueue.runCleanup(async (run) => {
				const handle = await ownerState.documentFileHandle.createAccessHandle();
				run.accessHandlers.set(ownerState.documentFileHandle, Promise.resolve(handle));
				await (
					await handle.getWritable()
				).write(new Uint8Array(row[2] - row[1]).fill(32), { at: row[1] });
			});
			const cleanup = await import(
				pathToFileURL(
					join(packageRoot, `dist/${dist}/plugins/storage-abstract-filesystem/cleanup.js`)
				).href
			);
			const runCleanup = owner.taskQueue.runCleanup.bind(owner.taskQueue);
			let peerCleanup;
			owner.taskQueue.runCleanup = (callback) =>
				runCleanup(async (run) => {
					peerCleanup = peer.taskQueue.runCleanup((peerRun) =>
						cleanup.cleanupChangelogOperations(peer, peerRun)
					);
					return callback(run);
				});
			assert.deepEqual(await owner.findDocumentsById(['001'], false), []);
			assert.ok(peerCleanup, 'peer cleanup queued while owner holds the lock');
			await peerCleanup;
			for (const instance of instances) await instance.close();
			instances.length = 0;
			for (const token of ['owner-reopened', 'peer-reopened']) {
				const reopened = await engine.createStorageInstance({
					...params,
					databaseInstanceToken: token,
				});
				instances.push(reopened);
				const state = await reopened.internals.statePromise;
				states.push(state);
				for (const index of state.indexStates) {
					assert.equal(index.rows.length, 1, 'dropped row absent from persisted indexes');
					assert.equal(index.rows[0][0].slice(-3), '002');
				}
				assert.deepEqual(await reopened.findDocumentsById(['002'], false), [documents[1]]);
			}
		} finally {
			for (const instance of instances) await instance.close();
			for (const state of states) state.broadcastChannel?.close();
			prototype.createAccessHandle = createAccessHandle;
			globalThis.__wcposOnStorageRecovery = previousHook;
			rmSync(basePath, { recursive: true, force: true });
		}
	});

	test(`[${dist}] a delayed write-shaped D no longer removes a newer same-string re-add`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), 'wcpos-write-delete-'));
		const instances = [];
		const states = [];
		const engine = storage.getRxStorageFilesystemNode({ basePath });
		const params = {
			databaseName: `write-${dist}`,
			collectionName: 'products',
			schema,
			options: {},
			multiInstance: true,
			devMode: false,
		};
		try {
			for (const token of ['writer', 'peer']) {
				const instance = await withTargetedOpfsRecovery(engine, {
					onInstance: (live, passed) => {
						assert.equal(passed.databaseInstanceToken, token);
						instances.push(live);
					},
				}).createStorageInstance({ ...params, databaseInstanceToken: token });
				// Registration is part of the production wrapper, not a test-only caller.
				assert.equal(instances.at(-1), instance);
				states.push(await instance.internals.statePromise);
			}
			const [writer, peer] = instances;
			const [writerState, peerState] = states;
			let previous = {
				id: '001',
				value: 'same',
				_rev: '1-seed',
				_deleted: false,
				_meta: { lwt: Date.now() },
				_attachments: {},
			};
			const seeded = nextEvent(peerState);
			assert.deepEqual((await writer.bulkWrite([{ document: previous }], 'seed')).error, []);
			await seeded;
			await writer.taskQueue.awaitIdle();
			// Bake the seed so reopening must replay the changed delete payload.
			await writer.taskQueue.runCleanup(async (run) => {
				for (const index of writerState.indexStates) await index.persistInMemoryRows(run);
				await writerState.changelog.empty(run);
			});
			const onmessage = peerState.broadcastChannel.onmessage;
			const delayed = [];
			const valueIndex = peerState.indexStates.find((index) => index.index[0] === 'value').indexId;
			const withhold = (op) => op[2] === 'D' && op[0] === valueIndex;
			peerState.broadcastChannel.onmessage = ({ data }) => {
				delayed.push(...data.changelogOperations.filter(withhold));
				onmessage({
					data: {
						...data,
						changelogOperations: data.changelogOperations.filter((op) => !withhold(op)),
					},
				});
			};
			for (const [revision, value] of [
				[2, 'different'],
				[3, 'same'],
			]) {
				const document = {
					...previous,
					value,
					_rev: `${revision}-updated`,
					_meta: { lwt: previous._meta.lwt + 1 },
				};
				const received = nextEvent(peerState);
				assert.deepEqual((await writer.bulkWrite([{ previous, document }], 'update')).error, []);
				await received;
				peerState.broadcastChannel.onmessage = onmessage;
				previous = document;
			}
			assert.ok(delayed.length > 0);
			const before = structuredClone(peerState.indexStates.map((index) => index.rows));
			const delivered = nextEvent(peerState);
			onmessage({
				data: {
					type: 'event',
					eventBulks: [],
					changelogOperations: delayed,
					info: { db: params.databaseName, col: params.collectionName },
				},
			});
			await delivered;
			assert.deepEqual(
				peerState.indexStates.map((index) => index.rows),
				before
			);
			assert.deepEqual(await peer.findDocumentsById(['001'], false), [previous]);
			await writer.taskQueue.awaitIdle();
			await writer.taskQueue.runCleanup(async (run) => {
				const operations = [
					...(await writerState.changelog.getChangelogOperations(run)).values(),
				].flat();
				const deletes = operations.filter((op) => op[2] === 'D');
				assert.ok(deletes.length > 0);
				assert.ok(
					deletes.every((op) => op[4] === 'wcpos-exact'),
					'fifth element survives JSON persistence'
				);
			});
			for (const instance of instances) await instance.close();
			instances.length = 0;
			const reopened = await engine.createStorageInstance({
				...params,
				databaseInstanceToken: 'reopened',
			});
			instances.push(reopened);
			states.push(await reopened.internals.statePromise);
			assert.deepEqual(
				states.at(-1).indexStates.map((index) => index.rows),
				before
			);
			assert.deepEqual(await reopened.findDocumentsById(['001'], false), [previous]);
		} finally {
			for (const instance of instances) await instance.close();
			for (const state of states) state.broadcastChannel?.close();
			rmSync(basePath, { recursive: true, force: true });
		}
	});
	test(
		`[${dist}] delayed recovery D preserves a peer's same-string re-add`,
		{ timeout: 5000 },
		async () => {
			const basePath = mkdtempSync(join(tmpdir(), 'wcpos-exact-delete-'));
			const instances = [];
			const states = [];
			let leader = 'owner';
			const previousHook = globalThis.__wcposOnStorageRecovery;
			globalThis.__wcposOnStorageRecovery = () => {};
			try {
				const engine = storage.getRxStorageFilesystemNode({ basePath });
				for (const token of ['owner', 'peer']) {
					const instance = await withTargetedOpfsRecovery(engine, {
						ownsRepairs: () => leader === token,
					}).createStorageInstance({
						databaseName: `exact-${dist}`,
						collectionName: 'products',
						schema,
						options: {},
						multiInstance: true,
						devMode: false,
						databaseInstanceToken: token,
					});
					instances.push(instance);
					states.push(await instance.internals.statePromise);
				}
				const [owner, peer] = instances;
				const [ownerState, peerState] = states;
				const original = {
					id: '001',
					value: 'same',
					_deleted: false,
					_rev: '1-hollow',
					_meta: { lwt: Date.now() },
					_attachments: {},
				};
				const seeded = nextEvent(peerState);
				assert.deepEqual((await owner.bulkWrite([{ document: original }], 'seed')).error, []);
				await seeded;
				await owner.taskQueue.awaitIdle();
				const oldRows = structuredClone(ownerState.indexStates.map((index) => index.rows[0]));
				await owner.taskQueue.runCleanup(async (runState) => {
					const handle = await ownerState.documentFileHandle.createAccessHandle();
					runState.accessHandlers.set(ownerState.documentFileHandle, Promise.resolve(handle));
					const writable = await handle.getWritable();
					await writable.write(new Uint8Array(oldRows[0][2] - oldRows[0][1]).fill(32), {
						at: oldRows[0][1],
					});
				});
				const onmessage = peerState.broadcastChannel.onmessage;
				const delayed = [];
				let received;
				const withheld = new Promise((resolve) => {
					received = resolve;
				});
				peerState.broadcastChannel.onmessage = (event) => {
					delayed.push(event);
					if (delayed.length === oldRows.length) received();
				};
				assert.deepEqual(await owner.findDocumentsById(['001'], false), []);
				await withheld;
				assert.equal(peerState.firstIdx.rows.length, 1, 'peer has not applied the owner delete');
				assert.deepEqual(
					delayed.flatMap(({ data }) => data.changelogOperations),
					oldRows.map((row, index) => [index, 0, 'D', row, 'wcpos-exact'])
				);
				leader = 'peer';
				const current = { ...original, _rev: '2-readded' };
				// The new owner recovers its still-hollow local row before inserting.
				assert.deepEqual((await peer.bulkWrite([{ document: current }], 're-add')).error, []);
				await peer.taskQueue.awaitIdle();
				const before = structuredClone(peerState.indexStates.map((index) => index.rows));
				for (const [index, rows] of before.entries()) {
					assert.equal(rows.length, 1);
					assert.equal(rows[0][0], oldRows[index][0], 'same index string');
					assert.notDeepEqual(rows[0].slice(1), oldRows[index].slice(1), 'new byte range');
				}
				peerState.broadcastChannel.onmessage = onmessage;
				for (const event of delayed) {
					const applied = nextEvent(peerState);
					onmessage(event);
					await applied;
				}
				assert.deepEqual(
					peerState.indexStates.map((index) => index.rows),
					before
				);
				assert.deepEqual(await peer.findDocumentsById(['001'], false), [current]);
			} finally {
				globalThis.__wcposOnStorageRecovery = previousHook;
				try {
					for (const instance of instances) await instance.close();
				} finally {
					for (const state of states) state.broadcastChannel?.close();
					rmSync(basePath, { recursive: true, force: true });
				}
			}
		}
	);

	test(`[${dist}] stale secondary A at a valid slot broadcasts without duplicating query results`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), 'wcpos-changelog-range-'));
		const instances = [];
		const states = [];
		let channel;
		try {
			const engine = storage.getRxStorageFilesystemNode({ basePath });
			for (const token of ['writer', 'reader']) {
				const instance = await engine.createStorageInstance({
					databaseName: `range-${dist}`,
					collectionName: 'products',
					schema,
					options: {},
					multiInstance: true,
					devMode: false,
					databaseInstanceToken: token,
				});
				instances.push(instance);
				states.push(await instance.internals.statePromise);
			}
			const [writer, reader] = instances;
			const [, state] = states;
			const documents = ['a', 'b', 'c'].map((value, i) => ({
				id: `00${i + 1}`,
				value,
				_deleted: false,
				_rev: `1-range${i}`,
				_meta: { lwt: Date.now() + i },
				_attachments: {},
			}));
			const seeded = nextEvent(state);
			assert.deepEqual(
				(
					await writer.bulkWrite(
						documents.map((document) => ({ document })),
						'seed'
					)
				).error,
				[]
			);
			await seeded;
			const secondary = state.indexStates.find((index) => index.index[0] === 'value');
			const stale = [secondary.indexId, 1, 'A', structuredClone(secondary.rows[1])];
			const current = {
				...documents[1],
				value: 'd',
				_rev: '2-range',
				_meta: { lwt: Date.now() + 10 },
			};
			const updated = nextEvent(state);
			assert.deepEqual(
				(await writer.bulkWrite([{ previous: documents[1], document: current }], 'move')).error,
				[]
			);
			await updated;
			assert.ok(secondary.rows[0][0] < stale[3][0] && stale[3][0] < secondary.rows[1][0]);
			const query = () =>
				reader.query(
					prepareQuery(
						schema,
						normalizeMangoQuery(schema, {
							selector: { _deleted: false },
							sort: [{ value: 'asc' }, { id: 'asc' }],
							index: ['value', 'id'],
						})
					)
				);
			const want = [documents[0], documents[2], current];
			assert.deepEqual((await query()).documents, want);
			const received = states.map(nextEvent);
			channel = new BroadcastChannel(state.broadcastChannel.name);
			channel.postMessage({
				type: 'event',
				eventBulks: [],
				changelogOperations: [stale],
				info: { db: reader.databaseName, col: reader.collectionName },
			});
			await Promise.all(received);
			assert.deepEqual((await query()).documents, want);
			for (const siblingState of states) {
				for (const index of siblingState.indexStates) {
					assert.strictEqual(index.__wcposIndexStates, siblingState.indexStates);
				}
			}
		} finally {
			channel?.close();
			try {
				for (const instance of instances) await instance.close();
			} finally {
				for (const state of states) state.broadcastChannel?.close();
				rmSync(basePath, { recursive: true, force: true });
			}
		}
	});

	test(`[${dist}] real peer broadcast preserves all rows and reads; upstream deletes a neighbour`, async () => {
		const basePath = mkdtempSync(join(tmpdir(), 'wcpos-changelog-identity-'));
		const instances = [];
		const states = [];
		let channel;
		try {
			const engine = storage.getRxStorageFilesystemNode({ basePath });
			for (const token of ['writer', 'reader']) {
				const instance = await engine.createStorageInstance({
					databaseName: `identity-${dist}`,
					collectionName: 'products',
					schema,
					options: {},
					multiInstance: true,
					devMode: false,
					databaseInstanceToken: token,
				});
				instances.push(instance);
				states.push(await instance.internals.statePromise);
			}
			const [writer, reader] = instances;
			const [, state] = states;
			const documents = ['001', '002', '003'].map((id, sequence) => ({
				id,
				value: `value-${id}`,
				_deleted: false,
				_rev: `1-identity${sequence}`,
				_meta: { lwt: Date.now() + sequence },
				_attachments: {},
			}));
			const written = nextEvent(state);
			const result = await writer.bulkWrite(
				documents.map((document) => ({ document })),
				'seed'
			);
			assert.deepEqual(result.error, []);
			await written;
			const ids = documents.map(({ id }) => id);
			assert.deepEqual(await reader.findDocumentsById(ids, false), documents);
			const before = state.indexStates.map((index) =>
				structuredClone({
					rows: index.rows,
					metaIdMap: index.metaIdMap,
				})
			);
			const index = state.firstIdx;
			// A delete for an already-absent id, carrying a real index string
			// generated by premium, not an invented serialization format.
			const dup = [0, 0, 'D', [index.getIndexableString({ ...documents[0], id: '000' }), 0, 1]];
			const positional = stateFor(index.rows);
			upstreamApply(positional, structuredClone(dup));
			assert.deepEqual(positional.rows, before[0].rows.slice(1));
			assert.notDeepEqual(positional.rows, before[0].rows, 'the unpatched algorithm corrupts rows');
			const received = states.map(nextEvent);
			channel = new BroadcastChannel(state.broadcastChannel.name);
			channel.postMessage({
				type: 'event',
				eventBulks: [],
				changelogOperations: [dup],
				info: { db: reader.databaseName, col: reader.collectionName },
			});
			await Promise.all(received);
			assert.deepEqual(
				state.indexStates.map((index) => ({
					rows: index.rows,
					metaIdMap: index.metaIdMap,
				})),
				before
			);
			assert.deepEqual(await reader.findDocumentsById(ids, false), documents);
		} finally {
			channel?.close();
			try {
				for (const instance of instances) await instance.close();
			} finally {
				for (const state of states) state.broadcastChannel?.close();
				rmSync(basePath, { recursive: true, force: true });
			}
		}
	});
}

function withFixture(content, fn) {
	const directory = mkdtempSync(join(tmpdir(), 'wcpos-identity-patch-'));
	const path = join(directory, 'index-state.js');
	writeFileSync(path, content);
	try {
		return fn(path);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const syntheticAnchors = { applyBefore: '__before__', applyAfter: '__after__' };

for (const patch of DISTS.filter((entry) => entry.file === 'helpers.js')) {
	test(`[${patch.dist}/helpers.js] indexes are linked before the boot changelog replays through them`, () => {
		const source = readFileSync(
			join(packageRoot, `dist/${patch.dist}/plugins/storage-abstract-filesystem/helpers.js`),
			'utf8'
		);
		const linked = source.indexOf(
			`${patch.marker}(`,
			source.indexOf(patch.prelude) + patch.prelude.length
		);
		// The call site, not the prelude's definition of the replay function.
		const replayed = source.indexOf('=__wcposReplayChangelog(');
		assert.ok(linked > 0 && replayed > 0, 'both rewrites present');
		assert.ok(linked < replayed, `link at ${linked} must precede replay at ${replayed}`);
	});
}

for (const patch of DISTS) {
	test(`[${patch.dist}/${patch.file}] installed patch is complete and idempotent`, () => {
		const path = join(
			packageRoot,
			`dist/${patch.dist}/plugins/storage-abstract-filesystem/${patch.file}`
		);
		assert.deepEqual(preparePatch(path, patch), { path, status: 'already patched' });
	});
	if (patch.file !== 'helpers.js') continue;
	test(`[${patch.dist}/helpers.js] exact anchor patches and rejects outdated or incomplete preludes`, () => {
		const path = join(
			packageRoot,
			`dist/${patch.dist}/plugins/storage-abstract-filesystem/helpers.js`
		);
		const installed = readFileSync(path, 'utf8');
		const pristine = installed
			.replace(patch.prelude, '')
			.replace(patch.linkAfter, patch.linkBefore);
		withFixture(pristine, (fixture) => {
			const { next, status } = preparePatch(fixture, patch);
			assert.equal(status, 'patched');
			assert.equal(next, installed);
			writeFileSync(fixture, next.replace('return states', 'return []'));
			assert.throws(() => preparePatch(fixture, patch), /outdated prelude/);
			writeFileSync(fixture, next.replace(patch.linkAfter, patch.linkBefore));
			assert.throws(() => preparePatch(fixture, patch), /rewrite link is missing/);
		});
		for (const count of [0, 2]) {
			withFixture(patch.linkBefore.repeat(count), (fixture) => {
				assert.throws(() => preparePatch(fixture, patch), new RegExp(`matched ${count} times`));
			});
		}
	});
}

test('patch preparation rejects when an earlier rewrite removes a later anchor', () => {
	const anchors = {
		applyBefore: '__first__',
		applyAfter: '__after_first__',
		laterBefore: '__first__second__',
		laterAfter: '__after_second__',
	};
	withFixture(anchors.laterBefore, (path) => {
		assert.throws(() => preparePatch(path, anchors), /rewrite later did not apply/);
	});
});

test('a marked file missing a rewrite is corrupt, not "already patched"', () => {
	withFixture(MARKER, (path) => {
		assert.throws(
			() => preparePatch(path, syntheticAnchors),
			/carries the patch marker but rewrite apply is missing/
		);
	});
});

test('a marked file carrying the current prelude and every rewrite reports "already patched"', () => {
	withFixture(syntheticAnchors.applyBefore, (path) => {
		const { next } = preparePatch(path, syntheticAnchors);
		writeFileSync(path, next);
		assert.deepEqual(preparePatch(path, syntheticAnchors), { path, status: 'already patched' });
	});
});

test('preparePatch fails closed on a marker with an outdated prelude', () => {
	withFixture(syntheticAnchors.applyBefore, (path) => {
		const { next } = preparePatch(path, syntheticAnchors);
		// Keep the marker and every rewrite, but change the installed helper.
		writeFileSync(path, next.replace('var rows = indexState.rows;', 'var rows = [];'));
		assert.throws(() => preparePatch(path, syntheticAnchors), {
			message: `${path} carries the patch marker but an outdated prelude — reinstall rxdb-premium so postinstall can re-apply the current patch`,
		});
	});
});

for (const count of [0, 2]) {
	test(`patch preparation rejects an anchor occurring ${count} times`, () => {
		withFixture(syntheticAnchors.applyBefore.repeat(count), (path) => {
			assert.throws(
				() => preparePatch(path, syntheticAnchors),
				new RegExp(`anchor applyBefore matched ${count} times`)
			);
		});
	});
}

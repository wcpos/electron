import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { getPrimaryKeyFromIndexableString } from 'rxdb/plugins/core';

import {
	applyChangelogOperation,
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
		name: 'documented limit: stale D removes a same-string re-add',
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
	for (const primary of [true, false]) {
		const label = `${name}/${primary ? 'primary' : 'secondary'}`;
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

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { DISTS, patchDists, PRELUDE } from './patch-rxdb-premium-sqlite-query-translation.mjs';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('rxdb-premium/package.json'));
const file = (root, dist) => join(root, `dist/${dist}/plugins/storage-sqlite/sqlite-query.js`);
function pristine(dist) {
	let source = readFileSync(file(root, dist.dist), 'utf8');
	// Once installed, reverse only our own exact rewrites to recover the vendor anchors.
	source = source.replace(PRELUDE, '');
	return source.replace(dist.after, dist.before);
}
function fixture(t) {
	const temp = mkdtempSync(join(tmpdir(), 'wcpos-sqlite-translation-'));
	t.after(() => rmSync(temp, { recursive: true, force: true }));
	for (const dist of DISTS) {
		const path = file(temp, dist.dist);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, pristine(dist));
	}
	return temp;
}
test('vendor anchors match exactly once; both dists patch idempotently', (t) => {
	const temp = fixture(t);
	for (const dist of DISTS) {
		assert.equal(pristine(dist).split(dist.before).length - 1, 1);
		assert.equal(pristine(dist).split(dist.importEnd).length - 1, 1);
	}
	patchDists(temp);
	const first = DISTS.map((dist) => readFileSync(file(temp, dist.dist), 'utf8'));
	patchDists(temp);
	assert.deepEqual(
		DISTS.map((dist) => readFileSync(file(temp, dist.dist), 'utf8')),
		first
	);
});
for (const copies of [0, 2])
	test(`validates all dist anchors before any write (${copies} matches)`, (t) => {
		const temp = fixture(t);
		const esmBefore = readFileSync(file(temp, 'esm'), 'utf8');
		const cjs = DISTS.find((dist) => dist.dist === 'cjs');
		writeFileSync(file(temp, 'cjs'), pristine(cjs).replace(cjs.before, cjs.before.repeat(copies)));
		assert.throws(
			() => patchDists(temp),
			new RegExp(`anchor missing.*matched ${copies} times, expected exactly 1`)
		);
		assert.equal(readFileSync(file(temp, 'esm'), 'utf8'), esmBefore);
	});
for (const dist of DISTS)
	test(`${dist.dist} translates literal regex and element selectors directly`, async (t) => {
		const temp = fixture(t);
		patchDists(temp);
		let source = readFileSync(file(temp, dist.dist), 'utf8');
		const modulePath = join(temp, dist.dist === 'esm' ? 'probe.mjs' : 'probe.cjs');
		if (dist.dist === 'esm')
			source = source
				.replace('"rxdb/plugins/core"', JSON.stringify(import.meta.resolve('rxdb/plugins/core')))
				.replace(
					'"./sqlite-helpers.js"',
					JSON.stringify(pathToFileURL(join(dirname(file(root, 'esm')), 'sqlite-helpers.js')).href)
				);
		else
			source = source
				.replace('"rxdb/plugins/core"', JSON.stringify(require.resolve('rxdb/plugins/core')))
				.replace(
					'"./sqlite-helpers.js"',
					JSON.stringify(join(dirname(file(root, 'cjs')), 'sqlite-helpers.js'))
				);
		writeFileSync(modulePath, source);
		const { mangoQuerySelectorToSQL: translate } = await import(pathToFileURL(modulePath).href);
		const schema = { primaryKey: 'uuid', properties: {} };
		const sql = (selector) => {
			const params = [];
			const query = translate(schema, selector, params);
			return { query, params };
		};
		const db = new DatabaseSync(':memory:');
		t.after(() => db.close());
		db.exec('CREATE TABLE probe (id TEXT PRIMARY KEY, data TEXT)');
		for (const [id, value] of [
			['one', { text: 'CO%_*?[BALT', items: [{ key: 'x', value: 7 }], values: [7, 'blue'] }],
			['two', { text: 'co%_*?[balt', items: [{ key: 'x', value: null }], values: [8] }],
			['three', { text: 'aXXb', items: [{ key: 'y', value: 9 }] }],
		])
			db.prepare('INSERT INTO probe VALUES (?,?)').run(id, JSON.stringify(value));
		const ids = (selector) => {
			const { query, params } = sql(selector);
			return db
				.prepare(`SELECT id FROM probe WHERE ${query} ORDER BY id`)
				.all(...params)
				.map((row) => row.id);
		};
		assert.deepEqual(ids({ text: { $regex: 'co%_\\*\\?\\[balt', $options: 'i' } }), ['one', 'two']);
		assert.deepEqual(ids({ text: { $regex: 'co%_\\*\\?\\[balt' } }), ['two']);
		for (const [condition, expected] of [
			[{ $eq: 7 }, ['one']],
			[{ $in: [7, 9] }, ['one', 'three']],
		])
			assert.deepEqual(ids({ items: { $elemMatch: { value: condition } } }), expected);
		assert.deepEqual(
			ids({
				items: {
					$elemMatch: { $and: [{ key: 'x' }, { $or: [{ value: 7 }, { value: { $eq: 9 } }] }] },
				},
			}),
			['one']
		);
		assert.deepEqual(ids({ values: { $elemMatch: { $in: [7] } } }), ['one']);
		assert.deepEqual(ids({ values: { $elemMatch: { $eq: 'blue' } } }), ['one']);
		for (const value of [
			null,
			true,
			{ $eq: null },
			{ $eq: true },
			{ $eq: {} },
			{ $in: [null] },
			{ $in: [true] },
			{ $in: [{}] },
			{ $ne: 7 },
			{ $nin: [7] },
			{ $gt: 7 },
			{ $gte: 7 },
			{ $lt: 9 },
			{ $lte: 7 },
			{ $exists: true },
			{ $regex: 'abc' },
			{ $elemMatch: { $eq: 7 } },
		])
			assert.throws(
				() => sql({ items: { $elemMatch: { value } } }),
				(error) => error.isNonImplementedOperatorError === true
			);
		for (const condition of [
			{ $regex: 'a.*b' },
			{ $regex: '\\d' },
			{ $regex: 3 },
			{ $regex: 'abc', $options: 'm' },
			{ $regex: 'abc', $options: '' },
			{ $elemMatch: { value: { $regex: 'abc' } } },
			{ $elemMatch: { $not: { $eq: 1 } } },
		])
			assert.throws(
				() => sql({ text: condition }),
				(error) => error.isNonImplementedOperatorError === true
			);
		assert.equal(globalThis.WCPOS_SQLITE_QUERY_TRANSLATION_PATCH, 1);
	});

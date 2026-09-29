/** Native literal search and element selectors for every premium SQLite target (#2242).
 * Unsupported shapes retain premium's matcher fallback; query/count themselves are untouched.
 * License-materialized dist is patched after postinstall, with both variants checked first.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const MARKER = 'globalThis.WCPOS_SQLITE_QUERY_TRANSLATION_PATCH=1;';

function wcposLiteralRegex(column, condition, push, placeholder) {
	const fail = () => {
		const error = new Error('operator $regex not implemented');
		error.operator = '$regex';
		error.isNonImplementedOperatorError = true;
		throw error;
	};
	const pattern = condition.$regex;
	const meta = '.*+?^${}()|[]\\-';
	if (
		typeof pattern !== 'string' ||
		Object.keys(condition).some((key) => key !== '$regex' && key !== '$options') ||
		('$options' in condition && condition.$options !== 'i')
	)
		fail();
	for (let index = 0; index < pattern.length; index++) {
		if (pattern[index] === '\\') {
			if (!meta.includes(pattern[++index]) || index >= pattern.length) fail();
		} else if (meta.includes(pattern[index])) fail();
	}
	const literal = pattern.replace(/\\(.)/g, '$1');
	if (condition.$options === 'i') {
		push('%' + literal.replace(/[\\%_]/g, '\\$&') + '%');
		return column + ' LIKE ' + placeholder + " ESCAPE '\\'";
	}
	push('*' + literal.replace(/[*?[]/g, (char) => '[' + char + ']') + '*');
	return column + ' GLOB ' + placeholder;
}

function wcposElementMatch(column, selector, push, placeholder) {
	const fail = () => {
		const error = new Error('operator $elemMatch not implemented');
		error.operator = '$elemMatch';
		error.isNonImplementedOperatorError = true;
		throw error;
	};
	const scalar = (value) => ['string', 'number'].includes(typeof value);
	const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
	const compare = (operator, value, expression, type) => {
		if (operator !== '$eq' && operator !== '$in') fail();
		const values = operator === '$in' ? value : [value];
		if (!Array.isArray(values) || !values.every(scalar)) fail();
		const groups = ['string', 'number'].flatMap((kind) => {
			const operands = values.filter((operand) => typeof operand === kind);
			if (!operands.length) return [];
			operands.forEach(push);
			const guard = type + (kind === 'string' ? " = 'text'" : " IN ('integer','real')");
			const comparison =
				operator === '$eq'
					? expression + ' = ' + placeholder
					: expression + ' IN (' + operands.map(() => placeholder).join(',') + ')';
			return ['(' + guard + ' AND ' + comparison + ')'];
		});
		return '(' + (groups.join(' OR ') || '0') + ')';
	};
	const walk = (condition, expression, type, document) => {
		if (!object(condition)) return compare('$eq', condition, expression, type);
		const clauses = Object.entries(condition).map(([key, value]) => {
			if (key === '$and' || key === '$or') {
				if (!Array.isArray(value) || !value.length || !value.every(object)) fail();
				return (
					'(' +
					value
						.map((part) => walk(part, expression, type, document))
						.join(key === '$and' ? ' AND ' : ' OR ') +
					')'
				);
			}
			if (key.startsWith('$')) return compare(key, value, expression, type);
			if (!document) fail();
			// Mixed arrays must not feed scalar strings to json_extract as JSON text.
			const argumentsSQL =
				"CASE WHEN json_each.type='object' THEN json_each.value END,'$." +
				key.replace(/'/g, "''") +
				"'";
			return (
				"(json_each.type='object' AND " +
				walk(
					value,
					'json_extract(' + argumentsSQL + ')',
					'json_type(' + argumentsSQL + ')',
					false
				) +
				')'
			);
		});
		if (!clauses.length) fail();
		return '(' + clauses.join(' AND ') + ')';
	};
	if (!object(selector)) fail();
	return (
		'EXISTS (SELECT 1 FROM json_each(' +
		column +
		') WHERE ' +
		walk(selector, 'json_each.value', 'json_each.type', true) +
		')'
	);
}

export const PRELUDE =
	MARKER + wcposLiteralRegex.toString() + ';' + wcposElementMatch.toString() + ';';
export const DISTS = [
	{
		dist: 'esm',
		importEnd: 'from"./sqlite-helpers.js";',
		before: 'if(!r.startsWith("$"))return o(s)?',
		field: 'r',
		condition: 's',
		plain: 'o(s)',
		column: 'n(f,r)',
		push: 'value=>i(c,value)',
		placeholder: 'a',
	},
	{
		dist: 'cjs',
		importEnd: 'r=["$or","$and"];',
		before: 'if(!s.startsWith("$"))return(0,e.isPlainObject)(l)?',
		field: 's',
		condition: 'l',
		plain: '(0,e.isPlainObject)(l)',
		column: '(0,e.getJsonExtract)(E,s)',
		push: 'value=>n(c,value)',
		placeholder: 'e.PARAM_KEY',
	},
].map((dist) => ({
	...dist,
	after:
		`if(!${dist.field}.startsWith("$")&&${dist.plain}){` +
		`if(Object.hasOwn(${dist.condition},"$regex"))return wcposLiteralRegex(${dist.column},${dist.condition},${dist.push},${dist.placeholder});` +
		`if(Object.hasOwn(${dist.condition},"$elemMatch")&&Object.keys(${dist.condition}).length===1)return wcposElementMatch(${dist.column},${dist.condition}.$elemMatch,${dist.push},${dist.placeholder});}` +
		dist.before,
}));

export function preparePatch(path, dist) {
	const source = readFileSync(path, 'utf8');
	const exact = (anchor, label) => {
		const count = source.split(anchor).length - 1;
		if (count !== 1)
			throw new Error(
				`anchor missing ${label} in ${path}: matched ${count} times, expected exactly 1 — rxdb-premium changed; re-derive the SQLite translation patch`
			);
	};
	if (source.includes(MARKER)) {
		exact(PRELUDE, 'prelude');
		exact(dist.after, 'translation');
		return { path, status: 'already patched' };
	}
	exact(dist.before, 'translation');
	exact(dist.importEnd, 'imports');
	return {
		path,
		status: 'patched',
		next: source
			.replace(dist.importEnd, () => dist.importEnd + PRELUDE)
			.replace(dist.before, () => dist.after),
	};
}

export function patchDists(packageRoot) {
	const prepared = DISTS.map((dist) =>
		preparePatch(
			join(packageRoot, `dist/${dist.dist}/plugins/storage-sqlite/sqlite-query.js`),
			dist
		)
	);
	for (const { path, next } of prepared) if (next !== undefined) writeFileSync(path, next);
	return prepared;
}

if (
	process.argv[1] &&
	realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
	const results = patchDists(dirname(require.resolve('rxdb-premium/package.json')));
	console.log(
		`[patch-rxdb-premium-sqlite-query-translation] ${results.map(({ status }, index) => `${DISTS[index].dist}: ${status}`).join(', ')}`
	);
}

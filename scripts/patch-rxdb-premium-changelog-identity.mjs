/**
 * Apply peer changelog ops by index-string identity when positions have drifted.
 * Positional deletes otherwise remove healthy neighbours; write-shaped deletes
 * carry the OLD string with the NEW byte range, so bytes cannot identify a D.
 *
 * Why not `pnpm patch`: rxdb-premium's dist/ is materialized by its own
 * license-gated postinstall, so it does not exist in the tarball pnpm patches.
 * This repo postinstall patch is idempotent and fails the install if an anchor
 * moves, so it must be re-derived against the identity tests on an upgrade.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const MARKER = '__wcposApplyChangelogOperation';

// ES5-safe: this exact function's source is prepended to both installed dists
// (see PRELUDE), so it must stay `var`-only with no modern syntax.
/* eslint-disable no-var */
export function applyChangelogOperation(indexState, op, primaryKeyFromIndexableString) {
	var rows = indexState.rows;
	var map = indexState.metaIdMap;
	var row = op[3];
	var pos = op[1];
	var key = primaryKeyFromIndexableString(row[0], indexState.primaryKeyLength);
	var siblings = indexState.__wcposIndexStates;
	// Emitters apply index 0 first; secondary rows must describe its current bytes.
	if (!map && siblings && (op[2] === 'A' || op[2] === 'R')) {
		var primary = siblings[0];
		var current = primary && primary.metaIdMap && primary.metaIdMap.get(key);
		if (!current || current[1] !== row[1] || current[2] !== row[2]) return;
	}
	function sameRow(a, b) {
		return a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
	}
	function lowerBound(rows, s) {
		var low = 0;
		var high = rows.length;
		while (low < high) {
			var mid = Math.floor((low + high) / 2);
			if (rows[mid][0] < s) low = mid + 1;
			else high = mid;
		}
		return low;
	}
	function findByString(rows, s) {
		var at = lowerBound(rows, s);
		return rows[at] && rows[at][0] === s ? at : -1;
	}
	function hasDifferentString() {
		var existing = map && map.get(key);
		// Unlinked states retain the secondary scan on anomalous fallback inserts.
		if (!map && !siblings) {
			for (var i = 0; i < rows.length; i++) {
				if (primaryKeyFromIndexableString(rows[i][0], indexState.primaryKeyLength) === key) {
					existing = rows[i];
					break;
				}
			}
		}
		return existing && existing[0] !== row[0];
	}
	var at;
	if (op[2] === 'A') {
		if (sameRow(rows[pos], row)) return;
		var validPosition =
			pos >= 0 &&
			pos <= rows.length &&
			(pos === 0 || rows[pos - 1][0] < row[0]) &&
			(pos === rows.length || row[0] <= rows[pos][0]);
		at = validPosition ? pos : lowerBound(rows, row[0]);
		if (rows[at] && rows[at][0] === row[0]) rows[at] = row;
		else {
			if (!validPosition && hasDifferentString()) return;
			rows.splice(at, 0, row);
		}
		if (map) map.set(key, row);
	} else if (op[2] === 'D' || op[2] === 'R') {
		at = rows[pos] && rows[pos][0] === row[0] ? pos : findByString(rows, row[0]);
		if (op[2] === 'D') {
			if (at < 0) return;
			var removed = rows[at];
			rows.splice(at, 1);
			if (map && (map.get(key) === removed || sameRow(map.get(key), removed))) map.delete(key);
		} else {
			if (at >= 0) rows[at] = row;
			else {
				if (hasDifferentString()) return;
				rows.splice(lowerBound(rows, row[0]), 0, row);
			}
			if (map) map.set(key, row);
		}
	} else {
		throw new Error('unknown operation key ' + op[2]);
	}
}
/* eslint-enable no-var */

const PRELUDE = `globalThis.WCPOS_CHANGELOG_IDENTITY_PATCH=1;\n${applyChangelogOperation
	.toString()
	.replace('function applyChangelogOperation(', `function ${MARKER}(`)}\n`;
const LINK_MARKER = '__wcposLinkIndexStates';
const LINK_PRELUDE = `globalThis.WCPOS_CHANGELOG_INDEX_STATES_PATCH=1;
function ${LINK_MARKER}(states){
for(var i=0;i<states.length;i++)states[i].__wcposIndexStates=states;
return states
}
`;

// Byte-exact per-dist literals: keep everything outside these rewrites untouched.
export const DISTS = [
	{
		dist: 'esm',
		file: 'index-state.js',
		applyBefore:
			'runChangelogOperation=function(t){var e=t[1],i=t[3];if("A"===t[2])this.rows.splice(e,0,i),this.metaIdMap&&this.metaIdMap.set(s(i[0],this.primaryKeyLength),i);else if("D"===t[2])this.rows.splice(e,1),this.metaIdMap&&this.metaIdMap.delete(s(i[0],this.primaryKeyLength));else{if("R"!==t[2])throw new Error("unknown operation key "+t[2]);this.rows[e]=i,this.metaIdMap&&this.metaIdMap.set(s(i[0],this.primaryKeyLength),i)}}',
		applyAfter: `runChangelogOperation=function(t){return ${MARKER}(this,t,s)}`,
	},
	{
		dist: 'cjs',
		file: 'index-state.js',
		applyBefore:
			'runChangelogOperation=function(t){var r=t[1],i=t[3];if("A"===t[2])this.rows.splice(r,0,i),this.metaIdMap&&this.metaIdMap.set((0,e.getPrimaryKeyFromIndexableString)(i[0],this.primaryKeyLength),i);else if("D"===t[2])this.rows.splice(r,1),this.metaIdMap&&this.metaIdMap.delete((0,e.getPrimaryKeyFromIndexableString)(i[0],this.primaryKeyLength));else{if("R"!==t[2])throw new Error("unknown operation key "+t[2]);this.rows[r]=i,this.metaIdMap&&this.metaIdMap.set((0,e.getPrimaryKeyFromIndexableString)(i[0],this.primaryKeyLength),i)}}',
		applyAfter: `runChangelogOperation=function(t){return ${MARKER}(this,t,function(a,b){return (0,e.getPrimaryKeyFromIndexableString)(a,b)})}`,
	},
	...['esm', 'cjs'].map((dist) => {
		const states = dist === 'esm' ? 'y' : 'h';
		return {
			dist,
			file: 'helpers.js',
			marker: LINK_MARKER,
			prelude: LINK_PRELUDE,
			linkBefore: `indexStates:${states},firstIdx:${states}[0]`,
			linkAfter: `indexStates:${LINK_MARKER}(${states}),firstIdx:${states}[0]`,
		};
	}),
];

// Validate every dist before writing any, as in the task-queue patcher.
export function preparePatch(path, anchors) {
	const source = readFileSync(path, 'utf8');
	const { marker = MARKER, prelude = PRELUDE } = anchors;
	const keys = Object.keys(anchors)
		.filter((key) => key.endsWith('Before'))
		.map((key) => key.slice(0, -6));
	if (source.includes(marker)) {
		for (const key of keys) {
			if (!source.includes(anchors[`${key}After`])) {
				throw new Error(
					`${path} carries the patch marker but rewrite ${key} is missing — ` +
						'the patched file is incomplete; reinstall rxdb-premium to restore a pristine dist'
				);
			}
		}
		if (!source.includes(prelude)) {
			throw new Error(
				`${path} carries the patch marker but an outdated prelude — reinstall rxdb-premium so postinstall can re-apply the current patch`
			);
		}
		return { path, status: 'already patched' };
	}
	for (const key of keys) {
		const occurrences = source.split(anchors[`${key}Before`]).length - 1;
		if (occurrences !== 1) {
			throw new Error(
				`anchor ${key}Before matched ${occurrences} times in ${path} (expected exactly 1) — ` +
					'rxdb-premium changed; re-derive this patch against the identity test'
			);
		}
	}
	let next = prelude + source;
	for (const key of keys) {
		next = next.replace(anchors[`${key}Before`], anchors[`${key}After`]);
	}
	for (const key of keys) {
		if (!next.includes(anchors[`${key}After`])) {
			throw new Error(
				`rewrite ${key} did not apply in ${path} — re-derive this patch against the identity test`
			);
		}
	}
	return { path, next, status: 'patched' };
}

function commitPatches(prepared) {
	for (const { path, next } of prepared) {
		if (next === undefined) continue;
		const temporaryPath = `${path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, next);
		renameSync(temporaryPath, path);
	}
}

function main() {
	const packageRoot = dirname(require.resolve('rxdb-premium/package.json'));
	const prepared = DISTS.map(({ dist, file, ...anchors }) => {
		const path = join(packageRoot, `dist/${dist}/plugins/storage-abstract-filesystem/${file}`);
		if (!existsSync(path)) {
			throw new Error(`rxdb-premium ${dist} dist not found — run after the package postinstall`);
		}
		return { dist, file, ...preparePatch(path, anchors) };
	});
	commitPatches(prepared);
	console.log(
		`[patch-rxdb-premium-changelog-identity] ${prepared
			.map(({ dist, file, status }) => `${dist}/${file}: ${status}`)
			.join(', ')}`
	);
}

// Importing the test seam must not patch node_modules.
if (
	process.argv[1] &&
	realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
	main();
}

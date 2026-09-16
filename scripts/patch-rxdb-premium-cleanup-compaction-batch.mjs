/**
 * Batches filesystem document moves and bakes their indexes in the same cleanup
 * round. Keep the replay-safety patch's original functions intact for re-runs.
 *
 * Why: RxDB's cleanup plugin re-calls `storage.cleanup()` immediately whenever it
 * returns false, and premium's compaction moved at most 50 documents per call,
 * broadcast after every move (a `promiseWait(0)` Chrome clamps to 4 ms) and left
 * the index rewrite to the NEXT call. On a documents file with N gaps that is
 * N/50 rounds of "move 50, then rewrite every index file in full" — measured on
 * a live web POS as 170 cleanup rounds in 22 s alternating exactly 0,50,0,50
 * moves, an idle tab pinned above 30% CPU in `persistInMemoryRows`.
 * The batched loop below is the same per-move code; only the cap, the broadcast
 * timing and the bake timing change.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const MARKER = 'WCPOS_CLEANUP_COMPACTION_BATCH_PATCH';
// Bump on prelude/rewrite changes; older patched dists must be restored first.
export const PATCH_VERSION = 1;
const MARKER_PRELUDE = `globalThis.${MARKER}=${PATCH_VERSION};\n`;
const COMPACTION_PRELUDE = `${MARKER_PRELUDE}
// A move costs ~0.3 ms of worker CPU. The task queue holds the cross-tab lock for
// the whole call, making UI reads wait; 250 ms bounds that stall. 1000 documents
// keeps one batched broadcast/changelog batch around a megabyte. Seam: tests only.
const COMPACTION_BATCH_DOCUMENTS=1000,COMPACTION_BATCH_MS=250;
function __wcposCompactionBatch(){var seam=globalThis.__wcposCompactionBatch;return{documents:seam&&seam.documents||COMPACTION_BATCH_DOCUMENTS,ms:seam&&seam.ms||COMPACTION_BATCH_MS}}
// Peers learn new positions only from the broadcast, and the cross-tab lock is
// released when this call ends however it ends. Every op already appended to the
// changelog must therefore reach them even when a later move throws, or they keep
// reading bytes that a later move overwrote — hence the flush in \`finally\`.
async function __wcposCompactDocumentsBatched(storageInstance,runState,deps){
var a=storageInstance,t=runState,e=deps.ensureNotFalsy,o=deps.getAccessHandle,p=deps.getDocumentsJson,r=await a.internals.statePromise,pending=[];
try{for(var n=e(r.indexStates.find((e=>"_meta.lwt"===e.index[0]&&e.index[1]===a.primaryPath&&2===e.index.length))),i=await o(r.documentFileHandle,t),s=await i.getSize(),budget=__wcposCompactionBatch(),started=Date.now(),g=0,d=0,m=0;;){if(d>=budget.documents||d>0&&Date.now()-started>=budget.ms)return d;
var u=n.rows[m];if(m+=1,!u){if(g<s)await i.truncate(g);return d;}
var w=u[1],h=u[2];if(w===g)g=h;else{d+=1;var f=(await p(r,i,t,[u]))[0],v=g,x=w-v,D,C,E=a._encode(JSON.stringify(f));if(x>=E.byteLength){D=await i.getWritable(),await D.write(E,{at:v}),C=E.byteLength}else{var y=a._encode(" ".repeat(x));D=await i.getWritable();await D.write(y,{at:v});var P=[];for(var S of r.indexStates){var O=S.changeDocumentPosition(f,[v,h]);P.push(O)}await r.changelog.addChangelogOperations(t,P),pending.push(...P);C=h-w;var b=JSON.stringify(f)+" ".repeat(x),j=a._encode(b);D=await i.getWritable(),await D.write(j,{at:v})}var F=v+C,I=[];for(var J of r.indexStates){var _=J.changeDocumentPosition(f,[v,F]);I.push(_)}await r.changelog.addChangelogOperations(t,I),pending.push(...I),g+=C}}}finally{if(pending.length>0)await deps.broadcast(a,r,pending)}}
`;

const DISTS = [
	{
		dist: 'esm',
		files: [
			{
				file: 'cleanup.js',
				prelude: COMPACTION_PRELUDE,
				rewrites: [
					{
						name: 'batchedCleanup',
						before:
							'export async function cleanup(a,e,t){return!((await cleanupDeletedDocuments(a,e,t)).length>0)&&(!((await cleanupChangelogOperations(a,e)).length>0)&&(!(await cleanupDocumentJsonFile(a,e)>0)||(a.devMode&&await m(a,e),!1)))}',
						after:
							'export async function cleanup(storageInstance,runState,minimumDeletedTime){if((await cleanupDeletedDocuments(storageInstance,runState,minimumDeletedTime)).length>0)return false;if((await cleanupChangelogOperations(storageInstance,runState)).length>0)return false;var moved=await __wcposCompactDocumentsBatched(storageInstance,runState,{ensureNotFalsy:e,getAccessHandle:o,getDocumentsJson:p,broadcast:c});if(moved>0){if(storageInstance.devMode)await m(storageInstance,runState);await cleanupChangelogOperations(storageInstance,runState);return false}return true}',
					},
				],
			},
		],
	},
	{
		dist: 'cjs',
		files: [
			{
				file: 'cleanup.js',
				prelude: COMPACTION_PRELUDE,
				rewrites: [
					{
						name: 'batchedCleanup',
						before:
							'async function o(e,a,t){return!((await s(e,a,t)).length>0)&&(!((await g(e,a)).length>0)&&(!(await d(e,a)>0)||(e.devMode&&await(0,n.debug_checkIfAllDocsCanBeRead)(e,a),!1)))}',
						after:
							'async function o(storageInstance,runState,minimumDeletedTime){if((await s(storageInstance,runState,minimumDeletedTime)).length>0)return false;if((await g(storageInstance,runState)).length>0)return false;var moved=await __wcposCompactDocumentsBatched(storageInstance,runState,{ensureNotFalsy:e.ensureNotFalsy,getAccessHandle:a.getAccessHandle,getDocumentsJson:r.getDocumentsJson,broadcast:n.broadcastChangelogOperations});if(moved>0){if(storageInstance.devMode)await (0,n.debug_checkIfAllDocsCanBeRead)(storageInstance,runState);await g(storageInstance,runState);return false}return true}',
					},
				],
			},
		],
	},
];

export function preparePatch(path, patch) {
	const source = readFileSync(path, 'utf8');
	const applied = source.match(new RegExp(`${MARKER}=(\\d+)`));
	if (applied && Number(applied[1]) !== PATCH_VERSION) {
		throw new Error(
			`${path} carries patch v${applied[1]} but this script is v${PATCH_VERSION}: restore the pristine dist (pnpm rebuild rxdb-premium, needs RXDB_PREMIUM) and re-run the rxdb-premium patch scripts (postinstall)`
		);
	}
	if (applied) {
		for (const rewrite of patch.rewrites) {
			if (!source.includes(rewrite.after)) {
				throw new Error(`${path} carries the patch marker but rewrite ${rewrite.name} is missing`);
			}
		}
		return { path, status: 'already patched' };
	}
	for (const rewrite of patch.rewrites) {
		const occurrences = source.split(rewrite.before).length - 1;
		if (occurrences !== 1) {
			throw new Error(
				`anchor ${rewrite.name} matched ${occurrences} times in ${path} (expected exactly 1)`
			);
		}
	}
	let next = patch.prelude + source;
	for (const rewrite of patch.rewrites) next = next.replace(rewrite.before, rewrite.after);
	for (const rewrite of patch.rewrites) {
		if (!next.includes(rewrite.after))
			throw new Error(`rewrite ${rewrite.name} did not apply in ${path}`);
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
	const prepared = [];
	for (const { dist, files } of DISTS) {
		for (const patch of files) {
			const path = join(
				packageRoot,
				`dist/${dist}/plugins/storage-abstract-filesystem/${patch.file}`
			);
			if (!existsSync(path)) {
				throw new Error(
					`rxdb-premium ${dist}/${patch.file} not found — run after package postinstall`
				);
			}
			prepared.push({ dist, file: patch.file, ...preparePatch(path, patch) });
		}
	}
	commitPatches(prepared);
	console.log(
		`[patch-rxdb-premium-cleanup-compaction-batch] ${prepared
			.map(({ dist, file, status }) => `${dist}/${file}: ${status}`)
			.join(', ')}`
	);
}

if (
	process.argv[1] &&
	realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
	main();
}

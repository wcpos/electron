/**
 * Makes rxdb-premium abstract-filesystem changelog compaction crash-safe and
 * rebuilds derived index files from documents.json when boot finds corruption.
 * The licensed package materializes dist/ at postinstall, so literal anchors
 * are intentionally re-derived and fail closed when rxdb-premium changes.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const MARKER = 'WCPOS_CHANGELOG_REPLAY_SAFETY_PATCH';

const MARKER_PRELUDE = `globalThis.${MARKER}=1;\n`;
const HASH_PRELUDE = `${MARKER_PRELUDE}function __wcposHash(raw){
var h1=3735928559,h2=1103547991;
for(var i=0;i<raw.length;i++){var code=raw.charCodeAt(i);h1=Math.imul(h1^code,2654435761);h2=Math.imul(h2^code,1597334677)}
h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
return 4294967296*(2097151&h2)+(h1>>>0)+":"+raw.length
}
`;

function helpersPrelude(stampAccessExpression) {
	return `${HASH_PRELUDE}function __wcposValidateRows(indexStates,primaryKeyLength){
var expected=null;
for(var index=0;index<indexStates.length;index++){
var rows=indexStates[index].rows;
if(!Array.isArray(rows))return "not-array:index-"+index;
if(expected===null)expected=rows.length;else if(rows.length!==expected)return "length-mismatch";
for(var rowIndex=0;rowIndex<rows.length;rowIndex++){
var row=rows[rowIndex];
if(!Array.isArray(row))return "hole:index-"+index;
if(typeof row[0]!=="string"||!Number.isInteger(row[1])||!Number.isInteger(row[2])||row[1]>row[2])return "invalid-row:index-"+index;
if(rowIndex>0&&rows[rowIndex-1][0]>row[0])return "unsorted:index-"+index
}
}
var primaryRows=indexStates[0].rows,ids=new Set;
for(var primaryIndex=0;primaryIndex<primaryRows.length;primaryIndex++){
var id=primaryRows[primaryIndex][0].slice(-primaryKeyLength);
if(ids.has(id))return "duplicate-primary";
ids.add(id)
}
return null
}
async function __wcposRebuildIndexes(options){
var reason=options.reason,runState=options.runState,docsAccessHandle=options.docsAccessHandle,indexStates=options.indexStates,changelog=options.changelog,stampHandle=options.stampHandle,decode=options.decode,primaryPath=options.primaryPath,databaseName=options.databaseName,collectionName=options.collectionName;
var kept;
try{
var bytes=await docsAccessHandle.read(0),latest=new Map;
for(var cursor=0;cursor<bytes.length;){
if(bytes[cursor]!==123){cursor++;continue}
var start=cursor,depth=0,inString=false,escaped=false,end=-1;
for(var at=start;at<bytes.length;at++){
var byte=bytes[at];
if(inString){if(escaped)escaped=false;else if(byte===92)escaped=true;else if(byte===34)inString=false}
else if(byte===34)inString=true;else if(byte===123)depth++;else if(byte===125){depth--;if(depth===0){end=at+1;break}}
}
if(end<0){cursor=start+1;continue}
try{
var doc=JSON.parse(decode(bytes.subarray(start,end)));
if(!doc||typeof doc!=="object"||!Object.prototype.hasOwnProperty.call(doc,primaryPath)){cursor=start+1;continue}
var revision=parseInt(doc._rev,10);if(Number.isNaN(revision))revision=-1;
var previous=latest.get(doc[primaryPath]);
if(!previous||revision>previous.revision||revision===previous.revision&&start>previous.start)latest.set(doc[primaryPath],{doc:doc,start:start,end:end,revision:revision});
cursor=end
}catch(error){cursor=start+1}
}
kept=Array.from(latest.values());
for(var indexState of indexStates)indexState.rows=kept.map(function(record){return[indexState.getIndexableString(record.doc),record.start,record.end]}).sort(function(left,right){return left[0]<right[0]?-1:1});
for(var persistIndex of indexStates)await persistIndex.persistInMemoryRows(runState);
for(var readIndex of indexStates)await readIndex.initRead(runState);
await changelog.empty(runState);
var stampAccess=await ${stampAccessExpression};
await stampAccess.truncate(0);
}catch(rebuildError){try{rebuildError.message="index rebuild failed ("+reason+"): "+rebuildError.message}catch(ignored){}throw rebuildError}
var report={db:databaseName,col:collectionName,reason:reason,documents:kept.length};
console.warn("[wcpos] rebuilt storage indexes from documents.json",report);
if(typeof globalThis.__wcposOnIndexRebuild==="function")globalThis.__wcposOnIndexRebuild({target:databaseName+"/"+collectionName,reason:reason,documents:kept.length})
}
`;
}

const DISTS = [
	{
		dist: 'esm',
		files: [
			{
				file: 'changelog.js',
				prelude: MARKER_PRELUDE,
				rewrites: [
					{
						name: 'rememberRaw',
						before: 'n=await i.read(0),o=a.storageInstance._decode(n),r=new Map',
						after:
							'n=await i.read(0),o=a.storageInstance._decode(n);this.__wcposLastRaw=o;var r=new Map',
					},
				],
			},
			{
				file: 'cleanup.js',
				prelude: HASH_PRELUDE,
				rewrites: [
					{
						name: 'stampBeforeBake',
						before:
							'export async function cleanupChangelogOperations(a,e){var t=await a.internals.statePromise,r=await t.changelog.getChangelogOperations(e),n=t.indexStates.filter((a=>{var e=r.get(a.indexId);return!(!e||0===e.length)}));for(var i of n)await i.persistInMemoryRows(e);return n.length>0&&await t.changelog.empty(e),n}',
						after:
							'export async function cleanupChangelogOperations(a,e){var t=await a.internals.statePromise,r=await t.changelog.getChangelogOperations(e),n=t.indexStates.filter((a=>{var e=r.get(a.indexId);return!(!e||0===e.length)}));if(n.length>0){var h=await(await t.dirHandle).getFileHandle("wcpos-changelog-baked.txt",{create:!0}),f=await o(h,e),v=await f.getWritable(),x=e.storageInstance._encode(__wcposHash(t.changelog.__wcposLastRaw));await v.write(x,{at:0}),await f.truncate(x.byteLength);for(var i of n)await i.persistInMemoryRows(e);await t.changelog.empty(e),await f.truncate(0)}return n}',
					},
				],
			},
			{
				file: 'helpers.js',
				prelude: helpersPrelude('r(stampHandle,runState)'),
				rewrites: [
					{
						name: 'validateBoot',
						before:
							'if(await b.getSize()>0){var[,S]=await Promise.all([Promise.all(y.map((e=>e.initRead(n)))),v.getChangelogOperations(n)]);Array.from(S.entries()).map((([e,a])=>{var t=y[e];a.forEach((e=>t.runChangelogOperation(e)))}))}',
						after:
							'if(await b.getSize()>0){var E=await(await u).getFileHandle("wcpos-changelog-baked.txt",{create:!0}),R=await r(E,n),reason=null;try{await Promise.all(y.map((e=>e.initRead(n))));var S=await v.getChangelogOperations(n),stamp=n.storageInstance._decode(await R.read(0));if(""!==stamp&&stamp===__wcposHash(v.__wcposLastRaw))reason="stale-changelog-after-compaction";else Array.from(S.entries()).map((([e,a])=>{var t=y[e];a.forEach((e=>t.runChangelogOperation(e)))}));if(!reason)reason=__wcposValidateRows(y,x)}catch(error){reason="boot-failed:"+(error&&error.message)}if(reason!==null)await __wcposRebuildIndexes({reason:reason,runState:n,docsAccessHandle:b,indexStates:y,changelog:v,stampHandle:E,decode:n.storageInstance._decode.bind(n.storageInstance),primaryPath:g,databaseName:d.databaseName,collectionName:d.collectionName})}',
					},
				],
			},
		],
	},
	{
		dist: 'cjs',
		files: [
			{
				file: 'changelog.js',
				prelude: MARKER_PRELUDE,
				rewrites: [
					{
						name: 'rememberRaw',
						before: 'n=await i.read(0),s=t.storageInstance._decode(n),o=new Map',
						after:
							'n=await i.read(0),s=t.storageInstance._decode(n);this.__wcposLastRaw=s;var o=new Map',
					},
				],
			},
			{
				file: 'cleanup.js',
				prelude: HASH_PRELUDE,
				rewrites: [
					{
						name: 'stampBeforeBake',
						before:
							'async function g(e,a){var t=await e.internals.statePromise,r=await t.changelog.getChangelogOperations(a),n=t.indexStates.filter((e=>{var a=r.get(e.indexId);return!(!a||0===a.length)}));for(var i of n)await i.persistInMemoryRows(a);return n.length>0&&await t.changelog.empty(a),n}',
						after:
							'async function g(e,t){var r=await e.internals.statePromise,n=await r.changelog.getChangelogOperations(t),i=r.indexStates.filter((e=>{var a=n.get(e.indexId);return!(!a||0===a.length)}));if(i.length>0){var o=await(await r.dirHandle).getFileHandle("wcpos-changelog-baked.txt",{create:!0}),s=await(0,a.getAccessHandle)(o,t),g=await s.getWritable(),l=t.storageInstance._encode(__wcposHash(r.changelog.__wcposLastRaw));await g.write(l,{at:0}),await s.truncate(l.byteLength);for(var h of i)await h.persistInMemoryRows(t);await r.changelog.empty(t),await s.truncate(0)}return i}',
					},
				],
			},
			{
				file: 'helpers.js',
				prelude: helpersPrelude('(0,a.getAccessHandle)(stampHandle,runState)'),
				rewrites: [
					{
						name: 'validateBoot',
						before:
							'if(await y.getSize()>0){var[,w]=await Promise.all([Promise.all(h.map((e=>e.initRead(o)))),x.getChangelogOperations(o)]);Array.from(w.entries()).map((([e,a])=>{var t=h[e];a.forEach((e=>t.runChangelogOperation(e)))}))}',
						after:
							'if(await y.getSize()>0){var E=await(await m).getFileHandle("wcpos-changelog-baked.txt",{create:!0}),R=await(0,a.getAccessHandle)(E,o),reason=null;try{await Promise.all(h.map((e=>e.initRead(o))));var w=await x.getChangelogOperations(o),stamp=o.storageInstance._decode(await R.read(0));if(""!==stamp&&stamp===__wcposHash(x.__wcposLastRaw))reason="stale-changelog-after-compaction";else Array.from(w.entries()).map((([e,a])=>{var t=h[e];a.forEach((e=>t.runChangelogOperation(e)))}));if(!reason)reason=__wcposValidateRows(h,f)}catch(error){reason="boot-failed:"+(error&&error.message)}if(reason!==null)await __wcposRebuildIndexes({reason:reason,runState:o,docsAccessHandle:y,indexStates:h,changelog:x,stampHandle:E,decode:o.storageInstance._decode.bind(o.storageInstance),primaryPath:g,databaseName:i.databaseName,collectionName:i.collectionName})}',
					},
				],
			},
		],
	},
];

export function preparePatch(path, patch) {
	const source = readFileSync(path, 'utf8');
	if (source.includes(`${MARKER}=1`)) {
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
		`[patch-rxdb-premium-changelog-replay-safety] ${prepared
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

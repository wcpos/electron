/**
 * Makes rxdb-premium's abstract-filesystem changes file (`changes.json`, the
 * per-run write-ahead log) crash-safe in both directions.
 *
 * `bulkWrite` appends every non-direct event bulk (anything with a `previous`,
 * more than DIRECT_WRITE_LIMIT rows, or attachments) to `changes.json` before
 * resolving, and `processChangesFileIfRequired` — the hook that opens EVERY
 * read, write and cleanup run — folds the in-memory copy into documents.json
 * and truncates the file. On a clean run the file is only ever read back after
 * a crash. Two upstream defects meet there:
 *
 *   1. The writer reads `runState.knownChangesFileSize` to decide the offset
 *      and separator of each append, but nothing ever assigns it. Every bulk
 *      in a run is written at offset 0 with no separator, so the second bulk
 *      of a run overwrites the head of a longer first one. A crash mid-run
 *      then leaves `{bulk N}` followed by the tail of bulk N-1.
 *   2. The reader is a bare `JSON.parse("[" + file + "]")`. On that residue
 *      it throws `Expected ',' or ']' after array element in JSON at position
 *      <len(bulk N)+1>` — Sentry WOOCOMMERCE-POS-2GA, one install per file
 *      offset, on every boot: the parse fails before the truncate, so the file
 *      is never cleared, and because it fails inside the run's lock callback
 *      the run's callers never settle either.
 *
 * Three anchored rewrites per dist:
 *
 *   - `trackAppend`: advance `knownChangesFileSize` after each append, so bulks
 *     accumulate as `{...},{...}` — the shape the reader already expects — and
 *     a crash replays every acknowledged bulk instead of only the last one.
 *     Upstream also pushes the very string it writes onto `changes$`, comma
 *     included once the offset is non-zero — dead code while the offset was
 *     never set, a change-stream parse failure the moment it is — so the
 *     rewrite emits the bare bulk and writes the separated one.
 *   - `resetAfterReplay`: zero it after the reader truncates the file.
 *   - `readChanges`: parse through `__wcposReadChangesFile`, which validates
 *     every bulk against what the replay dereferences (`documentData` keyed
 *     by the event's id, `_deleted`, `_meta.lwt`; the same shape on
 *     `previousDocumentData` when an event carries one; and, when the schema
 *     has attachments, the `_attachments` maps with their string digests that
 *     `clearDeletedAttachments` walks before the truncate) and on a parse or
 *     validation failure keeps every complete leading event bulk (string- and
 *     nesting-aware scan, each candidate re-validated), copies the raw bytes
 *     to `wcpos-changes-quarantine.json` for support, reports through
 *     `globalThis.__wcposOnStorageRecovery` (console fallback) as
 *     `changes-file-salvage` or — when nothing survives, or the file is over
 *     MAX_SALVAGE_BYTES and is cleared unscanned — `changes-file-discarded`,
 *     and truncates the file when nothing is salvageable so the next run
 *     starts clean.
 *   - `getAccessHandleBinding`: a no-op anchor on the `task-queue.js` import
 *     binding the prelude's quarantine code calls, so a renamed binding fails
 *     the install instead of silently disabling the quarantine inside its
 *     try/catch.
 *
 * Scope: the replay of a previous run's residue happens in the hook, which the
 * task queue runs before every READ and CLEANUP run but skips ahead of a small
 * WRITE task touching nothing yet touched in its run. Through the targeted
 * recovery wrapper a fresh instance's first write is always preceded by its
 * own preflight read, so the residue is replayed before any append; a caller
 * that writes into a raw instance first still overwrites it — upstream's
 * ordering, unchanged here, pinned by the wrapper's boot tests.
 *
 * Same vehicle as the sibling patches: rxdb-premium's dist/ is materialized by
 * its license-gated postinstall, so `pnpm patch` cannot reach it; the anchors
 * are exact minified literals per dist and the install FAILS if one stops
 * matching, so a new rxdb-premium version re-derives (or retires) this patch
 * instead of silently losing it. Verified against the installed package by
 * `scripts/rxdb-premium-changes-file-salvage.test.mjs`.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const MARKER = 'WCPOS_CHANGES_FILE_SALVAGE_PATCH';
export const QUARANTINE_FILE = 'wcpos-changes-quarantine.json';
/**
 * A file above this size is cleared before it is even decoded: the hook runs
 * before every read, write and cleanup until the file parses, and a storage
 * file has already been seen at V8's 512 MB string limit in the field (Sentry
 * WOOCOMMERCE-POS-2HD — the decode itself is what dies there). The file is
 * truncated at the end of every run, so 32 MB is orders of magnitude above
 * any real run's worth of event bulks; a file that size is damage, not a log.
 */
export const MAX_SALVAGE_BYTES = 32 * 1024 * 1024;

function prelude(getAccessHandleExpression) {
	return `globalThis.${MARKER}=1;
function __wcposScanJsonValue(raw,start){
var depth=0,inString=false,escaped=false;
for(var at=start;at<raw.length;at++){
var ch=raw[at];
if(inString){if(escaped)escaped=false;else if(ch==="\\\\")escaped=true;else if(ch==='"')inString=false;continue}
if(ch==='"')inString=true;else if(ch==="{"||ch==="[")depth++;else if(ch==="}"||ch==="]"){depth--;if(depth===0)return at+1}
}
return -1
}
function __wcposIsDocumentData(doc,documentId,primaryPath,requireAttachments){
if(!doc||typeof doc!=="object"||Array.isArray(doc))return false;
if(doc[primaryPath]!==documentId||typeof doc._deleted!=="boolean"||!doc._meta||typeof doc._meta.lwt!=="number")return false;
if(!requireAttachments)return true;
var attachments=doc._attachments;
if(!attachments||typeof attachments!=="object"||Array.isArray(attachments))return false;
for(var key in attachments){
var attachment=attachments[key];
if(!attachment||typeof attachment!=="object"||typeof attachment.digest!=="string")return false
}
return true
}
function __wcposIsEventBulk(bulk,primaryPath,requireAttachments){
if(!bulk||typeof bulk!=="object"||Array.isArray(bulk)||!Array.isArray(bulk.events))return false;
for(var i=0;i<bulk.events.length;i++){
var event=bulk.events[i];
if(!event||typeof event.documentId!=="string")return false;
if(!__wcposIsDocumentData(event.documentData,event.documentId,primaryPath,requireAttachments))return false;
if(event.previousDocumentData!==undefined&&event.previousDocumentData!==null&&!__wcposIsDocumentData(event.previousDocumentData,event.documentId,primaryPath,requireAttachments))return false
}
return true
}
function __wcposSalvageEventBulks(raw,primaryPath,requireAttachments){
var kept=[],cursor=0;
for(;;){
while(cursor<raw.length&&(raw[cursor]===" "||raw[cursor]==="\\n"||raw[cursor]==="\\r"||raw[cursor]==="\\t"))cursor++;
if(kept.length>0){if(raw[cursor]!==",")break;cursor++;while(cursor<raw.length&&(raw[cursor]===" "||raw[cursor]==="\\n"||raw[cursor]==="\\r"||raw[cursor]==="\\t"))cursor++}
if(raw[cursor]!=="{")break;
var end=__wcposScanJsonValue(raw,cursor);
if(end<0)break;
var bulk;
try{bulk=JSON.parse(raw.slice(cursor,end))}catch(parseError){break}
if(!__wcposIsEventBulk(bulk,primaryPath,requireAttachments))break;
kept.push(bulk);cursor=end
}
return kept
}
function __wcposReportRecovery(report){
var hook=globalThis.__wcposOnStorageRecovery;
if(typeof hook==="function"){try{hook(report);return}catch(hookError){}}
console.error("["+report.kind+"] "+report.target,report)
}
async function __wcposReadChangesFile(instance,runState,state,changesAccess,bytes){
var primaryPath=instance.primaryPath,requireAttachments=!!(instance.schema&&instance.schema.attachments),target=state.params.databaseName+"/"+state.params.collectionName;
if(bytes.byteLength>${MAX_SALVAGE_BYTES}){
await changesAccess.truncate(0);
__wcposReportRecovery({kind:"changes-file-discarded",target:target,reason:"oversized",bytes:bytes.byteLength,keptBulks:0,quarantined:false});
return null
}
var raw=instance._decode(bytes),failure;
try{
var parsed=JSON.parse("["+raw+"]");
for(var i=0;i<parsed.length;i++)if(!__wcposIsEventBulk(parsed[i],primaryPath,requireAttachments))throw new Error("event bulk "+i+" failed validation");
return parsed
}catch(error){failure=error}
var kept=__wcposSalvageEventBulks(raw,primaryPath,requireAttachments),quarantined=false;
try{
var quarantineHandle=await(await state.dirHandle).getFileHandle("${QUARANTINE_FILE}",{create:true}),quarantineAccess=await ${getAccessHandleExpression},quarantineWritable=await quarantineAccess.getWritable();
await quarantineWritable.write(bytes,{at:0});await quarantineAccess.truncate(bytes.byteLength);quarantined=true
}catch(quarantineError){}
if(kept.length===0)await changesAccess.truncate(0);
__wcposReportRecovery(kept.length>0?{kind:"changes-file-salvage",target:target,bytes:bytes.byteLength,keptBulks:kept.length,quarantined:quarantined,error:failure}:{kind:"changes-file-discarded",target:target,reason:"no-complete-bulk",bytes:bytes.byteLength,keptBulks:0,quarantined:quarantined,error:failure});
return kept.length>0?kept:null
}
`;
}

export const DISTS = [
	{
		dist: 'esm',
		prelude: prelude('n(quarantineHandle,runState)'),
		rewrites: [
			{
				name: 'getAccessHandleBinding',
				before: 'import{getAccessHandle as n}from"./task-queue.js"',
				after: 'import{getAccessHandle as n}from"./task-queue.js"',
			},
			{
				name: 'trackAppend',
				before:
					'var C=JSON.stringify(f.eventBulk);t.knownChangesFileSize&&(C=","+C);var P=r._encode(C),_=(await g).write(P,{at:t.knownChangesFileSize?t.knownChangesFileSize:0});r.changes$.next(C),await _}',
				after:
					'var C=JSON.stringify(f.eventBulk),__wcposBulk=C;t.knownChangesFileSize&&(C=","+C);var P=r._encode(C),_=(await g).write(P,{at:t.knownChangesFileSize?t.knownChangesFileSize:0});r.changes$.next(__wcposBulk),await _,t.knownChangesFileSize=(t.knownChangesFileSize||0)+P.byteLength}',
			},
			{
				name: 'readChanges',
				before: 'o=JSON.parse("["+a._decode(g)+"]")}',
				after: 'o=await __wcposReadChangesFile(a,e,l,m,g);if(!o)return}',
			},
			{
				name: 'resetAfterReplay',
				before: 'm.truncate(0)]),await t(a,l,p,o)}',
				after: 'm.truncate(0)]),e.knownChangesFileSize=0,await t(a,l,p,o)}',
			},
		],
	},
	{
		dist: 'cjs',
		prelude: prelude('(0,a.getAccessHandle)(quarantineHandle,runState)'),
		rewrites: [
			{
				name: 'getAccessHandleBinding',
				before: 'a=require("./task-queue.js")',
				after: 'a=require("./task-queue.js")',
			},
			{
				name: 'trackAppend',
				before:
					'var _=JSON.stringify(f.eventBulk);n.knownChangesFileSize&&(_=","+_);var x=o._encode(_),y=(await w).write(x,{at:n.knownChangesFileSize?n.knownChangesFileSize:0});o.changes$.next(_),await y}',
				after:
					'var _=JSON.stringify(f.eventBulk),__wcposBulk=_;n.knownChangesFileSize&&(_=","+_);var x=o._encode(_),y=(await w).write(x,{at:n.knownChangesFileSize?n.knownChangesFileSize:0});o.changes$.next(__wcposBulk),await y,n.knownChangesFileSize=(n.knownChangesFileSize||0)+x.byteLength}',
			},
			{
				name: 'readChanges',
				before: 'o=JSON.parse("["+r._decode(m)+"]")}',
				after: 'o=await __wcposReadChangesFile(r,e,c,d,m);if(!o)return}',
			},
			{
				name: 'resetAfterReplay',
				before: 'd.truncate(0)]),await(0,t.broadcastChangelogOperations)(r,c,f,o)}',
				after:
					'd.truncate(0)]),e.knownChangesFileSize=0,await(0,t.broadcastChangelogOperations)(r,c,f,o)}',
			},
		],
	},
];

export function preparePatch(path, patch) {
	const source = readFileSync(path, 'utf8');
	if (source.includes(`${MARKER}=1`)) {
		// A dist patched by an older revision of this script carries the marker
		// but not the current prelude; running on with the stale prelude would
		// silently skip newer validation, so fail loudly instead.
		if (!source.includes(patch.prelude)) {
			throw new Error(
				`${path} carries the salvage patch marker but an outdated prelude — reinstall rxdb-premium so postinstall can re-apply the current patch`
			);
		}
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
		if (rewrite.before !== rewrite.after && next.includes(rewrite.before))
			throw new Error(`anchor ${rewrite.name} survived its rewrite in ${path}`);
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
	for (const { dist, prelude: distPrelude, rewrites } of DISTS) {
		const path = join(
			packageRoot,
			`dist/${dist}/plugins/storage-abstract-filesystem/bulk-write.js`
		);
		if (!existsSync(path)) {
			throw new Error(
				`rxdb-premium ${dist}/bulk-write.js not found — run after package postinstall`
			);
		}
		prepared.push({ dist, ...preparePatch(path, { prelude: distPrelude, rewrites }) });
	}
	commitPatches(prepared);
	console.log(
		`[patch-rxdb-premium-changes-file-salvage] ${prepared
			.map(({ dist, status }) => `${dist}: ${status}`)
			.join(', ')}`
	);
}

if (
	process.argv[1] &&
	realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
	main();
}

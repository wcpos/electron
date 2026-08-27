/**
 * Patches rxdb-premium's abstract-filesystem `TaskQueue` so that ONE failing
 * storage task cannot kill a collection for the rest of the session.
 *
 * Upstream ends every run with `cleanupAfterRun(runState)` — which closes the
 * access handles the run opened — but neither trigger function wraps the run in
 * a `finally`, and `this.queue` is reassigned to a promise that stays rejected:
 *
 *   this.queue = this.queue.then(async () => { ...run...; cleanupAfterRun() })
 *                          .catch(e => { console.log(...); throw e })
 *   this.queue.catch(() => {})     // silences the warning; does NOT heal
 *
 * So a write task that throws (`runWrite` rethrows; `runRead` does not) does
 * three things at once:
 *
 *   1. skips `cleanupAfterRun`, leaking that run's access handles. On OPFS the
 *      handles stay open for the life of the worker, so any later open of the
 *      same file throws `NoModificationAllowedError: Access Handles cannot be
 *      created if there is another open Access Handle...`.
 *   2. leaves `this.queue` rejected. Every later task chains on with `.then(cb)`,
 *      so `cb` never runs and the promise handed to the caller NEVER SETTLES —
 *      a silent hang with no error, no rejection, and no timeout.
 *   3. re-reports itself forever: each subsequent `trigger*Tasks` call re-chains
 *      onto the still-rejected queue, so the tail `.catch` logs the SAME original
 *      error again. That is the "error storm" of identical messages — it is one
 *      failure being re-printed, not many failures.
 *
 * Verified against the installed package by
 * `scripts/rxdb-premium-task-queue-containment.test.mjs`, which drives the real
 * TaskQueue and reports `hung` for every post-failure task without this patch.
 *
 * The fix is two anchors per dist:
 *
 *   - the constructor installs a self-healing accessor for `queue`, so every
 *     assignment is stored already-caught. One failure is reported once, with the
 *     database/collection that owns it, and the chain stays usable. This covers
 *     `runCleanup` and `runInit` too, which have no tail `.catch` at all.
 *   - the write run gets `try { ... } finally { cleanupAfterRun() }`, so handles
 *     are released on the throwing path. Upstream's "abort the rest of this
 *     batch" semantics are deliberately preserved: the run still unwinds, and the
 *     failing task's own promise still rejects to its caller. Only the leak and
 *     the poisoning are removed.
 *
 * READ and CLEANUP runs get the same `finally` guard. Their task wrappers do
 * swallow task errors (pinned by the containment test, so an upstream change
 * that makes reads rethrow fails loudly), but the shared pre-run hook —
 * `beforeTaskReadOrWrite`, i.e. the changes-file replay — runs on those run
 * types too, and its rejection unwinds the run past `cleanupAfterRun` exactly
 * like a throwing write task (found by review on the first cut of this patch,
 * which guarded only writes). The INIT run needs no anchor: upstream chains
 * `cleanupAfterRun` after its own `.catch`, so it always runs — pinned by test.
 *
 * A pre-run-hook rejection still leaves that one run's own callers pending
 * (their tasks never execute and nothing rejects them) — that is upstream's
 * pre-existing semantic, bounded to the failing run and surfaced by the
 * app-layer stall diagnostic; only the permanent damage (leak, poisoning) is
 * removed here.
 *
 * Why not `pnpm patch`: rxdb-premium's dist/ is materialized by its own
 * license-gated postinstall, so it does not exist in the tarball pnpm patches —
 * the same constraint that produced `patch-rxdb-premium-resurrection-leak.mjs`.
 * This runs from the repo postinstall, is idempotent, and FAILS THE INSTALL if
 * an anchor moves on a new rxdb-premium version, so the patch is re-derived (or
 * dropped, once upstream ships the `finally` — re-run the containment test
 * before deleting this).
 *
 * The patch lands in the shared abstract-filesystem layer, so it covers every
 * storage backend served by the rxdb-premium install it runs against — a
 * postinstall can only reach its own repo's node_modules. In the monorepo that
 * is OPFS on web and the expo-filesystem engine on native. The Electron app
 * carries its own rxdb-premium and its own verbatim copy of this patcher
 * (wcpos/electron#375), which is what contains filesystem-node in its main
 * process — keep the two copies identical.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const MARKER = '__wcposInstallQueueHealer';

/**
 * Prepended to the module. `globalThis.WCPOS_TASK_QUEUE_CONTAINMENT_PATCH`
 * survives esbuild/metro minification, so a built bundle
 * (`apps/main/public/opfs.worker.js`) can be audited for the patch.
 *
 * `globalThis.__wcposOnStorageRunFailure` is the reporting seam: a host that
 * installs one gets a structured `{ target, error }` per failure. Without it the
 * fallback console line still names the database and collection — the identity
 * upstream's bare "ERROR TaskQueue.triggerWriteTasks.queue errored:" omits, and
 * whose absence is why past incidents could not be traced to a collection.
 */
const PRELUDE = `globalThis.WCPOS_TASK_QUEUE_CONTAINMENT_PATCH=1;
function __wcposReportRunFailure(taskQueue,error){
try{
var instance=taskQueue&&taskQueue.storageInstance;
var target=instance?[instance.databaseName,instance.collectionName,"v"+(instance.schema&&instance.schema.version)].join("/"):"unknown";
var report=globalThis.__wcposOnStorageRunFailure;
if(typeof report==="function"){report({target:target,error:error});return}
console.error("[wcpos] storage task-queue run failed ("+target+")",error);
}catch(reportError){}
}
function ${MARKER}(taskQueue,initial){
var current=initial;
Object.defineProperty(taskQueue,"queue",{configurable:true,get:function(){return current},set:function(next){
current=next&&typeof next.catch==="function"?next.catch(function(error){__wcposReportRunFailure(taskQueue,error)}):next;
}});
}
`;

/**
 * Each dist is minified with its own identifier names, so the anchors are
 * per-dist literals rather than a regex. A literal that stops matching is the
 * signal we want — see the install-failure note above.
 */
const DISTS = [
	{
		dist: 'esm',
		constructorBefore: 'this.queue=e,this.readTasks=[]',
		constructorAfter: `this.queue=e,${MARKER}(this,e),this.readTasks=[]`,
		writeRunBefore: '(async()=>{if(0!==this.writeTasks.length){for(var s={type:"WRITE"',
		writeRunAfter: '(async()=>{if(0!==this.writeTasks.length){try{for(var s={type:"WRITE"',
		writeCleanupBefore: 'await this.beforeTaskReadOrWrite(s),await this.cleanupAfterRun(s)}}))',
		writeCleanupAfter:
			'await this.beforeTaskReadOrWrite(s)}finally{if(s)await this.cleanupAfterRun(s)}}}))',
		readRunBefore:
			'(async()=>{var e={type:"READ",storageInstance:t(this.storageInstance),accessHandlers:new Map,touchedWriteDocuments:new Set,knownChangesContent:[]};await this.beforeTaskReadOrWrite(e);',
		readRunAfter:
			'(async()=>{try{var e={type:"READ",storageInstance:t(this.storageInstance),accessHandlers:new Map,touchedWriteDocuments:new Set,knownChangesContent:[]};await this.beforeTaskReadOrWrite(e);',
		readCleanupBefore: '0===this.readTasks.length&&(s=!0)}return this.cleanupAfterRun(e)}))',
		readCleanupAfter:
			'0===this.readTasks.length&&(s=!0)}}finally{if(e)await this.cleanupAfterRun(e)}}))',
		cleanupRunBefore:
			'(async()=>{var r={type:"CLEANUP",storageInstance:t(this.storageInstance),accessHandlers:new Map,touchedWriteDocuments:new Set,knownChangesContent:[]};await this.beforeTaskReadOrWrite(r),await e(r).then((e=>s(e))).catch((e=>a(e))),await this.cleanupAfterRun(r)}))',
		cleanupRunAfter:
			'(async()=>{try{var r={type:"CLEANUP",storageInstance:t(this.storageInstance),accessHandlers:new Map,touchedWriteDocuments:new Set,knownChangesContent:[]};await this.beforeTaskReadOrWrite(r),await e(r).then((e=>s(e))).catch((e=>a(e)))}finally{if(r)await this.cleanupAfterRun(r)}}))',
	},
	{
		dist: 'cjs',
		constructorBefore: 'this.queue=e.PROMISE_RESOLVE_VOID,this.readTasks=[]',
		constructorAfter: `this.queue=e.PROMISE_RESOLVE_VOID,${MARKER}(this,e.PROMISE_RESOLVE_VOID),this.readTasks=[]`,
		writeRunBefore: '(async()=>{if(0!==this.writeTasks.length){for(var a={type:"WRITE"',
		writeRunAfter: '(async()=>{if(0!==this.writeTasks.length){try{for(var a={type:"WRITE"',
		writeCleanupBefore: 'await this.beforeTaskReadOrWrite(a),await this.cleanupAfterRun(a)}}))',
		writeCleanupAfter:
			'await this.beforeTaskReadOrWrite(a)}finally{if(a)await this.cleanupAfterRun(a)}}}))',
		readRunBefore:
			'(async()=>{var s={type:"READ",storageInstance:(0,e.ensureNotFalsy)(this.storageInstance),accessHandlers:new Map,touchedWriteDocuments:new Set,knownChangesContent:[]};await this.beforeTaskReadOrWrite(s);',
		readRunAfter:
			'(async()=>{try{var s={type:"READ",storageInstance:(0,e.ensureNotFalsy)(this.storageInstance),accessHandlers:new Map,touchedWriteDocuments:new Set,knownChangesContent:[]};await this.beforeTaskReadOrWrite(s);',
		readCleanupBefore: '0===this.readTasks.length&&(a=!0)}return this.cleanupAfterRun(s)}))',
		readCleanupAfter:
			'0===this.readTasks.length&&(a=!0)}}finally{if(s)await this.cleanupAfterRun(s)}}))',
		cleanupRunBefore:
			'(async()=>{var r={type:"CLEANUP",storageInstance:(0,e.ensureNotFalsy)(this.storageInstance),accessHandlers:new Map,touchedWriteDocuments:new Set,knownChangesContent:[]};await this.beforeTaskReadOrWrite(r),await t(r).then((e=>s(e))).catch((e=>a(e))),await this.cleanupAfterRun(r)}))',
		cleanupRunAfter:
			'(async()=>{try{var r={type:"CLEANUP",storageInstance:(0,e.ensureNotFalsy)(this.storageInstance),accessHandlers:new Map,touchedWriteDocuments:new Set,knownChangesContent:[]};await this.beforeTaskReadOrWrite(r),await t(r).then((e=>s(e))).catch((e=>a(e)))}finally{if(r)await this.cleanupAfterRun(r)}}))',
	},
];

/**
 * Validate-only phase: every dist is checked before any is written, so a moved
 * anchor in one cannot leave the other half-patched (a retried install would
 * then start from an inconsistent tree).
 */
function preparePatch(path, anchors) {
	const source = readFileSync(path, 'utf8');
	if (source.includes(MARKER)) return { path, status: 'already patched' };

	for (const key of [
		'constructorBefore',
		'writeRunBefore',
		'writeCleanupBefore',
		'readRunBefore',
		'readCleanupBefore',
		'cleanupRunBefore',
	]) {
		const anchor = anchors[key];
		const occurrences = source.split(anchor).length - 1;
		if (occurrences !== 1) {
			throw new Error(
				`anchor ${key} matched ${occurrences} times in ${path} (expected exactly 1) — ` +
					'rxdb-premium changed; re-derive this patch against the containment test'
			);
		}
	}

	const next =
		PRELUDE +
		source
			.replace(anchors.constructorBefore, anchors.constructorAfter)
			.replace(anchors.writeRunBefore, anchors.writeRunAfter)
			.replace(anchors.writeCleanupBefore, anchors.writeCleanupAfter)
			.replace(anchors.readRunBefore, anchors.readRunAfter)
			.replace(anchors.readCleanupBefore, anchors.readCleanupAfter)
			.replace(anchors.cleanupRunBefore, anchors.cleanupRunAfter);

	return { path, next, status: 'patched' };
}

/** Write phase: only reached once every dist validated. */
function commitPatches(prepared) {
	for (const { path, next } of prepared) {
		if (next !== undefined) writeFileSync(path, next);
	}
}

const packageRoot = dirname(require.resolve('rxdb-premium/package.json'));

const prepared = DISTS.map(({ dist, ...anchors }) => {
	const path = join(packageRoot, `dist/${dist}/plugins/storage-abstract-filesystem/task-queue.js`);
	if (!existsSync(path)) {
		throw new Error(`rxdb-premium ${dist} dist not found — run after the package postinstall`);
	}
	return { dist, ...preparePatch(path, anchors) };
});

commitPatches(prepared);

console.log(
	`[patch-rxdb-premium-task-queue-containment] ${prepared
		.map(({ dist, status }) => `${dist}: ${status}`)
		.join(', ')}`
);

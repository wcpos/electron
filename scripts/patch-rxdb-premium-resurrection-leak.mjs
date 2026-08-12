/**
 * Patches rxdb-premium's abstract-filesystem storage against the resurrection
 * index-row leak (dev-next corruption incident, 2026-08-12).
 *
 * Inserting a primary key whose stored document is soft-deleted succeeds via
 * an rxdb-core conflict retry (rx-storage-helper `reInserts`) that emits the
 * change event as `operation: INSERT` with `previousDocumentData: null`, even
 * though the write carried the tombstone as `previous`. The storage's
 * `IndexState.appendWriteOperations` relies on that field to remove the prior
 * index row, so every delete → re-insert cycle leaks one row into every index
 * file. Compaction later moves document bytes and only re-points the row it
 * can find per key, so the leaked rows drift into garbage byte ranges — the
 * malformed-JSON read failures ("Expected ',' or ']' after array element…").
 * Public-API reproduction: .claude/research/2026-08-12-repro-2-resurrection-index-leak.mjs
 *
 * The fix backfills the missing previous document FOR INDEX MAINTENANCE ONLY,
 * inside `processChangesFileIfRequired`: the storage's own primary-index
 * metaIdMap knows the tombstone's row and `getDocumentsJson` reads the old
 * document back from it. Change-stream events, changes.json content and
 * BroadcastChannel payloads are untouched — the shim feeds a shallow copy of
 * the event list to the index updater and nothing else.
 *
 * Why not `pnpm patch`: rxdb-premium's dist/ is materialized by its own
 * license-gated postinstall, so it does not exist in the tarball that pnpm
 * patches. This script runs from the repo postinstall instead, after the
 * package's own postinstall has produced dist/. It is idempotent, and it
 * FAILS THE INSTALL if the anchors are missing on a new rxdb-premium version
 * so the patch gets re-evaluated (or dropped, if upstream fixed the event —
 * check the resurrection repro before deleting this).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const MARKER = "__wcposIdxEvents";

function shim({ state, ctx, docHandle, events, getDocumentsJson }) {
  return (
    // globalThis marker: survives esbuild/metro minification so bundles
    // (apps/main/public/opfs.worker.js) can be audited for the patch.
    `globalThis.WCPOS_RESURRECTION_LEAK_PATCH=1;` +
    `var ${MARKER}=${events};` +
    // Failures are contained PER EVENT: a read/parse failure for one event
    // leaves only that event unbackfilled (it leaks, the pre-patch status
    // quo) while completed backfills for the rest of the batch are kept.
    `try{var __wcposMim=${state}.firstIdx&&${state}.firstIdx.metaIdMap;` +
    `if(__wcposMim){` +
    `for(var __wcposQ=0;__wcposQ<${events}.length;__wcposQ++){` +
    `try{` +
    `var __wcposEv=${events}[__wcposQ];` +
    `if(__wcposEv.previousDocumentData||!__wcposMim.has(__wcposEv.documentId))continue;` +
    `var __wcposOldRow=__wcposMim.get(__wcposEv.documentId);` +
    `var __wcposOldDocs=await ${getDocumentsJson}(${state},${docHandle},${ctx},[__wcposOldRow]);` +
    `if(!__wcposOldDocs||!__wcposOldDocs[0])continue;` +
    `if(${MARKER}===${events})${MARKER}=${events}.slice(0);` +
    `${MARKER}[__wcposQ]=Object.assign({},__wcposEv,{previousDocumentData:__wcposOldDocs[0]});` +
    `}catch(__wcposEvErr){}` +
    `}}}catch(__wcposErr){}`
  );
}

/**
 * Validate-only phase: returns the patched content without writing, so all
 * dists are checked before any of them is touched — a missing anchor in one
 * dist must not leave the other half-patched (a retry would then start from
 * an inconsistent tree).
 */
function preparePatch(path, { importBefore, importAfter, loopBefore, loopAfter }) {
  const source = readFileSync(path, "utf8");
  if (source.includes(MARKER)) return { path, status: "already patched" };
  if (importBefore) {
    if (!source.includes(importBefore)) {
      throw new Error(`anchor missing in ${path}: import site`);
    }
  }
  if (!source.includes(loopBefore)) {
    throw new Error(`anchor missing in ${path}: index-maintenance loop`);
  }
  let next = importBefore ? source.replace(importBefore, importAfter) : source;
  next = next.replace(loopBefore, loopAfter);
  return { path, next, status: "patched" };
}

/** Write phase: only reached when every dist validated. */
function commitPatches(prepared) {
  for (const { path, next } of prepared) {
    if (next !== undefined) writeFileSync(path, next);
  }
}

const packageRoot = dirname(require.resolve("rxdb-premium/package.json"));

const esm = join(
  packageRoot,
  "dist/esm/plugins/storage-abstract-filesystem/bulk-write.js",
);
const cjs = join(
  packageRoot,
  "dist/cjs/plugins/storage-abstract-filesystem/bulk-write.js",
);

if (!existsSync(esm) || !existsSync(cjs)) {
  throw new Error(
    "rxdb-premium dist not found — run after the package postinstall",
  );
}

const esmShim = shim({
  state: "l",
  ctx: "e",
  docHandle: "h",
  events: "u",
  getDocumentsJson: "__wcposGDJ",
});
const esmPrepared = preparePatch(esm, {
  importBefore: 'import{writeDocumentRows as r}from"./documents-file.js"',
  importAfter:
    'import{writeDocumentRows as r,getDocumentsJson as __wcposGDJ}from"./documents-file.js"',
  loopBefore:
    "for(var p=[],k=0;k<l.indexStates.length;k++){l.indexStates[k].appendWriteOperations(u,f.documentPositions,p)}",
  loopAfter:
    esmShim +
    "for(var p=[],k=0;k<l.indexStates.length;k++){l.indexStates[k].appendWriteOperations(__wcposIdxEvents,f.documentPositions,p)}",
});

const cjsShim = shim({
  state: "c",
  ctx: "e",
  docHandle: "u",
  events: "g",
  getDocumentsJson: "(0,n.getDocumentsJson)",
});
const cjsPrepared = preparePatch(cjs, {
  importBefore: 'n=require("./documents-file.js")',
  importAfter: 'n=require("./documents-file.js")',
  loopBefore:
    "for(var f=[],I=0;I<c.indexStates.length;I++){c.indexStates[I].appendWriteOperations(g,p.documentPositions,f)}",
  loopAfter:
    cjsShim +
    "for(var f=[],I=0;I<c.indexStates.length;I++){c.indexStates[I].appendWriteOperations(__wcposIdxEvents,p.documentPositions,f)}",
});

commitPatches([esmPrepared, cjsPrepared]);

console.log(
  `[patch-rxdb-premium-resurrection-leak] esm: ${esmPrepared.status}, cjs: ${cjsPrepared.status}`,
);

import { getPrimaryKeyFromIndexableString } from "rxdb/plugins/core";

function isMalformedJson(error) {
  return error?.name === "SyntaxError";
}

function parseStorageResult(result) {
  if (typeof result === "string") {
    JSON.parse(result);
  }
  return result;
}

function parseDocuments(result) {
  return typeof result === "string" ? JSON.parse(result) : result;
}

// Recovery events go to a host-installed hook when there is one (the Electron
// main process forwards them to Sentry with a stable message per kind), and to
// the console otherwise — the same seam shape as the rxdb-premium patches'
// __wcposOnStorageRunFailure / __wcposOnIndexRebuild.
function report(kind, details) {
  const hook = globalThis.__wcposOnStorageRecovery;
  if (typeof hook === "function") {
    try {
      hook({ kind, ...details });
      return;
    } catch {}
  }
  const { target, error, ...rest } = details;
  console.error(`[${kind}] ${target ?? ""}`.trimEnd(), error ?? rest);
}

function documentsAccessHandle(state, runState) {
  let accessHandlePromise = runState.accessHandlers.get(
    state.documentFileHandle,
  );
  if (!accessHandlePromise) {
    accessHandlePromise = state.documentFileHandle.createAccessHandle();
    runState.accessHandlers.set(state.documentFileHandle, accessHandlePromise);
  }
  return accessHandlePromise;
}

// Removes one index row the way the storage itself would: an in-memory "D"
// operation, persisted to the changelog and broadcast to multi-instance peers.
async function dropIndexRow(state, runState, indexState, position) {
  const operation = [
    indexState.indexId,
    position,
    "D",
    indexState.rows[position],
  ];
  indexState.runChangelogOperation(operation);
  await state.changelog.addChangelogOperations(runState, [operation]);
  state.broadcastChannel?.postMessage({
    type: "event",
    eventBulks: [],
    changelogOperations: [operation],
    info: {
      db: state.params.databaseName,
      col: state.params.collectionName,
    },
  });
}

function extractDocument(text, primaryPath, expectedId) {
  for (
    let start = text.indexOf("{");
    start >= 0;
    start = text.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = start; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try {
          const document = JSON.parse(text.slice(start, cursor + 1));
          if (document?.[primaryPath] === expectedId) return document;
        } catch {}
        break;
      }
    }
  }
}

// With `discardInvalid` (disposable collections only — `logs`) a range that
// holds no recoverable document is dropped in the SAME cleanup run that read
// it, outcome "discarded-no-valid-document" — see dropHollowRows for why the
// two steps must not straddle a queue release.
async function repairDocument(instance, documentId, { discardInvalid = false } = {}) {
  const state = await instance.internals.statePromise;
  return instance.taskQueue.runCleanup(async (runState) => {
    const primaryRow = state.firstIdx.metaIdMap.get(documentId);
    if (!primaryRow) return "missing-primary-row";

    const oldStart = primaryRow[1];
    const oldEnd = primaryRow[2];
    const indexRows = state.indexStates.map((indexState) => {
      const position = indexState.rows.findIndex(
        (row) => row[1] === oldStart && row[2] === oldEnd,
      );
      return { indexState, position };
    });
    if (indexRows.some(({ position }) => position < 0))
      return "missing-index-row";

    const accessHandle = await documentsAccessHandle(state, runState);
    const damagedBytes = await accessHandle.read(oldStart, oldEnd);
    const document = extractDocument(
      instance._decode(damagedBytes),
      instance.primaryPath,
      documentId,
    );
    if (!document) {
      if (!discardInvalid) return "no-valid-document";
      await dropIndexRowsById(state, runState, documentId, {
        includePrimary: true,
      });
      return "discarded-no-valid-document";
    }
    try {
      if (
        indexRows.some(
          ({ indexState, position }) =>
            indexState.getIndexableString(document) !==
            indexState.rows[position][0],
        )
      )
        return "index-mismatch";
    } catch {
      return "index-mismatch";
    }

    const recoveredBytes = instance._encode(JSON.stringify(document));
    const repairedBytes = new Uint8Array(oldEnd - oldStart);
    if (recoveredBytes.byteLength > repairedBytes.byteLength)
      return "recovered-document-too-large";
    repairedBytes.fill(32);
    repairedBytes.set(recoveredBytes);

    const writable = await accessHandle.getWritable();
    await writable.write(repairedBytes, { at: oldStart });
    await writable.flush?.();
    return true;
  });
}

async function dropWhitespaceRows(instance) {
  const state = await instance.internals.statePromise;
  return instance.taskQueue.runCleanup(async (runState) => {
    const accessHandle = await documentsAccessHandle(state, runState);
    const isWhitespace = (bytes) => instance._decode(bytes).trim() === "";
    for (const indexState of state.indexStates) {
      let position = indexState.rows.length;
      while (position--) {
        const row = indexState.rows[position];
        if (!isWhitespace(await accessHandle.read(row[1], row[2]))) continue;
        await dropIndexRow(state, runState, indexState, position);
      }
    }
  });
}

// A hollow row: the index says the document exists, but its byte range holds
// only whitespace (or nothing), so a read of that one row parses to `[]` and
// simply reports the document absent — no malformed-JSON signal for the paths
// above to catch. Compaction leaves exactly this behind when it dies between
// relocating a record and persisting the moved row: the old range has been
// space-filled while the index still points at it. The storage's own write
// path then indexes the parsed rows positionally and dereferences `undefined`
// (Sentry WOOCOMMERCE-POS-2HC). Dropping the row is the only repair — there
// are no bytes to recover — and a pending write for the id then lands as an
// insert. The caller refuses this under multi-instance: the drop is a
// positional "D" operation, and two peers that each detect the same hollow
// row before either broadcast lands will both drop it locally and then apply
// the other's operation at a position that now holds a healthy neighbour.
// All ids share one cleanup run (each run replays the changes file and
// re-reads every index first). Returns a Map of id → true when a row was
// dropped, false when the id was already gone, or a reason string when the
// range holds something other than whitespace (a foreign document or junk
// that happened to parse): that is a stale-range problem, not a hollow row,
// and is refused rather than guessed.
// With `discardForeign` (disposable collections only — `logs`) a foreign-bytes
// range is dropped in the SAME cleanup run that detected it, outcome
// "discarded-foreign-bytes": detection and deletion must not straddle a queue
// release, or a healthy write for the same id landing in between would be
// deleted as if it were the damaged row.
async function dropHollowRows(instance, documentIds, { discardForeign = false } = {}) {
  const state = await instance.internals.statePromise;
  return instance.taskQueue.runCleanup(async (runState) => {
    const outcomes = new Map();
    const accessHandle = await documentsAccessHandle(state, runState);
    for (const documentId of documentIds) {
      const primaryRow = state.firstIdx.metaIdMap.get(documentId);
      if (!primaryRow) {
        outcomes.set(documentId, false);
        continue;
      }
      const [, start, end] = primaryRow;
      const foreign =
        instance._decode(await accessHandle.read(start, end)).trim() !== "";
      if (foreign && !discardForeign) {
        outcomes.set(documentId, "range-holds-foreign-bytes");
        continue;
      }
      if (foreign) {
        await dropIndexRowsById(state, runState, documentId, {
          includePrimary: true,
        });
      } else {
        await dropIndexRowsForRange(state, runState, start, end);
      }
      outcomes.set(documentId, foreign ? "discarded-foreign-bytes" : true);
    }
    return outcomes;
  });
}

// Drops every index row (primary and secondary) pointing at one byte range,
// inside the caller's cleanup run. Only safe for a range nothing else can
// share — a hollow (whitespace) range; a range holding a foreign document is
// also indexed by that document's own rows, so those are dropped BY ID.
async function dropIndexRowsForRange(state, runState, start, end) {
  for (const indexState of state.indexStates) {
    const position = indexState.rows.findIndex(
      (row) => row[1] === start && row[2] === end,
    );
    if (position >= 0) await dropIndexRow(state, runState, indexState, position);
  }
}

// Drops every index row whose indexable string carries `documentId`, inside
// the caller's cleanup run: the primary row when `includePrimary`, and every
// secondary row either way. Identity, not offsets, so a row whose range holds
// a sibling's bytes never takes the sibling with it.
async function dropIndexRowsById(state, runState, documentId, { includePrimary }) {
  const keyLength = state.firstIdx.primaryKeyLength;
  for (const indexState of state.indexStates) {
    if (!includePrimary && indexState === state.firstIdx) continue;
    let position = indexState.rows.length;
    while (position--) {
      if (
        getPrimaryKeyFromIndexableString(
          indexState.rows[position][0],
          keyLength,
        ) !== documentId
      )
        continue;
      await dropIndexRow(state, runState, indexState, position);
    }
  }
}

// Deletes every secondary-index row still carrying a document id, through the
// same changelog "D" operations as dropIndexRow's other callers. Used when a
// write's `previous` is being stripped because the primary index lost the id:
// the damage that lost the primary row can leave a secondary row standing (an
// applied changelog add whose matching delete was lost), and the insert the
// stripped write becomes would file a second row for the id beside the stale
// one, so that secondary would serve both revisions from then on.
async function dropSecondaryRowsById(instance, documentIds) {
  const state = await instance.internals.statePromise;
  return instance.taskQueue.runCleanup(async (runState) => {
    for (const documentId of documentIds) {
      await dropIndexRowsById(state, runState, documentId, {
        includePrimary: false,
      });
    }
  });
}

async function reconcileSecondaryIndexes(instance) {
  const state = await instance.internals.statePromise;
  return instance.taskQueue.runCleanup(async (runState) => {
    const accessHandle = await documentsAccessHandle(state, runState);
    const secondaries = state.indexStates.filter(
      (indexState) => indexState !== state.firstIdx,
    );
    // The primary index is the rebuild source, so it must be corroborated,
    // not merely self-consistent. Secondaries are first CLASSIFIED: one whose
    // rows duplicate a document, miss one, or diverge in count is demonstrably
    // damaged — it casts no vote and simply gets rebuilt (the live corruption
    // shape: an applied changelog add whose matching delete was lost). Healthy
    // secondaries vote; a corroborating vote counts only when the voter's own
    // index key matches the document at the primary's range; and a competing
    // range with equal-or-better validated support that also parses to this
    // document (a coherent stale-revision consensus) still refuses. An ID a
    // secondary knows that the primary lacks refuses outright — the rebuild
    // must never drop a document — and with no healthy secondary at all there
    // is no corroborating evidence, so reconciliation refuses too.
    const keyLength = state.firstIdx.primaryKeyLength;
    const primaryIds = new Set();
    let previousKey = "";
    for (const [indexKey] of state.firstIdx.rows) {
      // RxDB binary-searches index rows, so an out-of-order source would
      // persist a broken index even when every row validates individually.
      if (indexKey < previousKey) return "unsorted-primary";
      previousKey = indexKey;
      const documentId = getPrimaryKeyFromIndexableString(indexKey, keyLength);
      if (primaryIds.has(documentId))
        return `duplicate-primary-id:${documentId.trim()}`;
      primaryIds.add(documentId);
    }
    const classified = [];
    for (const indexState of secondaries) {
      const rowsById = new Map();
      let duplicated = false;
      for (const row of indexState.rows) {
        const rowId = getPrimaryKeyFromIndexableString(row[0], keyLength);
        if (!primaryIds.has(rowId)) return `id-set-mismatch:${rowId.trim()}`;
        const rows = rowsById.get(rowId) ?? [];
        if (rows.length > 0) duplicated = true;
        rows.push(row);
        rowsById.set(rowId, rows);
      }
      const healthy = !duplicated && rowsById.size === primaryIds.size;
      classified.push({ indexState, rowsById, healthy });
    }
    if (!classified.some(({ healthy }) => healthy))
      return "no-healthy-secondary";
    const documents = [];
    const seenRanges = new Set();
    for (const [indexKey, start, end] of state.firstIdx.rows) {
      const documentId = getPrimaryKeyFromIndexableString(indexKey, keyLength);
      let document;
      try {
        document = JSON.parse(
          instance._decode(await accessHandle.read(start, end)),
        );
      } catch {
        return `primary-row-mismatch:${documentId.trim()}`;
      }
      if (
        document?.[instance.primaryPath] !== documentId ||
        state.firstIdx.getIndexableString(document) !== indexKey
      )
        return `primary-row-mismatch:${documentId.trim()}`;
      if (seenRanges.has(start))
        return `duplicate-primary-range:${documentId.trim()}`;
      // A corroborating vote only counts when the voter is healthy AND
      // self-consistent: its own index key must match the document at the
      // primary's range. Damaged secondaries cast no corroborating vote, but
      // their rows still join the competing scan below — even a damaged index
      // can hold veto evidence of a valid current revision elsewhere.
      let primaryVotes = 1;
      const competing = new Map();
      for (const { indexState, rowsById, healthy } of classified) {
        for (const row of rowsById.get(documentId) ?? []) {
          if (row[1] === start && row[2] === end) {
            if (!healthy) continue;
            try {
              if (indexState.getIndexableString(document) === row[0])
                primaryVotes += 1;
            } catch {}
          } else {
            const key = `${row[1]}-${row[2]}`;
            const entry = competing.get(key) ?? {
              range: [row[1], row[2]],
              voters: [],
              voterIndexes: new Set(),
            };
            // One vote per index per range — a damaged secondary's duplicate
            // rows must not stack up into a fabricated competing consensus.
            if (!entry.voterIndexes.has(indexState)) {
              entry.voterIndexes.add(indexState);
              entry.voters.push([indexState, row[0]]);
            }
            competing.set(key, entry);
          }
        }
      }
      for (const { range, voters } of competing.values()) {
        if (voters.length < primaryVotes) continue;
        let candidate;
        try {
          candidate = JSON.parse(
            instance._decode(await accessHandle.read(range[0], range[1])),
          );
        } catch {
          continue;
        }
        if (candidate?.[instance.primaryPath] !== documentId) continue;
        let validVotes = 0;
        for (const [indexState, rowKey] of voters) {
          try {
            if (indexState.getIndexableString(candidate) === rowKey)
              validVotes += 1;
          } catch {}
        }
        if (validVotes >= primaryVotes)
          return `uncorroborated-primary-range:${documentId.trim()}`;
      }
      seenRanges.add(start);
      documents.push({ document, start, end });
    }

    const previousRows = new Map();
    // Accepted ranges must be pairwise disjoint — a range nested inside
    // another row's bytes can parse and match its key, but persisting
    // overlapping records corrupts later compaction.
    const ordered = [...documents].sort(
      (left, right) => left.start - right.start,
    );
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i].start < ordered[i - 1].end) return "overlapping-ranges";
    }

    // Compute every rebuilt array before assigning any — an exception halfway
    // through (e.g. a schema-corrupt document breaking key derivation) must
    // not leave the instance partially repaired in memory.
    const rebuiltRows = [];
    for (const indexState of state.indexStates) {
      if (indexState === state.firstIdx) continue;
      const rebuilt = documents
        .map(({ document, start, end }) => [
          indexState.getIndexableString(document),
          start,
          end,
        ])
        .sort((left, right) => (left[0] < right[0] ? -1 : 1));
      if (JSON.stringify(rebuilt) !== JSON.stringify(indexState.rows)) {
        rebuiltRows.push([indexState, rebuilt]);
      }
    }
    if (rebuiltRows.length === 0) return "no-divergence";
    for (const [indexState, rebuilt] of rebuiltRows) {
      previousRows.set(indexState, indexState.rows);
      indexState.rows = rebuilt;
    }

    // Emptying the changelog drops pending row operations for every index, so
    // every index must be persisted from its current in-memory rows — the same
    // pairing the storage's own cleanupChangelogOperations maintains. A failed
    // commit restores the previous in-memory rows and attempts every on-disk
    // rollback, reporting any restoration failures with the commit failure.
    const persistedRebuilds = [];
    try {
      for (const indexState of state.indexStates) {
        await indexState.persistInMemoryRows(runState);
        if (previousRows.has(indexState)) persistedRebuilds.push(indexState);
      }
      await state.changelog.empty(runState);
    } catch (persistError) {
      for (const [indexState, rows] of previousRows) {
        indexState.rows = rows;
      }
      const rollbackErrors = [];
      for (let i = persistedRebuilds.length - 1; i >= 0; i -= 1) {
        try {
          await persistedRebuilds[i].persistInMemoryRows(runState);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [persistError, ...rollbackErrors],
          `index persistence failed: ${persistError?.message ?? persistError}; rollback incomplete: ${rollbackErrors.map((error) => error?.message ?? error).join("; ")}`,
        );
      }
      throw persistError;
    }
    return true;
  });
}

export function withTargetedOpfsRecovery(storage) {
  const createStorageInstance = storage.createStorageInstance.bind(storage);
  return {
    ...storage,
    async createStorageInstance(params) {
      const instance = await createStorageInstance(params);
      const findDocumentsById = instance.findDocumentsById.bind(instance);
      const bulkWrite = instance.bulkWrite.bind(instance);
      const query = instance.query.bind(instance);
      const count = instance.count?.bind(instance);
      const getChangedDocumentsSince =
        instance.getChangedDocumentsSince.bind(instance);
      const cleanup = instance.cleanup?.bind(instance);

      // The write preflight exists so the storage's write path never parses
      // unverified stored bytes (a parse failure there poisons the task
      // queue). But the probe is a read, and the storage serializes reads
      // behind pending write persistence, so probing every bulkWrite costs a
      // disk flush per call (~3ms; 63-98% sustained throughput, see
      // opfs-targeted-recovery.bench.mjs). An id whose stored bytes already
      // parsed this session — via a wrapped read or a clean preflight — gives
      // the same guarantee the probe would, so verified ids skip it. Damage
      // predates the session (complete-write shim guards our own writes), but
      // any malformed observation still clears the cache so a damage episode
      // re-enables full probing.
      const cleanIds = new Set();
      const target = `${params.databaseName}/${params.collectionName}`;

      // Ids a read should have served but did not: the primary index has a
      // row for them (every row for a withDeleted read; only live rows —
      // index key prefixed "0" — otherwise, mirroring the storage's own
      // filter), yet no parsed document carries the id. Those rows are
      // hollow, or point at some other document's bytes.
      const findHollowIds = async (ids, documents, withDeleted) => {
        const metaIdMap = (await instance.internals?.statePromise)?.firstIdx
          ?.metaIdMap;
        if (!metaIdMap) return [];
        const returned = new Set();
        for (const row of documents) {
          if (row) returned.add(row[instance.primaryPath]);
        }
        return ids.filter((id) => {
          if (returned.has(id)) return false;
          const row = metaIdMap.get(id);
          return Boolean(row) && (withDeleted || row[0][0] === "0");
        });
      };

      const dropHollowIds = async (hollow) => {
        const refused = [];
        if (hollow.length === 0) return refused;
        if (params.multiInstance) {
          for (const id of hollow) {
            refused.push({ id, reason: "multi-instance" });
            report("hollow-row-refused", {
              target,
              id,
              reason: "multi-instance",
            });
          }
          return refused;
        }
        const outcomes = await dropHollowRows(instance, hollow, {
          discardForeign: params.collectionName === "logs",
        });
        for (const [id, outcome] of outcomes) {
          if (outcome === "discarded-foreign-bytes") {
            report("log-row-discarded", {
              target,
              id,
              reason: "range-holds-foreign-bytes",
            });
          } else if (typeof outcome === "string") {
            refused.push({ id, reason: outcome });
            report("hollow-row-refused", { target, id, reason: outcome });
          } else if (outcome) {
            report("hollow-row-dropped", { target, id });
          }
        }
        return refused;
      };

      const repairMalformedIds = async (ids, onMalformedBatch) => {
        const repairBatch = async (batch) => {
          let documents;
          try {
            documents = parseDocuments(await findDocumentsById(batch, true));
          } catch (error) {
            if (!isMalformedJson(error)) throw error;
            if (params.multiInstance) {
              error.message += "; targeted recovery refused: multi-instance";
              throw error;
            }
            onMalformedBatch?.();
            if (batch.length === 1) {
              const failure = await repairDocument(instance, batch[0], {
                discardInvalid: params.collectionName === "logs",
              });
              if (failure === "discarded-no-valid-document") {
                report("log-row-discarded", {
                  target,
                  id: batch[0],
                  reason: "no-valid-document",
                });
                return true;
              }
              if (typeof failure === "string") {
                error.message += `; targeted recovery failed for ${batch[0]}: ${failure}`;
                throw error;
              }
              return true;
            }
            const middle = Math.ceil(batch.length / 2);
            const repairedLeft = await repairBatch(batch.slice(0, middle));
            const repairedRight = await repairBatch(batch.slice(middle));
            return repairedLeft || repairedRight;
          }
          // The batch parsed, but a hollow row parses too — to nothing — and
          // the storage's write path would dereference the missing document.
          // A row whose range holds some other document's bytes is refused
          // here (reported, not repaired): the storage does not dereference
          // it, and a write carrying `previous` still locates the stale rows
          // by key and replaces them in place.
          const hollow = await findHollowIds(batch, documents, true);
          if (hollow.length === 0) return false;
          const refused = await dropHollowIds(hollow);
          onMalformedBatch?.();
          if (refused.length === hollow.length) return false;
          return true;
        };
        return repairBatch([...new Set(ids)]);
      };

      // A refused row's range holds some other document, which the storage
      // then serves in place of the one asked for — twice, if that document
      // was requested too, and possibly as a STALE revision when the foreign
      // row predates the healthy one. A read returns each requested id at
      // most once, and the copy it returns must be the one at the id's own
      // primary row: whichever copy the storage happened to return first must
      // not shadow the healthy one. So when a duplicate shows up, or a
      // refusal proved some range holds foreign bytes, every returned id is
      // re-read singly — the storage then reads only that id's own row, so
      // the copy that comes back is authoritative — and an id whose own row
      // yields nothing is omitted (it is hollow or foreign there, already
      // reported, and stays unverified). The foreign record itself stays
      // reachable under its own id. Applied to every return path: the first
      // read, the post-repair retry, and the singleton fallback.
      const ownRowCopy = async (id, withDeleted) => {
        const single = parseDocuments(
          await findDocumentsById([id], withDeleted),
        );
        return single.find((row) => row?.[instance.primaryPath] === id);
      };

      const ownDocuments = async (ids, result, withDeleted, suspectForeign) => {
        const documents = parseDocuments(result);
        const requested = new Set(ids);
        const served = new Set();
        let duplicated = false;
        const own = documents.filter((row) => {
          const id = row?.[instance.primaryPath];
          if (!requested.has(id)) return false;
          if (served.has(id)) {
            duplicated = true;
            return false;
          }
          served.add(id);
          return true;
        });
        if (!suspectForeign && !duplicated) {
          if (own.length === documents.length) return result;
          return typeof result === "string" ? JSON.stringify(own) : own;
        }
        const verified = [];
        for (const row of own) {
          const copy = await ownRowCopy(row[instance.primaryPath], withDeleted);
          if (copy) verified.push(copy);
        }
        return typeof result === "string" ? JSON.stringify(verified) : verified;
      };

      instance.findDocumentsById = async (ids, withDeleted) => {
        try {
          const result = await findDocumentsById(ids, withDeleted);
          const documents = parseDocuments(result);
          // A withDeleted read proves every requested id either parsed or is
          // absent — exactly what the write preflight establishes. Without
          // withDeleted the storage filters tombstones by index key alone,
          // never parsing their bytes, so only ids actually returned are
          // proven clean. A hollow row is neither: the storage reports its id
          // absent while the index still carries it, so the row is dropped
          // here — after which the id really is absent, hence clean — and a
          // refused id stays unverified for the write preflight, as does an
          // id served only by a foreign row and absent at its own.
          const hollow = await findHollowIds(ids, documents, withDeleted);
          const refused = await dropHollowIds(hollow);
          const suspectForeign = refused.some(
            ({ reason }) => reason === "range-holds-foreign-bytes",
          );
          const own = await ownDocuments(
            ids,
            result,
            withDeleted,
            suspectForeign,
          );
          const returned = new Set();
          for (const row of parseDocuments(own)) {
            returned.add(row[instance.primaryPath]);
          }
          if (withDeleted) {
            const refusedIds = new Set(refused.map(({ id }) => id));
            const metaIdMap = (await instance.internals?.statePromise)?.firstIdx
              ?.metaIdMap;
            for (const id of ids) {
              if (refusedIds.has(id)) continue;
              if (returned.has(id) || !metaIdMap?.has(id)) cleanIds.add(id);
            }
          } else {
            for (const id of returned) cleanIds.add(id);
          }
          return own;
        } catch (error) {
          if (!isMalformedJson(error)) throw error;
          cleanIds.clear();
          if (await repairMalformedIds(ids))
            return ownDocuments(
              ids,
              await findDocumentsById(ids, withDeleted),
              withDeleted,
              true,
            );
          if (ids.length > 1) {
            const batches = await Promise.all(
              ids.map((id) => findDocumentsById([id], withDeleted)),
            );
            // Each batch read exactly its own id's row, so keeping only the
            // matching document per batch IS the own-row guarantee; a batch
            // whose row held some other document contributes nothing.
            const seen = new Set();
            const documents = [];
            ids.forEach((id, index) => {
              if (seen.has(id)) return;
              seen.add(id);
              const own = parseDocuments(batches[index]).find(
                (row) => row?.[instance.primaryPath] === id,
              );
              if (own) documents.push(own);
            });
            return typeof batches[0] === "string"
              ? JSON.stringify(documents)
              : documents;
          }
          throw error;
        }
      };

      // A write whose `previous` names a document the index no longer holds
      // (its hollow row was just dropped, or it was purged before a late
      // update arrived) is an insert as far as the storage is concerned — but
      // the event it emits would carry `previousDocumentData`, and the index
      // code then looks up the previous key, finds no row, and operates at
      // position -1: a same-key index gains no row at all, a changed-key
      // index splices some other document's last row out. Stripping
      // `previous` makes it the plain insert the storage already treats it
      // as, so it applies to every write, not only one whose own preflight
      // dropped a row — the row may have gone in an earlier read, or the id
      // may be cached as verified precisely because it is absent. A
      // multi-instance peer inserting the id between this check and the run
      // changes nothing: with or without `previous`, that write is a 409.
      //
      // The map lags the storage: an insert reaches it only when the storage
      // flushes pending writes (end of a write run, or before the next task
      // touching the id), so an update that follows its own insert inside
      // that window finds the id absent — and stripping `previous` then
      // makes it a second insert, which the storage, having flushed the first
      // by the time it categorizes the write, refuses as a 409 (the embedded
      // web boot after Clear All Local Data: credentials upsert, then the
      // store-links patch, milliseconds apart on a fresh collection). A read
      // of the absent ids runs behind that flush, so the map is current when
      // re-checked; only an id still absent after the probe is a stale
      // `previous`. The probe costs a flush, but only on this rare path.
      const withoutStalePrevious = async (documentWrites) => {
        if (!documentWrites.some((row) => row.previous)) return documentWrites;
        const state = await instance.internals?.statePromise;
        const metaIdMap = state?.firstIdx?.metaIdMap;
        if (!metaIdMap) return documentWrites;
        const isAbsent = (row) =>
          Boolean(row.previous) &&
          !metaIdMap.has(row.document[instance.primaryPath]);
        const unflushed = documentWrites
          .filter(isAbsent)
          .map((row) => row.document[instance.primaryPath]);
        if (unflushed.length > 0) {
          await findDocumentsById([...new Set(unflushed)], true);
        }
        const stripped = [];
        const writes = documentWrites.map((row) => {
          if (!isAbsent(row)) return row;
          stripped.push(row.document[instance.primaryPath]);
          return { document: row.document };
        });
        if (stripped.length === 0) return writes;
        // The stripped write is an insert now, and premium's insert path adds
        // rows to every index without looking for survivors — but the damage
        // that lost the primary row can leave a secondary row standing, and
        // the insert would then file a second row for the id beside the stale
        // one, so that secondary serves both revisions from then on. The
        // stale rows are dropped through the changelog first; under
        // multi-instance the drop is refused like every positional repair —
        // and the write is refused WITH it, loudly, because stripping without
        // the drop corrupts the secondary while keeping `previous` corrupts
        // the primary (position -1).
        const keyLength = state.firstIdx.primaryKeyLength;
        const staleIds = stripped.filter((id) =>
          state.indexStates.some(
            (indexState) =>
              indexState !== state.firstIdx &&
              indexState.rows.some(
                (row) =>
                  getPrimaryKeyFromIndexableString(row[0], keyLength) === id,
              ),
          ),
        );
        if (staleIds.length === 0) return writes;
        if (params.multiInstance) {
          for (const id of staleIds) {
            report("stale-secondary-refused", {
              target,
              id,
              reason: "multi-instance",
            });
          }
          throw new Error(
            `stale secondary index rows for ${staleIds.join(", ")} in ${target}; targeted recovery refused: multi-instance`,
          );
        }
        await dropSecondaryRowsById(instance, staleIds);
        for (const id of staleIds) {
          report("stale-secondary-dropped", { target, id });
        }
        return writes;
      };

      instance.bulkWrite = async (documentWrites, context) => {
        const ids = documentWrites.map(
          (row) => row.document[instance.primaryPath],
        );
        let malformedBatch = false;
        if (ids.some((id) => !cleanIds.has(id))) {
          await repairMalformedIds(ids, () => {
            malformedBatch = true;
            cleanIds.clear();
          });
          if (!malformedBatch) {
            for (const id of ids) cleanIds.add(id);
          }
        }
        const writes = await withoutStalePrevious(documentWrites);
        if (malformedBatch && writes.length > 1) {
          // Sequential on purpose: parallel singleton writes can
          // interleave revisions of the same document.
          const results = [];
          for (const row of writes) {
            results.push(await bulkWrite([row], context));
          }
          await instance.taskQueue?.awaitIdle?.();
          return {
            error: results.flatMap((result) => result.error),
          };
        }
        try {
          return await bulkWrite(writes, context);
        } catch (error) {
          // A thrown write is exceptional whatever its shape — stored bytes
          // rotted after their ids were verified, or a row hollowed out under
          // a verified id — so drop the cache: retries re-probe and can
          // repair instead of skipping the preflight forever.
          cleanIds.clear();
          throw error;
        }
      };

      // When every per-document probe parses but an index-driven read is
      // malformed, the documents are healthy and a secondary index's byte
      // ranges are stale — rebuild the secondary indexes from the primary.
      // Concurrent reads hit a stale index together (startup runs queries in
      // parallel), so reconciliation is shared: one rebuild runs at a time,
      // and a read whose failure predates someone else's successful rebuild
      // retries instead of rethrowing its stale error.
      let reconcileGeneration = 0;
      let pendingReconcile;
      const reconcileOnce = () => {
        if (!pendingReconcile) {
          pendingReconcile = reconcileSecondaryIndexes(instance)
            .then((repaired) => {
              if (repaired === true) reconcileGeneration += 1;
              return repaired;
            })
            .finally(() => {
              pendingReconcile = undefined;
            });
        }
        return pendingReconcile;
      };

      const repairIndexedRead = async (error, generationAtStart) => {
        cleanIds.clear();
        const state = await instance.internals.statePromise;
        // Document repair and index reconciliation address independent damage
        // that can coexist in one failure, so a repaired document does not
        // skip the reconcile attempt — otherwise the single retry would fail
        // again on a still-stale index.
        const repairedDocuments = await repairMalformedIds(
          state.firstIdx.metaIdMap.keys(),
        );
        // A rebuild changes row offsets without emitting changelog operations,
        // so a multi-instance peer's stale in-memory rows could later persist
        // over it — only reconcile when this instance is the sole owner.
        let refusal = "multi-instance";
        if (!params.multiInstance) {
          try {
            const outcome = await reconcileOnce();
            if (outcome === true) return true;
            refusal = outcome;
          } catch (reconcileError) {
            refusal = `error ${reconcileError?.message ?? reconcileError}`;
          }
        }
        if (repairedDocuments) return true;
        if (reconcileGeneration !== generationAtStart) return true;
        error.message += `; index reconciliation refused: ${refusal}`;
        report("index-reconcile-refused", { target, reason: refusal });
        return false;
      };

      instance.query = async (preparedQuery) => {
        const generationAtStart = reconcileGeneration;
        try {
          return parseStorageResult(await query(preparedQuery));
        } catch (error) {
          if (
            !isMalformedJson(error) ||
            !(await repairIndexedRead(error, generationAtStart))
          ) {
            throw error;
          }
          return parseStorageResult(await query(preparedQuery));
        }
      };

      if (count)
        instance.count = async (preparedQuery) => {
          const result = await count(preparedQuery);
          if (
            result &&
            typeof result === "object" &&
            typeof result.count === "number"
          )
            return result;
          report("count-recovery", {
            target,
            detail: `typeof=${typeof result} result=${JSON.stringify(result)?.slice(0, 200)}`,
          });
          const queryResult = await instance.query(preparedQuery);
          const parsedResult =
            typeof queryResult === "string"
              ? JSON.parse(queryResult)
              : queryResult;
          // "fast" despite the query-derived path: the count is exact, and
          // reporting "slow" would trip rx-query's allowSlowCount gate (QU14),
          // defeating the recovery.
          return { count: parsedResult.documents.length, mode: "fast" };
        };

      instance.getChangedDocumentsSince = async (limit, checkpoint) => {
        const generationAtStart = reconcileGeneration;
        try {
          return parseStorageResult(
            await getChangedDocumentsSince(limit, checkpoint),
          );
        } catch (error) {
          if (
            !isMalformedJson(error) ||
            !(await repairIndexedRead(error, generationAtStart))
          ) {
            throw error;
          }
          return parseStorageResult(
            await getChangedDocumentsSince(limit, checkpoint),
          );
        }
      };

      if (!cleanup) return instance;
      // Cleanup trips on two damage shapes. A hollow row makes the compaction
      // walk dereference a missing document (a TypeError), which dropping the
      // whitespace rows resolves. A malformed record — garbage after a
      // tombstone's bytes — is a parse failure the whitespace pass cannot
      // touch, and the retry fails identically (Sentry WOOCOMMERCE-POS-2HC's
      // breadcrumb); that shape needs the same per-document repair the read
      // and write paths use, so it runs over every id before a last retry.
      const repairCleanupDamage = async (error) => {
        if (!isMalformedJson(error)) return false;
        cleanIds.clear();
        const state = await instance.internals.statePromise;
        return repairMalformedIds(state.firstIdx.metaIdMap.keys());
      };
      instance.cleanup = async (minimumDeletedTime) => {
        try {
          return await cleanup(minimumDeletedTime);
        } catch (initialError) {
          let failure;
          try {
            await dropWhitespaceRows(instance);
            return await cleanup(minimumDeletedTime);
          } catch (retryError) {
            failure = retryError;
          }
          try {
            if (await repairCleanupDamage(failure)) {
              return await cleanup(minimumDeletedTime);
            }
          } catch (repairError) {
            failure = repairError;
          }
          report("cleanup-recovery", {
            target,
            error: failure,
            initialError: String(initialError),
          });
          throw failure;
        }
      };

      return instance;
    },
  };
}

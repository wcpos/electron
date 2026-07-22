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

async function repairDocument(instance, documentId) {
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

    let accessHandlePromise = runState.accessHandlers.get(
      state.documentFileHandle,
    );
    if (!accessHandlePromise) {
      accessHandlePromise = state.documentFileHandle.createAccessHandle();
      runState.accessHandlers.set(
        state.documentFileHandle,
        accessHandlePromise,
      );
    }
    const accessHandle = await accessHandlePromise;
    const damagedBytes = await accessHandle.read(oldStart, oldEnd);
    const document = extractDocument(
      instance._decode(damagedBytes),
      instance.primaryPath,
      documentId,
    );
    if (!document) return "no-valid-document";
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

async function reconcileSecondaryIndexes(instance) {
  const state = await instance.internals.statePromise;
  return instance.taskQueue.runCleanup(async (runState) => {
    let accessHandlePromise = runState.accessHandlers.get(
      state.documentFileHandle,
    );
    if (!accessHandlePromise) {
      accessHandlePromise = state.documentFileHandle.createAccessHandle();
      runState.accessHandlers.set(
        state.documentFileHandle,
        accessHandlePromise,
      );
    }
    const accessHandle = await accessHandlePromise;
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
      const getChangedDocumentsSince =
        instance.getChangedDocumentsSince.bind(instance);

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

      const repairMalformedIds = async (ids, onMalformedBatch) => {
        const repairBatch = async (batch) => {
          try {
            parseStorageResult(await findDocumentsById(batch, true));
            return false;
          } catch (error) {
            if (!isMalformedJson(error)) throw error;
            if (params.multiInstance) {
              error.message += "; targeted recovery refused: multi-instance";
              throw error;
            }
            onMalformedBatch?.();
            if (batch.length === 1) {
              const failure = await repairDocument(instance, batch[0]);
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
        };
        return repairBatch([...new Set(ids)]);
      };

      instance.findDocumentsById = async (ids, withDeleted) => {
        try {
          const result = await findDocumentsById(ids, withDeleted);
          const documents =
            typeof result === "string" ? JSON.parse(result) : result;
          // A withDeleted read proves every requested id either parsed or is
          // absent — exactly what the write preflight establishes. Without
          // withDeleted the storage filters tombstones by index key alone,
          // never parsing their bytes, so only ids actually returned are
          // proven clean.
          if (withDeleted) {
            for (const id of ids) cleanIds.add(id);
          } else {
            for (const row of documents) {
              cleanIds.add(row[instance.primaryPath]);
            }
          }
          return result;
        } catch (error) {
          if (!isMalformedJson(error)) throw error;
          cleanIds.clear();
          if (await repairMalformedIds(ids))
            return parseStorageResult(
              await findDocumentsById(ids, withDeleted),
            );
          if (ids.length > 1) {
            const batches = await Promise.all(
              ids.map((id) => findDocumentsById([id], withDeleted)),
            );
            const documents = batches.flatMap((batch) =>
              typeof batch === "string" ? JSON.parse(batch) : batch,
            );
            return typeof batches[0] === "string"
              ? JSON.stringify(documents)
              : documents;
          }
          throw error;
        }
      };

      instance.bulkWrite = async (documentWrites, context) => {
        const ids = documentWrites.map(
          (row) => row.document[instance.primaryPath],
        );
        if (ids.some((id) => !cleanIds.has(id))) {
          let malformedBatch = false;
          await repairMalformedIds(ids, () => {
            malformedBatch = true;
            cleanIds.clear();
          });
          if (malformedBatch) {
            if (documentWrites.length > 1) {
              // Sequential on purpose: parallel singleton writes can
              // interleave revisions of the same document.
              const results = [];
              for (const row of documentWrites) {
                results.push(await bulkWrite([row], context));
              }
              await instance.taskQueue?.awaitIdle?.();
              return {
                error: results.flatMap((result) => result.error),
              };
            }
          } else {
            for (const id of ids) cleanIds.add(id);
          }
        }
        try {
          return await bulkWrite(documentWrites, context);
        } catch (error) {
          // A malformed failure here means stored bytes rotted after their
          // ids were verified — drop the cache so retries re-probe and can
          // repair instead of skipping the preflight forever.
          if (isMalformedJson(error)) cleanIds.clear();
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

      return instance;
    },
  };
}

# PR 2 of #2242 — implementation report

## Blocked on me

No implementation question remains. All four required items are implemented; nothing was pushed and no PR was created or edited.

- **Observed packaging blocker:** `pnpm exec electron-forge package` exited 1 during the existing `usb` native rebuild, before webpack bundling. Clang reported missing C++ type traits including `std::is_null_pointer_v` and `std::is_convertible_v` in `node-addon-api/napi.h`; `make` exited 2. No dependency/build-tool changes were made to work around it.
- **Credential warning:** Forge/node-gyp verbose output unexpectedly printed environment values containing credentials. Values are deliberately omitted here. The orchestrator should treat those credentials as exposed and rotate/revoke as appropriate before sharing build logs.
- **Orchestrator follow-up from the brief:** bump `.monorepo-ref` after the companion monorepo PR lands, then run real remote drift and packaged smoke checks.

## Changed

### Item 1 — engine (commit `fcc665b`)

- Added `createNodeSqliteBasics(root)` around premium's native adapter, with root creation, separator/traversal rejection, `.sqlite` filenames, WAL setup/read-back refusal, NORMAL synchronous mode, and connection close on setup failure.
- Main storage now uses premium SQLite with base64 attachments. New roots: development `sqlite-databases`, packaged `wcpos_sqlite`. Both legacy path exports remain.
- Removed the targeted recovery module, declaration, two tests, and shim. Removed repair telemetry and its test: inspection found only filesystem repair responsibilities, no non-repair telemetry to preserve.
- Removed `disableVersionCheck()`: the manifest pins rxdb and rxdb-premium to the same version.
- IPC transport, attachment codec, renderer tracking and boot ordering were left unchanged. Added SQLite ignore patterns.

### Item 2 — purge and paths (commit `892ed84`)

- Registered/preload-allowed `purgeLegacyDatabases`, returning removed paths and logging one info line. It removes the filesystem root and only regular legacy `.sqlite3` files/sidecars; it preserves image-cache, other files/directories, and the new store.
- Clear data includes all three roots and retains startup-before-storage sequencing.
- Storage measurement adds `sqlite` entries grouped by database, summing the main file/WAL/SHM; existing root categories remain.
- Tests cover missing roots, repeat calls, removed-path results, image-cache preservation, a live new SQLite connection remaining writable, Clear data, grouped bytes, and preload invocation.

### Item 3 — patch chain (commit `25be210`)

- Copied both SQLite query-translation files byte-for-byte from the specified monorepo worktree; both were present. No copy is pending.
- Removed all five retired patchers and their suites. Postinstall/build patching now runs only the SQLite translator patch, and package/make/publish retain their patch prefix.
- Drift checks compare the two copied files plus rxdb/rxdb-premium versions. `.monorepo-ref` is unchanged.
- No workflow named a deleted file; `.github/workflows/test.yml` needs no change.

### Item 4 — pins (final local commit containing this report)

- Main-storage test pins premium SQLite's name and `storeAttachmentsAsBase64String: true`, including the base64 conversion result.
- Runtime-externals test verifies no `node:sqlite` dependency, compiles a probe with the main target/externals, and checks it is an external module.
- Added a webpack target comment; no explicit SQLite external was necessary for the probe.
- **Observed scope:** 141 added + 61 removed authored/config non-test lines (202 changed), excluding prescribed whole-file deletions and the verbatim 190-line patch copy. No new locks, retry machinery, migration, or feature flags.

## Found

### Observed verification

Host Node: `v24.14.0`; Electron's bundled Node: `24.21.0`, with `DatabaseSync` present. SQLite experimental warnings occurred under the host Node.

All 29 current aggregate-map test files were invoked individually, sequentially; no aggregate test command was run:

| Command | Final result |
|---|---|
| `node --test scripts/rxdb-premium-sqlite-query-translation.test.mjs` | PASS (exit 0) |
| `node --test scripts/import-renderer.test.mjs` | PASS (exit 0) |
| `node --test scripts/smoke-packaged-app.test.mjs` | PASS (exit 0) |
| `pnpm exec ts-node src/main/http-bridge.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/cloudflare-challenge.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/preload.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/usb-model-reply.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/novu.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/printer-discovery.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/winspool-printer.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/rxdb-ipc-attachments.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/image-cache.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/external-window-isolation.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/frame-headers.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node --transpile-only test/package-runtime-externals.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/bluetooth-select.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/device-select.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/serial-printer.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/raw-print.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/print-raw-tcp.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/print-epos-http.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/boot.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node --files src/main/update.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/storage-measure.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node --files src/main/sentry-hygiene.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/log.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/sqlite-basics-node.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/rxdb-storage.test.ts` | PASS (exit 0) |
| `pnpm exec ts-node src/main/purge-legacy-databases.test.ts` | PASS (exit 0) |

Additional commands/checks:

| Command/check | Result |
|---|---|
| `pnpm run ts:check` | PASS, exit 0 after each item and at final verification |
| `pnpm run lint` | PASS, exit 0; 0 errors, 25 warnings on pre-existing lines, plus React-detection notice |
| `pnpm run patch:premium` | PASS, exit 0; ESM and CJS patched |
| `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -r ts-node/register src/main/sqlite-basics-node.test.ts` | PASS, exit 0 |
| `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -r ts-node/register src/main/rxdb-storage.test.ts` | PASS, exit 0 |
| Electron `-e` SQLite probe (DatabaseSync, in-memory integrity_check) | PASS, exit 0; integrity `ok` |
| `git diff --check` | PASS, exit 0 |
| `cmp` for each copied script against its specified monorepo source | PASS, both exit 0 |
| `rg` for retired module/patch names across `.github package.json src scripts` | PASS, exit 1 = no matches |
| Inline Node package-map assertions | PASS, exit 0; only new patch, build prefixes retained, every aggregate-map command points to an existing test |
| Temporary-fixture execution of `bash scripts/check-monorepo-drift.sh` with a local `gh` substitute | PASS: equal files/versions exit 0; changed patch exit 1; changed rxdb version exit 1 |
| `pnpm exec electron-forge package` | FAIL, exit 1; USB native compilation, as detailed above |

### Tests-first and intermediate results

- `pnpm exec ts-node src/main/sqlite-basics-node.test.ts`: initial exit 1 (adapter absent), then PASS after implementation.
- `pnpm exec ts-node src/main/rxdb-storage.test.ts`: initial harness runs exited 1 for ts-node loading the retired ESM module, then missing Sentry test stub. After correcting the harness, the old filesystem engine completed its write but failed the new SQLite-path assertion (exit 1). After the engine switch, PASS including direct row read and integrity_check through a fresh DatabaseSync connection.
- `pnpm exec ts-node src/main/purge-legacy-databases.test.ts`: initial exit 1 (handler absent); then exit 1 specifically on Clear data leaving the new root; PASS after adding that root.
- `pnpm exec ts-node src/main/storage-measure.test.ts`: baseline PASS; new grouped-SQLite fixture failed with missing entries (exit 1), then PASS.
- `pnpm exec ts-node src/preload.test.ts`: exit 1 because purge channel was forbidden; PASS after registry addition.
- `node --test scripts/rxdb-premium-sqlite-query-translation.test.mjs`: copied test initially exited 1 because its patcher had not yet been copied; after the verbatim copy, all 5 tests PASS before and after applying the patch. The translator itself was copied, not independently reimplemented.
- Inline package-map assertion initially failed against the five-patcher chain (exit 1), then passed against the replacement.
- Item 4 pins passed against the already-implemented item 1 settings. Temporarily changing the base64 flag to false made `pnpm exec ts-node src/main/rxdb-storage.test.ts` fail (exit 1); restored true and reran successfully.
- Initial item 1 lint exited 1 for six formatting errors in the new test. `pnpm exec eslint src/main/rxdb-storage.test.ts --fix` corrected them; subsequent full lint runs passed. Item 2 touched-source eslint formatting and item 4 test prettier formatting also exited 0.
- Independent read-only review: **no actionable findings; not over-scoped**. One review round, no fixes requested.

### Behavior changes / regressions

- **Observed intentional change:** fresh SQLite databases replace filesystem storage; there is no migration. Renderer-requested purge deletes retired databases after readiness. Clear data now also deletes the new root.
- **Observed intentional change:** filesystem recovery patches and their repair-only telemetry are removed; SQLite query translation replaces the patch chain.
- **Observed:** new storage acknowledged a row that remained present after close/reopen, with integrity_check `ok`, under host Node and Electron's bundled Node.
- **Not evaluated:** broad old/new behavioral equivalence, performance, live merchant data, process-stop durability trials, power-loss durability, GUI/packaged smoke, and full packaged bundling. The old and new engines were exercised by the narrow write/path test, not a compatibility or performance benchmark.
- **Unverified:** live remote drift at the existing pin. Fixture tests validate the script logic, not the companion merge or remote contents.
- Accepted risks remain the brief's ruled WAL/NORMAL power-loss tradeoff and transient measurement races while files grow; no additional caching/locking/retries were introduced.


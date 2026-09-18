// The recovery wrapper's byte-identical copy lives in src/main/ (drift-checked
// against wcpos/monorepo scripts/). The mirrored identity test imports it from
// its own directory, as it does in the monorepo, so this shim keeps that
// import valid here without duplicating the file.
export * from '../src/main/opfs-targeted-recovery.mjs';

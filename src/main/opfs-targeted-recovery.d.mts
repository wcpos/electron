/**
 * Type declaration for the byte-identical copy of the monorepo's
 * scripts/opfs-targeted-recovery.mjs (kept in sync by a monorepo test).
 * The wrapper returns the same storage shape it was given, with recovery
 * hooks patched onto each created storage instance.
 */
export declare function withTargetedOpfsRecovery<T>(storage: T): T;

/**
 * Type declaration for the byte-identical copy of the monorepo's
 * scripts/opfs-targeted-recovery.mjs (kept in sync by a monorepo test).
 * The wrapper returns the same storage shape it was given, with recovery
 * hooks patched onto each created storage instance.
 */
export interface TargetedOpfsRecoveryOptions {
	/**
	 * Whether this process may perform positional repairs for the instance
	 * described by `params`. Defaults to `!params.multiInstance`, which is what
	 * the single-instance main process relies on.
	 */
	ownsRepairs?: (params: { databaseName: string; multiInstance?: boolean }) => boolean;
	/** Called with every storage instance the wrapper creates (used by the web worker). */
	onInstance?: (instance: unknown, params: { databaseName: string }) => void;
}
export declare function withTargetedOpfsRecovery<T>(
	storage: T,
	options?: TargetedOpfsRecoveryOptions
): T;

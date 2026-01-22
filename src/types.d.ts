// Webpack constants provided by electron-forge
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;

// Type declarations for packages without @types
declare module 'semver' {
	export function gt(
		v1: string | ReturnType<typeof coerce>,
		v2: string | ReturnType<typeof coerce>
	): boolean;
	export function coerce(version: string | null | undefined): { version: string } | null;
}

// Augment electron-store to expose get/set methods properly
declare module 'electron-store' {
	export default class Store<T extends Record<string, unknown> = Record<string, unknown>> {
		constructor(options?: { defaults?: Partial<T> });
		get<K extends keyof T>(key: K, defaultValue?: T[K]): T[K];
		get(key: string, defaultValue?: unknown): unknown;
		set<K extends keyof T>(key: K, value: T[K]): void;
		set(key: string, value: unknown): void;
		delete<K extends keyof T>(key: K): void;
		clear(): void;
		has<K extends keyof T>(key: K): boolean;
		onDidChange<K extends keyof T>(
			key: K,
			callback: (newValue?: T[K], oldValue?: T[K]) => void
		): () => void;
		readonly store: T;
		readonly path: string;
		readonly size: number;
	}
}

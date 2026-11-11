import semver from 'semver';

// The first app major that needs a newer macOS than the one before it, with that macOS.
// 2.0 ships Electron 45, whose binaries need macOS 13.0 (Mach-O minos and LSMinimumSystemVersion;
// #606, 9 Nov 2026). Squirrel.Mac does not check this before swapping the bundle, so the
// updater must.
export const MACOS_FLOORS: readonly { fromMajor: number; minMacos: string }[] = [
	{ fromMajor: 2, minMacos: '13.0' },
];

// The macOS an update to `offeredVersion` needs, or undefined when it needs nothing newer.
// A string `manifestMinimum` that semver.coerce can read wins over the table. Otherwise the
// highest MACOS_FLOORS entry whose fromMajor <= the offered major applies.
export function requiredMacos(
	offeredVersion: string,
	manifestMinimum?: unknown
): string | undefined {
	if (typeof manifestMinimum === 'string' && semver.coerce(manifestMinimum)) {
		return manifestMinimum;
	}
	const offered = semver.coerce(offeredVersion);
	if (!offered) return undefined;
	let floor: (typeof MACOS_FLOORS)[number] | undefined;
	for (const entry of MACOS_FLOORS) {
		// fromMajor <= offered major, i.e. the offered version is at least fromMajor.0.0.
		if (semver.gt(semver.coerce(String(entry.fromMajor)), offered)) continue;
		if (!floor || entry.fromMajor > floor.fromMajor) floor = entry;
	}
	return floor?.minMacos;
}

// The required macOS when this Mac (`systemVersion`, e.g. '12.7.6') is older than it.
// Otherwise null, including when systemVersion is missing or unreadable (fail open).
export function macosTooOld(
	offeredVersion: string,
	systemVersion: string | undefined,
	manifestMinimum?: unknown
): string | null {
	const current = semver.coerce(systemVersion);
	if (!current) return null;
	const required = requiredMacos(offeredVersion, manifestMinimum);
	if (!required) return null;
	// semver.lt(current, required), written as gt: src/types.d.ts declares only gt and coerce.
	return semver.gt(semver.coerce(required), current) ? required : null;
}

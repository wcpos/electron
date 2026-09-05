import { logger, Sentry } from './log';

/**
 * Sentry reporting for the filesystem-node storage's repair machinery.
 *
 * The rxdb-premium patches and the targeted recovery wrapper report through
 * `globalThis` seams (console fallback when nothing is installed):
 *
 *   - `__wcposOnStorageRunFailure` — a task-queue run threw (containment patch)
 *   - `__wcposOnIndexRebuild` — boot rebuilt the indexes from documents.json
 *   - `__wcposOnStorageRecovery` — every other repair or refusal, keyed by `kind`
 *
 * Each becomes one `RxdbStorageEvent` whose message is the stable code alone —
 * never the underlying error text, which carries file offsets and would split
 * one defect into an issue per install — with a redacted copy of the original
 * error as `cause`, the collection as a tag and the details as extra, so a
 * class of damage can be tracked per release under the `rxdb-fs` subsystem.
 */
const SUBSYSTEM = 'rxdb-fs';
const capturedEvents = new Set<string>();

/**
 * The kind vocabulary and how each reports. The producers cannot import this
 * (the wrapper is a byte-locked copy of a monorepo file; the patch prelude is
 * a minified string), so this is the registry: a kind missing here reports at
 * `error`, which is the safe default for anything unrecognised.
 *
 *   - healed outcomes and disposable log-row discards are warnings
 *   - refusals, other discards and terminal failures are errors: data or a write was
 *     lost, or a run died
 */
export const KIND_LEVELS: Readonly<Record<string, 'warning' | 'error'>> = {
	'index-rebuilt': 'warning',
	'changes-file-salvage': 'warning',
	'hollow-row-dropped': 'warning',
	'log-row-discarded': 'warning',
	'stale-secondary-dropped': 'warning',
	'count-recovery': 'warning',
	'changes-file-discarded': 'error',
	'hollow-row-refused': 'error',
	'stale-secondary-refused': 'error',
	'index-reconcile-refused': 'error',
	'cleanup-recovery': 'error',
	'task-queue-run-failed': 'error',
};

export class RxdbStorageEvent extends Error {
	// Declared rather than passed to super(): the project's TS lib predates
	// ES2022's `Error.cause`; Sentry's linked-errors integration reads the
	// property either way.
	readonly cause?: unknown;

	constructor(
		readonly code: string,
		readonly target: string,
		cause?: unknown
	) {
		super(`${SUBSYSTEM} ${code}`);
		this.name = 'RxdbStorageEvent';
		if (cause !== undefined) this.cause = cause;
	}
}

type Capture = typeof Sentry.captureException;

interface RunFailure {
	target: string;
	error: unknown;
}

interface IndexRebuild {
	target: string;
	reason: string;
	documents: number;
}

interface RecoveryEvent {
	kind: string;
	target?: string;
	error?: unknown;
	[detail: string]: unknown;
}

type StorageSeams = typeof globalThis & {
	__wcposOnStorageRunFailure?: (failure: RunFailure) => void;
	__wcposOnIndexRebuild?: (rebuild: IndexRebuild) => void;
	__wcposOnStorageRecovery?: (event: RecoveryEvent) => void;
};

/**
 * V8 quotes a slice of the input in some parse failures (`Unexpected token
 * 'x', "…" is not valid JSON`), and a damaged storage file's input is
 * merchant data — JSON, so the slice itself contains quotes. Everything from
 * the first double quote to the last is blanked; offsets, names and reason
 * codes survive.
 */
const QUOTED_SPAN = /"[\s\S]*"/;

function redact(text: string) {
	return text.replace(QUOTED_SPAN, '"…"');
}

function describe(error: unknown) {
	if (error instanceof Error) return `${error.name}: ${redact(error.message)}`;
	return error === undefined ? undefined : redact(String(error));
}

/** A copy of the error safe to ship as a linked exception: same name and frames, redacted message. */
function redactedCause(error: unknown) {
	if (!(error instanceof Error)) return describe(error);
	const cause = new Error(redact(error.message));
	cause.name = error.name;
	const frames = (error.stack ?? '').split('\n').slice(1).join('\n');
	cause.stack = `${cause.name}: ${cause.message}\n${frames}`;
	return cause;
}

function redactDetails(details: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(details).map(([key, value]) => [
			key,
			typeof value === 'string' ? redact(value) : value,
		])
	);
}

function report(
	code: string,
	target: string,
	details: Record<string, unknown>,
	error: unknown,
	capture: Capture
) {
	const event = new RxdbStorageEvent(code, target, redactedCause(error));
	const level = KIND_LEVELS[code] ?? 'error';
	const collection = target.split('/')[1] ?? 'unknown';
	const extra = { target, ...redactDetails(details), cause: describe(error) };
	logger[level === 'error' ? 'error' : 'warn'](`[${SUBSYSTEM}] ${code}`, extra);
	const key = JSON.stringify([code, target, details.id ?? describe(error)]);
	if (capturedEvents.has(key)) return;
	capturedEvents.add(key);
	return capture(event, {
		level,
		tags: {
			subsystem: SUBSYSTEM,
			[`${SUBSYSTEM}.code`]: code,
			[`${SUBSYSTEM}.collection`]: collection,
		},
		fingerprint: [SUBSYSTEM, code],
		extra,
	});
}

export function installRxdbStorageTelemetry(capture: Capture = Sentry.captureException) {
	const seams = globalThis as StorageSeams;
	seams.__wcposOnStorageRunFailure = ({ target, error }) =>
		report('task-queue-run-failed', target, {}, error, capture);
	seams.__wcposOnIndexRebuild = ({ target, reason, documents }) =>
		report('index-rebuilt', target, { reason, documents }, undefined, capture);
	seams.__wcposOnStorageRecovery = ({ kind, target = 'unknown', error, ...details }) =>
		report(kind, target, details, error, capture);
}

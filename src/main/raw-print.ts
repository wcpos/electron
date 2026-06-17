import { logger } from './log';

export interface RawPrintContext {
	settled: () => boolean;
}

export interface Delivery {
	/** Open/write the resource. cleanup() is always invoked by withTimeout. */
	send(bytes: Buffer, ctx: RawPrintContext): Promise<void> | void;
	cleanup(): Promise<void> | void;
	timeoutMs: number;
	label: string;
	operation?: string;
	timeoutMessage?: string;
	successMessage?: (bytes: number) => string;
	failureMessage?: (err: Error) => string;
}

export function validateRawPrintData(data: unknown): number[] {
	if (!Array.isArray(data) || !data.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
		throw new Error('Invalid data: must be an array of byte values (0-255)');
	}
	return data;
}

export function rawPrintBufferFromData(data: unknown): Buffer {
	return Buffer.from(validateRawPrintData(data));
}

export async function sendRawPrint(args: { data: unknown }, delivery: Delivery): Promise<void> {
	const bytes = rawPrintBufferFromData(args.data);
	await sendRawBytes(bytes, delivery);
}

export async function sendRawBytes(bytes: Buffer, delivery: Delivery): Promise<void> {
	const operation = delivery.operation ?? 'raw-print';
	try {
		await withTimeout(
			async (ctx) => {
				await delivery.send(bytes, ctx);
			},
			() => delivery.cleanup(),
			delivery.timeoutMs,
			delivery.timeoutMessage ??
				`${operation} to ${delivery.label} timed out after ${delivery.timeoutMs}ms`
		);
		logger.info(
			delivery.successMessage?.(bytes.length) ??
				`${operation} sent ${bytes.length} bytes to ${delivery.label}`
		);
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error(
			delivery.failureMessage?.(error) ??
				`${operation} to ${delivery.label} failed: ${error.message}`
		);
		throw err;
	}
}

// Resolves/rejects exactly once; always clears the timer; always runs cleanup. If the
// timeout wins but run() later settles (for example, a resource opens after timeout),
// cleanup runs again so the newly-opened resource is released without writing.
export function withTimeout<T>(
	run: (ctx: RawPrintContext) => Promise<T>,
	cleanup: () => Promise<void> | void,
	ms: number,
	onTimeoutMessage: string
): Promise<T> {
	let settled = false;
	let timedOut = false;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const ctx: RawPrintContext = { settled: () => settled };

	const runCleanup = (): Promise<void> => Promise.resolve().then(cleanup);

	return new Promise<T>((resolve, reject) => {
		const finish = (hasError: boolean, payload?: unknown): void => {
			if (settled) return;
			settled = true;
			if (timeoutHandle !== undefined) {
				clearTimeout(timeoutHandle);
				timeoutHandle = undefined;
			}
			runCleanup().then(
				() => {
					if (hasError) {
						reject(payload);
					} else {
						resolve(payload as T);
					}
				},
				(cleanupErr) => {
					reject(hasError ? payload : cleanupErr);
				}
			);
		};

		timeoutHandle = setTimeout(() => {
			timedOut = true;
			finish(true, new Error(onTimeoutMessage));
		}, ms);

		let runPromise: Promise<T>;
		try {
			runPromise = Promise.resolve(run(ctx));
		} catch (err) {
			finish(true, err);
			return;
		}

		runPromise.then(
			(value) => {
				if (settled) {
					if (timedOut) void runCleanup().catch(() => {});
					return;
				}
				finish(false, value);
			},
			(err) => {
				if (settled) {
					if (timedOut) void runCleanup().catch(() => {});
					return;
				}
				finish(true, err);
			}
		);
	});
}

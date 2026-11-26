import assert from 'node:assert/strict';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

// ── Fake electron-store ───────────────────────────────────────────────────────
class FakeStore {
	private map = new Map<string, unknown>();
	store: Record<string, unknown> = {};

	get(key: string) {
		return this.map.get(key);
	}

	set(key: string, value: unknown) {
		this.map.set(key, value);
	}

	delete(key: string) {
		this.map.delete(key);
	}
}

// ── Fake logger ───────────────────────────────────────────────────────────────
const logged: { level: string; message: string }[] = [];
const record = (level: string) => (message: string) => {
	logged.push({ level, message });
};
const fakeLogger = {
	debug: record('debug'),
	info: record('info'),
	warn: record('warn'),
	error: record('error'),
};

// ── Module patching ───────────────────────────────────────────────────────────
const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return { app: { getPreferredSystemLanguages: () => ['ja'] } };
	if (request === 'electron-store') return { __esModule: true, default: FakeStore };
	if (request === '../log') return { logger: fakeLogger };
	return originalLoad.call(this, request, parent, isMain);
};

// ── Fake fetch: never resolves unless its signal aborts ───────────────────────
const fetchCalls: string[] = [];
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
	fetchCalls.push(String(url));
	return new Promise((_resolve, reject) => {
		init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
	});
}) as typeof fetch;

async function main() {
	const { loadTranslations } = require('./index') as typeof import('./index');

	let raceTimer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<'timeout'>((resolve) => {
		raceTimer = setTimeout(() => resolve('timeout'), 8000);
	});
	const winner = await Promise.race([loadTranslations().then(() => 'settled' as const), timedOut]);
	clearTimeout(raceTimer);

	const message =
		'loadTranslations settles within the timeout when the CDN fetch never resolves on a pinned version';
	assert.equal(winner, 'settled', message);
	assert.equal(fetchCalls.length, 1, message);
	assert.ok(
		logged.some(
			(entry) => entry.level === 'error' && entry.message.includes('Failed to fetch translations')
		),
		message
	);

	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

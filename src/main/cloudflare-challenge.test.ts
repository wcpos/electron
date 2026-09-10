import assert from 'assert/strict';
import Module from 'module';

type CookieLike = { name: string; value: string };

type ChallengeWindow = {
	loadURL(url: string): Promise<void>;
	show(): void;
	close(): void;
	isDestroyed(): boolean;
	once(event: 'closed', listener: () => void): unknown;
	webContents: {
		isLoading(): boolean;
		getTitle(): string;
		once(event: 'did-finish-load', listener: () => void): unknown;
	};
};

type ChallengeModule = {
	isChallengeResponse(headers: { get(name: string): string | null }): boolean;
	createChallengeClearer(deps: {
		getCookies(url: string): Promise<CookieLike[]>;
		createWindow(host: string): ChallengeWindow;
		silentSolveMs?: number;
		interactiveSolveMs?: number;
		failureCooldownMs?: number;
		pollMs?: number;
		settleMs?: number;
	}): {
		cookieHeaderFor(url: string): Promise<string | undefined>;
		clear(url: string): Promise<boolean>;
	};
};

const warnCalls: unknown[][] = [];
const loggerMock = {
	info() {},
	warn(...args: unknown[]) {
		warnCalls.push(args);
	},
	error() {},
	debug() {},
};

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	// Deps are injected; the real module must not touch electron at load time.
	if (request === 'electron') return {};
	if (request === './log') return { logger: loggerMock };
	return originalLoad.call(this, request, parent, isMain);
};

class FakeWindow implements ChallengeWindow {
	static created: FakeWindow[] = [];
	shown = false;
	closed = false;
	loadedUrl = '';
	title = 'Just a moment...';
	loading = true;
	private closedListeners: (() => void)[] = [];
	private loadListeners: (() => void)[] = [];

	constructor(public host: string) {
		FakeWindow.created.push(this);
	}
	loadURL(url: string) {
		this.loadedUrl = url;
		return Promise.resolve();
	}
	show() {
		this.shown = true;
	}
	close() {
		this.closed = true;
		this.closedListeners.forEach((listener) => listener());
	}
	isDestroyed() {
		return this.closed;
	}
	once(_event: 'closed', listener: () => void) {
		this.closedListeners.push(listener);
	}
	webContents = {
		isLoading: () => this.loading,
		getTitle: () => this.title,
		once: (_event: 'did-finish-load', listener: () => void) => {
			this.loadListeners.push(listener);
		},
	};
	finishLoad(title: string) {
		this.title = title;
		this.loading = false;
		this.loadListeners.forEach((listener) => listener());
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const STORE = 'https://store.test/wp-json/wcpos/v1/products';

async function main() {
	try {
		delete require.cache[require.resolve('./cloudflare-challenge')];
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require('./cloudflare-challenge') as ChallengeModule;

		assert.equal(mod.isChallengeResponse(new Headers({ 'cf-mitigated': 'challenge' })), true);
		assert.equal(mod.isChallengeResponse(new Headers({ 'cf-mitigated': 'Challenge ' })), true);
		assert.equal(mod.isChallengeResponse(new Headers({})), false);
		assert.equal(mod.isChallengeResponse(new Headers({ server: 'cloudflare' })), false);

		// cookieHeaderFor forwards only Cloudflare's cookies.
		let jar: CookieLike[] = [];
		// Real timers: budgets are an order of magnitude above the sleeps so a
		// loaded CI runner cannot turn a margin into a flake.
		const timing = {
			silentSolveMs: 40,
			interactiveSolveMs: 400,
			failureCooldownMs: 200,
			pollMs: 5,
			settleMs: 1,
		};
		let createWindow = (host: string): ChallengeWindow => new FakeWindow(host);
		const clearer = mod.createChallengeClearer({
			getCookies: async () => jar,
			createWindow: (host) => createWindow(host),
			...timing,
		});
		assert.equal(await clearer.cookieHeaderFor(STORE), undefined);
		jar = [
			{ name: 'wordpress_logged_in_abc', value: 'nope' },
			{ name: 'cf_clearance', value: 'tok' },
			{ name: '__cf_bm', value: 'bm' },
		];
		assert.equal(await clearer.cookieHeaderFor(STORE), 'cf_clearance=tok; __cf_bm=bm');

		// Silent solve: the window is never shown, concurrent callers share it,
		// and it is closed afterwards.
		jar = [];
		FakeWindow.created.length = 0;
		const first = clearer.clear(STORE);
		const second = clearer.clear('https://store.test/wp-json/wcpos/v1/orders');
		await sleep(15);
		assert.equal(FakeWindow.created.length, 1, 'one window per origin');
		assert.equal(FakeWindow.created[0].host, 'store.test');
		assert.equal(FakeWindow.created[0].loadedUrl, STORE);
		jar = [{ name: 'cf_clearance', value: 'minted' }];
		assert.deepEqual(await Promise.all([first, second]), [true, true]);
		assert.equal(FakeWindow.created[0].shown, false, 'silent solve never shows the window');
		assert.equal(FakeWindow.created[0].closed, true, 'window closed after solve');

		// Interactive: nothing within the silent budget shows the window; a
		// cookie minted afterwards still clears.
		FakeWindow.created.length = 0;
		warnCalls.length = 0;
		const interactive = clearer.clear(STORE);
		await sleep(70);
		assert.equal(FakeWindow.created[0].shown, true, 'window shown once the silent budget passes');
		jar = [{ name: 'cf_clearance', value: 'minted-by-cashier' }];
		assert.equal(await interactive, true);
		assert.equal(FakeWindow.created[0].closed, true);

		// A page that settles on a non-challenge title with a cookie present
		// (the edge re-issued the same value) counts as cleared.
		FakeWindow.created.length = 0;
		const settledSolve = clearer.clear(STORE);
		await sleep(10);
		FakeWindow.created[0].finishLoad('store.test/wp-json/');
		assert.equal(await settledSolve, true);

		// Never solved: false at the interactive deadline, then a cooldown that
		// refuses to open another window.
		jar = [];
		FakeWindow.created.length = 0;
		assert.equal(await clearer.clear(STORE), false);
		assert.equal(FakeWindow.created.length, 1);
		assert.equal(FakeWindow.created[0].closed, true);
		assert.equal(await clearer.clear(STORE), false, 'cooldown');
		assert.equal(FakeWindow.created.length, 1, 'cooldown opens no window');
		await sleep(250);
		const afterCooldown = clearer.clear(STORE);
		await sleep(10);
		assert.equal(FakeWindow.created.length, 2, 'cooldown expired');
		jar = [{ name: 'cf_clearance', value: 'again' }];
		assert.equal(await afterCooldown, true);

		// The interactive budget runs from the moment the window is shown, not
		// from the start of the solve: a cookie minted late still clears.
		await sleep(250);
		FakeWindow.created.length = 0;
		const late = clearer.clear(STORE);
		await sleep(timing.silentSolveMs + timing.interactiveSolveMs - 60);
		assert.equal(FakeWindow.created[0].closed, false, 'still open inside the shown budget');
		jar = [{ name: 'cf_clearance', value: 'late' }];
		assert.equal(await late, true);

		// Window construction failing is an unsolved challenge, not a rejection,
		// and starts the cooldown like any other failure.
		await sleep(250);
		jar = [];
		FakeWindow.created.length = 0;
		createWindow = () => {
			throw new Error('no display');
		};
		assert.equal(await clearer.clear(STORE), false);
		assert.equal(FakeWindow.created.length, 0);
		createWindow = (host) => new FakeWindow(host);
		assert.equal(await clearer.clear(STORE), false, 'cooldown after a construction failure');
		assert.equal(FakeWindow.created.length, 0);
		await sleep(250);

		// Cashier closes the window: false, no crash on double close.
		jar = [];
		FakeWindow.created.length = 0;
		const dismissed = clearer.clear(STORE);
		await sleep(10);
		FakeWindow.created[0].close();
		assert.equal(await dismissed, false);

		// Unparseable URL never opens a window.
		FakeWindow.created.length = 0;
		assert.equal(await clearer.clear('not a url'), false);
		assert.equal(FakeWindow.created.length, 0);

		console.log('SUITE-COMPLETE');
	} finally {
		mutableModule._load = originalLoad;
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

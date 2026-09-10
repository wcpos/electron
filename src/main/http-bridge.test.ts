import assert from 'assert/strict';
import Module from 'module';

type FetchImpl = typeof import('electron').net.fetch;

type BridgeConfig = {
	url?: string;
	baseURL?: string;
	method?: string;
	headers?: Record<string, string>;
	params?: Record<string, unknown>;
	data?: unknown;
	auth?: { username?: string; password?: string };
	timeout?: number;
	validateStatus?: null;
	responseType?: 'text' | 'arraybuffer';
};

type BridgeMessage =
	| { type: 'request'; requestId?: string; config: BridgeConfig }
	| { type: 'cancel'; requestId: string };

type BridgeResult = {
	success: boolean;
	data?: unknown;
	status?: number;
	statusText?: string;
	headers?: Record<string, string>;
	code?: string;
	name?: string;
	message?: string;
	response?: { data: unknown; status: number; headers: Record<string, string> };
};

type AxiosHandler = (event: unknown, message: BridgeMessage) => Promise<BridgeResult>;

type ChallengeClearer = {
	cookieHeaderFor(url: string): Promise<string | undefined>;
	clear(url: string): Promise<boolean>;
};

type AxiosModule = {
	createAxiosChannelHandler(fetchImpl?: FetchImpl, clearer?: ChallengeClearer): AxiosHandler;
};

// Cloudflare clearance stand-in: no cookies and nothing to solve unless a test
// says otherwise, so existing scenarios see the bridge exactly as before.
const clearerCalls: { cookieHeaderFor: string[]; clear: string[] } = {
	cookieHeaderFor: [],
	clear: [],
};
let clearerCookie: string | undefined;
let clearerSolves = false;
let clearerHangs = false;
const fakeClearer: ChallengeClearer = {
	async cookieHeaderFor(url) {
		clearerCalls.cookieHeaderFor.push(url);
		return clearerCookie;
	},
	async clear(url) {
		clearerCalls.clear.push(url);
		if (clearerHangs) return new Promise<boolean>(() => undefined);
		if (clearerSolves) clearerCookie = 'cf_clearance=minted';
		return clearerSolves;
	},
};
const challengeResponse = () =>
	new Response('<!DOCTYPE html><title>Just a moment...</title>', {
		status: 403,
		headers: { 'Content-Type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' },
	});

let registeredHandler: AxiosHandler | undefined;
let responder: (url: string, init?: RequestInit) => Promise<Response> | Response = () =>
	new Response(JSON.stringify({ products: [] }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
const fetchCalls: { url: string; init?: RequestInit }[] = [];
const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
	const url = String(input);
	fetchCalls.push({ url, init });
	return Promise.resolve(responder(url, init));
}) as FetchImpl;

const debugCalls: unknown[][] = [];
const errorCalls: unknown[][] = [];

const electronMock = {
	ipcMain: {
		handle(channel: string, handler: AxiosHandler) {
			assert.equal(channel, 'http-request');
			registeredHandler = handler;
		},
	},
	net: { fetch: fakeFetch },
};

const warnCalls: unknown[][] = [];
const loggerMock = {
	debug(...args: unknown[]) {
		debugCalls.push(args);
	},
	warn(...args: unknown[]) {
		warnCalls.push(args);
	},
	error(...args: unknown[]) {
		errorCalls.push(args);
	},
};

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
const originalNodeEnv = process.env.NODE_ENV;
const originalLogHttpBodies = process.env.WCPOS_LOG_HTTP_BODIES;

mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return electronMock;
	if (request === './log') return { logger: loggerMock };
	if (request === './util') return { isDevelopment: true };
	return originalLoad.call(this, request, parent, isMain);
};

function loadAxiosModule(): AxiosModule {
	delete require.cache[require.resolve('./http-bridge')];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require('./http-bridge') as AxiosModule;
}

function resetCalls(): void {
	fetchCalls.length = 0;
	clearerCalls.cookieHeaderFor.length = 0;
	clearerCalls.clear.length = 0;
	clearerCookie = undefined;
	clearerSolves = false;
	clearerHangs = false;
	debugCalls.length = 0;
	errorCalls.length = 0;
}

async function main() {
	process.env.NODE_ENV = 'production';
	delete process.env.WCPOS_LOG_HTTP_BODIES;

	try {
		const axiosModule = loadAxiosModule();
		assert.ok(registeredHandler, 'http-request IPC handler should be registered');
		let handler = axiosModule.createAxiosChannelHandler(fakeFetch, fakeClearer);

		const success = await handler(undefined, {
			type: 'request',
			config: {
				method: 'get',
				baseURL: 'https://store.test/wp-json/wcpos/v2',
				url: 'products?token=success-secret',
			},
		});

		assert.deepEqual(success, {
			success: true,
			data: { products: [] },
			status: 200,
			statusText: '',
			headers: { 'content-type': 'application/json' },
			config: {
				url: 'products?token=success-secret',
				method: 'get',
				baseURL: 'https://store.test/wp-json/wcpos/v2',
				headers: undefined,
			},
			request: null,
		});
		assert.equal(
			fetchCalls[0]?.url,
			'https://store.test/wp-json/wcpos/v2/products?token=success-secret'
		);
		assert.deepEqual(debugCalls, [['GET products → 200']]);
		assert.ok(!JSON.stringify(debugCalls).includes('success-secret'));

		resetCalls();
		process.env.WCPOS_LOG_HTTP_BODIES = '1';
		registeredHandler = undefined;
		handler = loadAxiosModule().createAxiosChannelHandler(fakeFetch, fakeClearer);
		assert.ok(registeredHandler, 'http-request IPC handler should be re-registered');

		await handler(undefined, {
			type: 'request',
			config: {
				method: 'get',
				baseURL: 'https://store.test/wp-json/wcpos/v2',
				url: 'products?token=success-secret',
			},
		});

		assert.equal(debugCalls.length, 2, 'opt-in should retain the success body log');
		assert.equal(debugCalls[0]?.[0], 'GET products → 200');
		assert.match(String(debugCalls[1]?.[0]), /"products": \[\]/);
		assert.ok(!JSON.stringify(debugCalls).includes('success-secret'));

		resetCalls();
		responder = () =>
			new Response(JSON.stringify({ reason: 'server failure' }), {
				status: 500,
				statusText: 'Internal Server Error',
				headers: { 'Content-Type': 'application/json' },
			});
		const serverError = await handler(undefined, {
			type: 'request',
			config: {
				method: 'get',
				baseURL: 'https://store.test/wp-json/wcpos/v2',
				url: 'orders?token=failure-secret',
			},
		});

		assert.equal(serverError.code, 'ERR_BAD_RESPONSE');
		assert.equal(serverError.response?.status, 500);
		assert.equal(debugCalls.length, 2, 'development failures should retain both body logs');
		assert.match(String(debugCalls[0]?.[0]), /^GET orders FAILED$/);
		assert.match(String(debugCalls[1]?.[0]), /^GET orders ERROR /);
		assert.match(String(debugCalls[1]?.[0]), /"reason": "server failure"/);
		assert.deepEqual(errorCalls, [
			[
				'HTTP error',
				{
					status: 500,
					message: 'Request failed with status code 500',
					request: 'GET orders',
				},
			],
		]);
		assert.ok(!JSON.stringify([debugCalls, errorCalls]).includes('failure-secret'));

		resetCalls();
		responder = () => new Response('ok');
		await handler(undefined, {
			type: 'request',
			config: {
				baseURL: 'https://ignored.test/api',
				url: 'https://absolute.test/items?existing=yes',
				params: { include: [1, 2], empty: null },
			},
		});
		assert.equal(
			fetchCalls[0]?.url,
			'https://absolute.test/items?existing=yes&include%5B%5D=1&include%5B%5D=2'
		);

		// axios-parity serialization: nested objects flatten to name[key], spaces
		// become +, colons stay literal, fragments are dropped (matches axios 1.19
		// getUri output, verified against the real library).
		resetCalls();
		responder = () => new Response('ok');
		await handler(undefined, {
			type: 'request',
			config: {
				url: 'https://store.test/items#section',
				params: { filter: { status: 'open' }, s: 'a b', colon: 'a:b' },
			},
		});
		assert.equal(
			fetchCalls[0]?.url,
			'https://store.test/items?filter%5Bstatus%5D=open&s=a+b&colon=a:b'
		);

		// config.auth becomes a Basic Authorization header (axios behavior).
		resetCalls();
		await handler(undefined, {
			type: 'request',
			config: {
				url: 'https://store.test/private',
				auth: { username: 'user', password: 'pass' },
			},
		});
		assert.equal(
			(fetchCalls[0]?.init?.headers as Headers).get('authorization'),
			`Basic ${Buffer.from('user:pass').toString('base64')}`
		);

		// GET/HEAD bodies are dropped (fetch rejects them; the web XHR lane never
		// sent them either) instead of failing the request with ERR_NETWORK.
		resetCalls();
		const getWithBody = await handler(undefined, {
			type: 'request',
			config: { method: 'get', url: 'https://store.test/search', data: { q: 'x' } },
		});
		assert.equal(getWithBody.success, true);
		assert.equal(fetchCalls[0]?.init?.body, undefined);

		// A string timeout (axios coerces at runtime) must not reject the IPC
		// promise — it normalizes and still resolves the timeout failure shape.
		resetCalls();
		responder = (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
					once: true,
				});
			});
		const stringTimeoutKeepAlive = setTimeout(() => {}, 5_000);
		const stringTimeout = await handler(undefined, {
			type: 'request',
			config: { url: 'https://store.test/slow', timeout: '50' as unknown as number },
		});
		clearTimeout(stringTimeoutKeepAlive);
		assert.equal(stringTimeout.code, 'ECONNABORTED');

		// A NONNUMERIC timeout is rejected the way axios rejects it (verified
		// against axios 1.19), still via the always-resolve failure shape.
		resetCalls();
		responder = () => new Response('ok');
		const badTimeout = await handler(undefined, {
			type: 'request',
			config: { url: 'https://store.test/x', timeout: 'abc' as unknown as number },
		});
		assert.equal(badTimeout.success, false);
		assert.equal(badTimeout.code, 'ERR_BAD_OPTION_VALUE');
		assert.equal(badTimeout.message, 'error trying to parse `config.timeout` to int');
		assert.equal(fetchCalls.length, 0, 'invalid timeout must not issue the request');

		resetCalls();
		responder = () => new Response('missing', { status: 404 });
		const accepted404 = await handler(undefined, {
			type: 'request',
			config: { url: 'https://store.test/missing', validateStatus: null },
		});
		assert.equal(accepted404.success, true);
		assert.equal(accepted404.status, 404);

		const rejected404 = await handler(undefined, {
			type: 'request',
			config: { url: 'https://store.test/missing' },
		});
		assert.equal(rejected404.success, false);
		assert.equal(rejected404.code, 'ERR_BAD_REQUEST');
		assert.equal(rejected404.response?.status, 404);

		resetCalls();
		responder = (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
					once: true,
				});
			});
		// AbortSignal.timeout uses an UNREF'D timer: with nothing else pending, node's
		// loop drains and the process exits 0 mid-suite before the 50ms fires. A ref'd
		// timer holds the loop open so the timeout path can actually run.
		const keepEventLoopAlive = setTimeout(() => {}, 5_000);
		const timeout = await handler(undefined, {
			type: 'request',
			requestId: 'timeout',
			config: { url: 'https://store.test/slow', timeout: 50 },
		});
		clearTimeout(keepEventLoopAlive);
		assert.equal(timeout.code, 'ECONNABORTED');
		assert.equal(timeout.name, 'AxiosError');
		assert.equal(timeout.message, 'timeout of 50ms exceeded');

		const pending = handler(undefined, {
			type: 'request',
			requestId: 'cancel',
			config: { url: 'https://store.test/slow' },
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(await handler(undefined, { type: 'cancel', requestId: 'cancel' }), {
			success: true,
		});
		const canceled = await pending;
		assert.equal(canceled.code, 'ERR_CANCELED');
		assert.equal(canceled.name, 'CanceledError');
		assert.equal(canceled.message, 'canceled');

		resetCalls();
		responder = () =>
			new Response(Uint8Array.from([1, 2, 3]), {
				headers: { 'X-Custom-Header': 'value' },
			});
		const arrayBuffer = await handler(undefined, {
			type: 'request',
			config: { url: 'https://store.test/binary', responseType: 'arraybuffer' },
		});
		assert.ok(Buffer.isBuffer(arrayBuffer.data));
		assert.deepEqual(arrayBuffer.data, Buffer.from([1, 2, 3]));
		assert.deepEqual(arrayBuffer.headers, { 'x-custom-header': 'value' });

		responder = () => new Response('{"parsed":true}');
		const json = await handler(undefined, {
			type: 'request',
			config: { url: 'https://store.test/json' },
		});
		assert.deepEqual(json.data, { parsed: true });

		responder = () => new Response('not json');
		const text = await handler(undefined, {
			type: 'request',
			config: { url: 'https://store.test/text' },
		});
		assert.equal(text.data, 'not json');

		resetCalls();
		responder = () => new Response('ok');
		await handler(undefined, {
			type: 'request',
			config: { method: 'post', url: 'https://store.test/batch', data: [{ id: 1 }, { id: 2 }] },
		});
		assert.equal(fetchCalls[0]?.init?.body, '[{"id":1},{"id":2}]');
		assert.equal((fetchCalls[0]?.init?.headers as Headers).get('content-type'), 'application/json');

		resetCalls();
		await handler(undefined, {
			type: 'request',
			config: { method: 'post', url: 'https://store.test/orders', data: { total: '1.00' } },
		});
		assert.equal(fetchCalls[0]?.init?.body, '{"total":"1.00"}');
		assert.equal((fetchCalls[0]?.init?.headers as Headers).get('content-type'), 'application/json');

		// Cloudflare clearance: an existing cookie rides on every request as a
		// Cookie header (net.fetch sends no session cookies), merged after any
		// caller-supplied cookie.
		resetCalls();
		clearerCookie = 'cf_clearance=tok; __cf_bm=bm';
		await handler(undefined, {
			type: 'request',
			config: {
				method: 'get',
				url: 'https://store.test/wp-json/wcpos/v1/products',
				headers: { cookie: 'a=1' },
			},
		});
		assert.equal(fetchCalls.length, 1);
		assert.equal(
			(fetchCalls[0]?.init?.headers as Headers).get('cookie'),
			'a=1; cf_clearance=tok; __cf_bm=bm'
		);
		assert.deepEqual(clearerCalls.clear, [], 'a 200 never triggers a solve');

		// A challenge response is solved in the window and the request replayed
		// once with the minted cookie; the caller sees only the store's answer.
		resetCalls();
		clearerSolves = true;
		let challengesServed = 0;
		responder = (url, init) => {
			const cookie = (init?.headers as Headers | undefined)?.get('cookie') || '';
			if (!cookie.includes('cf_clearance=minted')) {
				challengesServed += 1;
				return challengeResponse();
			}
			return new Response(JSON.stringify({ id: 7 }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		};
		const cleared = await handler(undefined, {
			type: 'request',
			config: {
				method: 'post',
				url: 'https://store.test/wp-json/wcpos/v1/orders',
				data: { total: '1.00' },
			},
		});
		assert.equal(cleared.success, true);
		assert.deepEqual(cleared.data, { id: 7 });
		assert.equal(challengesServed, 1);
		assert.equal(fetchCalls.length, 2, 'exactly one replay');
		assert.deepEqual(clearerCalls.clear, ['https://store.test/wp-json/wcpos/v1/orders']);
		assert.equal(fetchCalls[1]?.init?.body, '{"total":"1.00"}', 'replay carries the same body');
		assert.equal((fetchCalls[1]?.init?.headers as Headers).get('cookie'), 'cf_clearance=minted');

		// A stale clearance is the usual reason for a challenge: the replay must
		// carry only the fresh one, after the caller's own cookies.
		resetCalls();
		clearerCookie = 'cf_clearance=stale';
		clearerSolves = true;
		// The bridge mutates one Headers object across both attempts, so the cookie
		// is captured as each fetch sees it.
		const cookiesSeen: string[] = [];
		responder = (url, init) => {
			const cookie = (init?.headers as Headers | undefined)?.get('cookie') || '';
			cookiesSeen.push(cookie);
			return cookie.includes('cf_clearance=minted')
				? new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
				: challengeResponse();
		};
		await handler(undefined, {
			type: 'request',
			config: {
				method: 'get',
				url: 'https://store.test/wp-json/wcpos/v1/products',
				headers: { cookie: 'a=1' },
			},
		});
		assert.deepEqual(cookiesSeen, ['a=1; cf_clearance=stale', 'a=1; cf_clearance=minted']);

		// If the challenge cannot be cleared the original 403 is returned, once.
		resetCalls();
		clearerSolves = false;
		responder = () => challengeResponse();
		const stuck = await handler(undefined, {
			type: 'request',
			config: { method: 'get', url: 'https://store.test/wp-json/' },
		});
		assert.equal(stuck.success, false);
		assert.equal(stuck.response?.status, 403);
		assert.equal(stuck.response?.headers['cf-mitigated'], 'challenge');
		assert.equal(fetchCalls.length, 1, 'no replay without clearance');
		assert.equal(clearerCalls.clear.length, 1);

		// The request's own timeout still applies while the challenge is being
		// solved: the caller gets its timeout, not a two-minute wait, and no replay.
		resetCalls();
		clearerHangs = true;
		responder = () => challengeResponse();
		// AbortSignal.timeout uses an unref'd timer: with the solve hanging, only
		// this ref'd timer keeps Node alive long enough for the timeout to fire.
		const keepAlive = setTimeout(() => undefined, 5_000);
		const timedOut = await handler(undefined, {
			type: 'request',
			config: { method: 'get', url: 'https://store.test/wp-json/', timeout: 30 },
		});
		assert.equal(timedOut.success, false);
		clearTimeout(keepAlive);
		assert.equal(timedOut.code, 'ECONNABORTED');
		assert.equal(fetchCalls.length, 1);

		// A challenge that persists after clearing is returned as-is, not retried again.
		resetCalls();
		clearerSolves = true;
		const persistent = await handler(undefined, {
			type: 'request',
			config: { method: 'get', url: 'https://store.test/wp-json/' },
		});
		assert.equal(persistent.success, false);
		assert.equal(persistent.response?.status, 403);
		assert.equal(fetchCalls.length, 2);

		// A silent early exit (an unsettled await draining the event loop) would look
		// identical to a pass, so completion is asserted with an explicit marker.
		console.log('SUITE-COMPLETE');
	} finally {
		mutableModule._load = originalLoad;
		if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalNodeEnv;
		if (originalLogHttpBodies === undefined) delete process.env.WCPOS_LOG_HTTP_BODIES;
		else process.env.WCPOS_LOG_HTTP_BODIES = originalLogHttpBodies;
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

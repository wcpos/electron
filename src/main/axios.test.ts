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

type AxiosModule = {
	createAxiosChannelHandler(fetchImpl?: FetchImpl): AxiosHandler;
};

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
			assert.equal(channel, 'axios');
			registeredHandler = handler;
		},
	},
	net: { fetch: fakeFetch },
};

const loggerMock = {
	debug(...args: unknown[]) {
		debugCalls.push(args);
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
	delete require.cache[require.resolve('./axios')];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require('./axios') as AxiosModule;
}

function resetCalls(): void {
	fetchCalls.length = 0;
	debugCalls.length = 0;
	errorCalls.length = 0;
}

async function main() {
	process.env.NODE_ENV = 'production';
	delete process.env.WCPOS_LOG_HTTP_BODIES;

	try {
		const axiosModule = loadAxiosModule();
		assert.ok(registeredHandler, 'axios IPC handler should be registered');
		let handler = axiosModule.createAxiosChannelHandler(fakeFetch);

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
		handler = loadAxiosModule().createAxiosChannelHandler(fakeFetch);
		assert.ok(registeredHandler, 'axios IPC handler should be re-registered');

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

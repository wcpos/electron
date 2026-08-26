import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

type Handler = (event: unknown, args: unknown) => Promise<unknown>;
type RequestOptions = {
	hostname?: string;
	port?: number;
	path?: string;
	method?: string;
	headers?: Record<string, string>;
	rejectUnauthorized?: boolean;
};

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

class FakeResponse extends EventEmitter {
	statusCode = 201;
}

class FakeRequest extends EventEmitter {
	body = '';
	destroyed = false;
	timeoutMs: number | undefined;
	private timeoutCallback: (() => void) | undefined;

	constructor(
		readonly options: RequestOptions,
		private readonly respond: (response: FakeResponse) => void,
		private readonly mode: 'success' | 'timeout',
		private readonly responseBody: Buffer
	) {
		super();
	}

	setTimeout(timeoutMs: number, callback: () => void): this {
		this.timeoutMs = timeoutMs;
		this.timeoutCallback = callback;
		return this;
	}

	end(data?: string): this {
		this.body = data ?? '';
		queueMicrotask(() => {
			if (this.mode === 'timeout') {
				this.timeoutCallback?.();
				return;
			}
			const response = new FakeResponse();
			this.respond(response);
			response.emit('data', this.responseBody);
			response.emit('end');
		});
		return this;
	}

	destroy(): this {
		this.destroyed = true;
		return this;
	}
}

const handlers = new Map<string, Handler>();
const requests: { transport: 'http' | 'https'; request: FakeRequest }[] = [];
let nextMode: 'success' | 'timeout' = 'success';
let nextResponseBody = Buffer.from('<ok/>');

function fakeTransport(transport: 'http' | 'https') {
	return {
		request(options: RequestOptions, respond: (response: FakeResponse) => void) {
			const request = new FakeRequest(options, respond, nextMode, nextResponseBody);
			requests.push({ transport, request });
			nextMode = 'success';
			nextResponseBody = Buffer.from('<ok/>');
			return request;
		},
	};
}

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') {
		return {
			ipcMain: {
				handle(channel: string, handler: Handler) {
					handlers.set(channel, handler);
				},
			},
		};
	}
	if (request === './log') {
		return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
	}
	if (request === 'http') return fakeTransport('http');
	if (request === 'https') return fakeTransport('https');
	return originalLoad.call(this, request, parent, isMain);
};

const validRequest = {
	host: 'printer.local',
	port: 80,
	path: '/cgi-bin/epos/service.cgi',
	xml: '<epos-print/>',
	timeoutMs: 5000,
};

(async () => {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- fakes must be installed before module load
		require('./print-epos-http');
		const handler = handlers.get('print-epos-http');
		assert.ok(handler, 'print-epos-http handler should be registered');

		for (const [port, expectedTransport] of [
			[443, 'https'],
			[8043, 'https'],
			[80, 'http'],
		] as const) {
			const result = await handler(null, { ...validRequest, port });
			const call = requests[requests.length - 1];
			assert.ok(call);
			assert.equal(call.transport, expectedTransport);
			assert.deepEqual(result, { status: 201, body: '<ok/>' });
			assert.equal(call.request.body, '<epos-print/>');
			assert.equal(call.request.options.method, 'POST');
			assert.equal(call.request.options.hostname, 'printer.local');
			assert.equal(call.request.options.path, '/cgi-bin/epos/service.cgi');
			assert.equal(call.request.options.headers?.['Content-Type'], 'text/xml; charset=utf-8');
			assert.equal(
				call.request.options.rejectUnauthorized,
				expectedTransport === 'https' ? false : undefined
			);
		}

		for (const args of [
			{ ...validRequest, host: '' },
			{ ...validRequest, host: 'bad host' },
			{ ...validRequest, host: 'http://printer.local' },
			{ ...validRequest, port: 0 },
			{ ...validRequest, port: 65536 },
			{ ...validRequest, path: '/status' },
		]) {
			await assert.rejects(Promise.resolve(handler(null, args)), /Invalid (host|port|path)/);
		}
		await assert.rejects(
			Promise.resolve(handler(null, { ...validRequest, xml: 'x'.repeat(512 * 1024) })),
			/Invalid xml/
		);

		nextResponseBody = Buffer.alloc(1024 * 1024 + 20, 97);
		const capped = (await handler(null, validRequest)) as { body: string };
		assert.equal(Buffer.byteLength(capped.body), 1024 * 1024);

		nextMode = 'timeout';
		await assert.rejects(
			handler(null, { ...validRequest, port: 9100, timeoutMs: 20 }),
			/printer\.local:9100/
		);
		const timedOut = requests[requests.length - 1]?.request;
		assert.ok(timedOut);
		assert.equal(timedOut.timeoutMs, 1000, 'timeout is clamped to the minimum');
		assert.equal(timedOut.destroyed, true, 'timed-out requests are destroyed');

		console.log('print-epos-http assertions passed');
	} finally {
		mutableModule._load = originalLoad;
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

import assert from 'assert/strict';
import Module from 'module';

type AxiosHandler = (
	event: unknown,
	request: {
		type: 'request';
		config: { method: string; baseURL: string; url: string };
	}
) => Promise<unknown>;

let axiosHandler: AxiosHandler | undefined;
let rejectNextRequest = false;
const debugCalls: unknown[][] = [];
const errorCalls: unknown[][] = [];

const electronMock = {
	ipcMain: {
		handle(channel: string, handler: AxiosHandler) {
			assert.equal(channel, 'axios');
			axiosHandler = handler;
		},
	},
};

const axiosMock = {
	defaults: {},
	request() {
		if (rejectNextRequest) {
			return Promise.reject({
				name: 'AxiosError',
				message: 'Request failed',
				code: 'ERR_BAD_RESPONSE',
				response: {
					status: 500,
					statusText: 'Internal Server Error',
					headers: {},
					data: { reason: 'server failure' },
				},
			});
		}

		return Promise.resolve({
			status: 200,
			statusText: 'OK',
			headers: {},
			data: { products: [] },
		});
	},
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
	if (request === 'axios') return axiosMock;
	if (request === './log') return { logger: loggerMock };
	if (request === './util') return { isDevelopment: true };
	return originalLoad.call(this, request, parent, isMain);
};

async function main() {
	process.env.NODE_ENV = 'production';
	delete process.env.WCPOS_LOG_HTTP_BODIES;

	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require('./axios');

		assert.ok(axiosHandler, 'axios IPC handler should be registered');

		await axiosHandler(undefined, {
			type: 'request',
			config: {
				method: 'get',
				baseURL: 'https://store.test/wp-json/wcpos/v2',
				url: 'products?token=success-secret',
			},
		});

		assert.deepEqual(debugCalls, [['GET products → 200']]);
		assert.ok(!JSON.stringify(debugCalls).includes('success-secret'));

		debugCalls.length = 0;
		process.env.WCPOS_LOG_HTTP_BODIES = '1';
		axiosHandler = undefined;
		delete require.cache[require.resolve('./axios')];
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require('./axios');

		assert.ok(axiosHandler, 'axios IPC handler should be re-registered');

		await axiosHandler(undefined, {
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

		debugCalls.length = 0;
		rejectNextRequest = true;

		await axiosHandler(undefined, {
			type: 'request',
			config: {
				method: 'get',
				baseURL: 'https://store.test/wp-json/wcpos/v2',
				url: 'orders?token=failure-secret',
			},
		});

		assert.equal(debugCalls.length, 2, 'development failures should retain both body logs');
		assert.match(String(debugCalls[0]?.[0]), /^GET orders FAILED$/);
		assert.match(String(debugCalls[1]?.[0]), /^GET orders ERROR /);
		assert.match(String(debugCalls[1]?.[0]), /"reason": "server failure"/);
		assert.equal(errorCalls.length, 1);
		assert.deepEqual(errorCalls[0], [
			'HTTP error',
			{ status: 500, message: 'Request failed', request: 'GET orders' },
		]);
		assert.ok(!JSON.stringify([debugCalls, errorCalls]).includes('failure-secret'));
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

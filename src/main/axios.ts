// This implements the 'axios' IPC channel; the renderer speaks axios shapes, and the transport is Chromium's net.

import { ipcMain, net } from 'electron';

import { logger } from './log';
import { isDevelopment } from './util';

/**
 * Extract a short label from the request config for logging.
 * e.g. "POST products/123" or "GET orders"
 */
function requestLabel(config: any): string {
	const method = (config?.method || 'UNKNOWN').toUpperCase();
	const baseURL = config?.baseURL || '';
	const url = config?.url || '';
	// Show the path after the API prefix (wcpos/v1/ or wc/v3/)
	const full = `${baseURL}/${url}`.replace(/\/+/g, '/');
	const match = full.match(/\/(?:wcpos\/v\d+|wc\/v\d+)\/(.+)/);
	const path = match ? match[1] : url || baseURL;
	return `${method} ${path}`.replace(/\?.*$/, ''); // strip query string
}

/**
 * Pretty-print an object with full depth for dev console logging.
 * Uses JSON.stringify so nested objects/arrays aren't collapsed to [Object].
 */
function prettyLog(label: string, obj: any): void {
	try {
		const json = JSON.stringify(obj, null, 2);
		logger.debug(`${label} ${json}`);
	} catch {
		logger.debug(`${label} [unable to stringify]`);
	}
}

/**
 * Response BODIES are opt-in, even in development.
 *
 * A catalogue sync writes megabytes of product JSON per minute. electron-log
 * rotates main.log at 1MB, so a single sync silently destroyed the earlier part
 * of its own session — on 2026-08-19 a 10-minute run left only the last 17
 * seconds on disk, which is precisely the window a diagnosis does not need.
 * Bodies also carry customer PII (emails, billing addresses), so they should be
 * a deliberate choice rather than the default a dev machine falls into.
 *
 * Default dev logging is now one line per request: method, url, status.
 * Set WCPOS_LOG_HTTP_BODIES=1 to get full bodies back when you actually want
 * to read a payload.
 */
const logHttpBodies = isDevelopment && process.env.WCPOS_LOG_HTTP_BODIES === '1';

type AxiosConfig = {
	url?: string;
	baseURL?: string;
	method?: string;
	headers?: HeadersInit;
	params?: Record<string, unknown>;
	data?: unknown;
	auth?: { username?: string; password?: string };
	timeout?: number;
	validateStatus?: null;
	responseType?: 'text' | 'arraybuffer';
	decompress?: boolean;
};

type AxiosMessage =
	| { type: 'cancel'; requestId?: string }
	| { type: 'request'; requestId?: string; config?: AxiosConfig };

type SerializedResponse = {
	data: unknown;
	status: number;
	statusText: string;
	headers: Record<string, string>;
};

type AxiosFailure = {
	message: string;
	name: 'AxiosError' | 'CanceledError';
	code: string;
	response?: SerializedResponse;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Object.prototype.toString.call(value) === '[object Object]';
}

// Axios's default encoder: %20 becomes +, and : $ , stay literal (brackets remain
// percent-encoded). Verified against axios 1.19's getUri output.
function axiosEncode(value: string): string {
	return encodeURIComponent(value)
		.replace(/%3A/gi, ':')
		.replace(/%24/g, '$')
		.replace(/%2C/gi, ',')
		.replace(/%20/g, '+');
}

// Axios flattens params recursively: arrays as name[]=v per element, plain objects
// as name[key]=v, Dates as ISO strings. Verified against axios 1.19's getUri.
function appendParam(query: string[], name: string, value: unknown): void {
	if (value == null) return;
	if (Array.isArray(value)) {
		for (const item of value) appendParam(query, `${name}[]`, item);
		return;
	}
	if (value instanceof Date) {
		query.push(`${axiosEncode(name)}=${axiosEncode(value.toISOString())}`);
		return;
	}
	if (isPlainObject(value)) {
		for (const [key, item] of Object.entries(value)) appendParam(query, `${name}[${key}]`, item);
		return;
	}
	query.push(`${axiosEncode(name)}=${axiosEncode(String(value))}`);
}

export function buildRequestUrl(config: AxiosConfig): string {
	const url = config.url || '';
	// Axios drops any #fragment before appending params (buildURL does this always).
	const requestUrl = (
		/^[a-z][a-z\d+.-]*:/i.test(url)
			? url
			: `${(config.baseURL || '').replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
	).split('#', 1)[0];
	const query: string[] = [];
	for (const [key, value] of Object.entries(config.params || {})) {
		appendParam(query, key, value);
	}
	return query.length
		? `${requestUrl}${requestUrl.includes('?') ? '&' : '?'}${query.join('&')}`
		: requestUrl;
}

function reducedConfig(config: AxiosConfig) {
	return {
		url: config.url,
		method: config.method,
		baseURL: config.baseURL,
		headers: config.headers,
	};
}

async function responseData(response: Response, responseType?: AxiosConfig['responseType']) {
	if (responseType === 'arraybuffer') return Buffer.from(await response.arrayBuffer());
	const text = await response.text();
	if (responseType === 'text') return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function logFailure(config: AxiosConfig, failure: AxiosFailure): void {
	if (isDevelopment) {
		logger.debug(`${requestLabel(config)} FAILED`, {
			status: failure.response?.status,
			data: failure.response?.data,
			message: failure.message,
		});
	}
	logger.error('HTTP error', {
		status: failure.response?.status,
		message: failure.message,
		request: requestLabel(config),
	});
	if (isDevelopment) {
		prettyLog(`${requestLabel(config)} ERROR`, {
			status: failure.response?.status,
			message: failure.message,
			data: failure.response?.data,
		});
	}
}

function serializeFailure(config: AxiosConfig, failure: AxiosFailure) {
	logFailure(config, failure);
	const response = failure.response
		? { ...failure.response, config: reducedConfig(config), request: null as null }
		: undefined;
	return {
		success: false,
		message: failure.message,
		name: failure.name,
		code: failure.code,
		config: reducedConfig(config),
		request: null as null,
		response,
		isAxiosError: true,
	};
}

export function createAxiosChannelHandler(fetchImpl: typeof net.fetch = net.fetch) {
	const activeRequests = new Map<string, AbortController>();

	return async (_event: unknown, obj: AxiosMessage) => {
		if (obj.type === 'cancel') {
			const controller = obj.requestId ? activeRequests.get(obj.requestId) : undefined;
			if (controller && obj.requestId) {
				controller.abort();
				activeRequests.delete(obj.requestId);
				logger.debug(`Cancelled request ${obj.requestId}`);
			}
			return { success: true };
		}

		const config = obj.config || {};
		const controller = new AbortController();
		if (obj.requestId) activeRequests.set(obj.requestId, controller);
		// Assigned inside try: a malformed timeout must resolve the failure shape,
		// never reject the IPC promise (the always-resolve contract).
		let timeoutSignal: AbortSignal | undefined;

		try {
			// Axios coerces string timeouts at runtime but rejects nonnumeric ones with
			// ERR_BAD_OPTION_VALUE (verified against axios 1.19); AbortSignal.timeout
			// additionally throws on non-integer/out-of-range values, so normalize first.
			const timeoutMs = Math.floor(Number(config.timeout));
			if (config.timeout != null && Number.isNaN(timeoutMs)) {
				return serializeFailure(config, {
					message: 'error trying to parse `config.timeout` to int',
					name: 'AxiosError',
					code: 'ERR_BAD_OPTION_VALUE',
				});
			}
			if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
				timeoutSignal = AbortSignal.timeout(Math.min(timeoutMs, 2 ** 31 - 1));
			}
			const signal = timeoutSignal
				? AbortSignal.any([controller.signal, timeoutSignal])
				: controller.signal;
			const headers = new Headers(config.headers);
			// Axios generates a Basic Authorization header from config.auth, overriding
			// any caller-supplied Authorization.
			if (config.auth) {
				const basic = `${config.auth.username ?? ''}:${config.auth.password ?? ''}`;
				headers.set('authorization', `Basic ${Buffer.from(basic).toString('base64')}`);
			}
			const method = (config.method || 'GET').toUpperCase();
			let body = config.data as BodyInit | null | undefined;
			// Axios JSON-encodes plain objects AND arrays; an array is not a valid BodyInit.
			if (isPlainObject(config.data) || Array.isArray(config.data)) {
				body = JSON.stringify(config.data);
				if (!headers.has('content-type')) headers.set('content-type', 'application/json');
			}
			// fetch (like the web platform's XHR lane) cannot send GET/HEAD bodies; the
			// old Node transport could, but no caller does and the web lane never could —
			// drop the body rather than fail the whole request with ERR_NETWORK.
			if (method === 'GET' || method === 'HEAD') {
				body = undefined;
			}
			const response = await fetchImpl(buildRequestUrl(config), {
				method,
				headers,
				body,
				signal,
			});
			const serialized: SerializedResponse = {
				data: await responseData(response, config.responseType),
				status: response.status,
				statusText: response.statusText,
				headers: Object.fromEntries(response.headers.entries()),
			};
			if (config.validateStatus !== null && (response.status < 200 || response.status >= 300)) {
				return serializeFailure(config, {
					message: `Request failed with status code ${response.status}`,
					name: 'AxiosError',
					code: response.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
					response: serialized,
				});
			}
			if (isDevelopment) logger.debug(`${requestLabel(config)} → ${response.status}`);
			if (logHttpBodies)
				prettyLog(requestLabel(config), { status: response.status, data: serialized.data });
			return {
				success: true,
				...serialized,
				config: reducedConfig(config),
				request: null as null,
			};
		} catch (error) {
			const failure: AxiosFailure = controller.signal.aborted
				? { message: 'canceled', name: 'CanceledError', code: 'ERR_CANCELED' }
				: timeoutSignal?.aborted
					? {
							message: `timeout of ${config.timeout}ms exceeded`,
							name: 'AxiosError',
							code: 'ECONNABORTED',
						}
					: {
							message: error instanceof Error ? error.message : String(error),
							name: 'AxiosError',
							code: 'ERR_NETWORK',
						};
			return serializeFailure(config, failure);
		} finally {
			if (obj.requestId) activeRequests.delete(obj.requestId);
		}
	};
}

// Renderer IPC starts after app ready, which is required by net.fetch.
ipcMain.handle('axios', createAxiosChannelHandler());

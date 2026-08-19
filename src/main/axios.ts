import https from 'https';

import axios from 'axios';
import { ipcMain } from 'electron';

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

// import structuredClone from 'core-js-pure/stable/structured-clone';

/**
 * Allow self-signed certicates in development only
 */
if (process.env.NODE_ENV === 'development') {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
	const httpsAgent = new https.Agent({
		rejectUnauthorized: false,
		family: 4,
	});
	axios.defaults.httpsAgent = httpsAgent;

	console.log(process.env.NODE_ENV, `RejectUnauthorized is disabled.`);
}

// Map to store AbortControllers for active requests
const activeRequests = new Map<string, AbortController>();

/**
 *
 */
ipcMain.handle('axios', (event, obj) => {
	// console.log(obj);

	// Handle request cancellation
	if (obj.type === 'cancel') {
		const { requestId } = obj;
		if (requestId && activeRequests.has(requestId)) {
			const controller = activeRequests.get(requestId);
			controller.abort();
			activeRequests.delete(requestId);
			logger.debug(`Cancelled request ${requestId}`);
		}
		return Promise.resolve({ success: true });
	}

	if (obj.type === 'request') {
		return new Promise((resolve) => {
			const config = obj.config || {};
			const requestId = obj.requestId;

			// If request ID is provided, attach an abort signal
			if (requestId) {
				const controller = new AbortController();
				config.signal = controller.signal;
				activeRequests.set(requestId, controller);
			}

			axios
				.request(config)
				.then((response) => {
					if (isDevelopment) {
						logger.debug(`${requestLabel(config)} → ${response.status}`);
					}
					// Create a serializable response object that matches Axios structure
					const serializableResponse = {
						success: true,
						data: response.data,
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
						config: {
							url: obj.config?.url,
							method: obj.config?.method,
							baseURL: obj.config?.baseURL,
							headers: obj.config?.headers,
						},
						request: null as any, // Explicitly null for serialization
					};
					if (logHttpBodies) {
						prettyLog(requestLabel(obj.config), {
							status: response.status,
							data: response.data,
						});
					}
					resolve(serializableResponse);
				})
				.catch((error) => {
					// Failures keep their body unconditionally in dev: an error payload is
					// small, rare, and it IS the diagnosis. Only the success firehose above
					// is gated.
					if (isDevelopment) {
						logger.debug(`${requestLabel(config)} FAILED`, {
							status: error.response?.status,
							data: error.response?.data,
							message: error.message,
						});
					}
					// Create a serializable error object that matches Axios error structure
					const serializableError = {
						success: false,
						message: error.message,
						name: error.name,
						code: error.code,
						config: {
							url: obj.config?.url,
							method: obj.config?.method,
							baseURL: obj.config?.baseURL,
							headers: obj.config?.headers,
						},
						request: null as any, // Explicitly null for serialization
						response: error.response
							? {
									data: error.response.data,
									status: error.response.status,
									statusText: error.response.statusText,
									headers: error.response.headers,
									config: {
										url: obj.config?.url,
										method: obj.config?.method,
										baseURL: obj.config?.baseURL,
										headers: obj.config?.headers,
									},
									request: null as any, // Explicitly null for serialization
								}
							: undefined,
						isAxiosError: true,
					};
					logger.error('HTTP error', {
						status: error.response?.status,
						message: error.message,
						request: requestLabel(obj.config),
					});
					if (isDevelopment) {
						prettyLog(`${requestLabel(obj.config)} ERROR`, {
							status: error.response?.status,
							message: error.message,
							data: error.response?.data,
						});
					}
					resolve(serializableError);
				})
				.finally(() => {
					// Clean up the active request map
					if (requestId && activeRequests.has(requestId)) {
						activeRequests.delete(requestId);
					}
				});
		});
	}
});

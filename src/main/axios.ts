import https from 'https';

import axios from 'axios';
import { ipcMain } from 'electron';

import logger from './log';

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
					logger.silly('HTTP success', { status: response.status, url: obj.config?.url });
					resolve(serializableResponse);
				})
				.catch((error) => {
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
						url: obj.config?.url,
					});
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

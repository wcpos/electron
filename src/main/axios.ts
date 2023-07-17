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
	// eslint-disable-next-line no-console
	console.log(process.env.NODE_ENV, `RejectUnauthorized is disabled.`);
}

/**
 *
 */
ipcMain.handle('axios', (event, obj) => {
	console.log(obj);
	if (obj.type === 'request') {
		return new Promise((resolve, reject) => {
			axios
				.request(obj.config || {})
				.then((res) => {
					/**
					 * config and request contain objects that can't be structuredCloned
					 * TODO - do I need anything from config or request?
					 */
					// const cloned = structuredClone({ ...res, config: null, request: null });
					const cloned = { ...res, config: obj.config, request: null };
					logger.silly('success', cloned);
					resolve(cloned);
				})
				.catch((error) => {
					const cloned = {
						...error,
						config: obj.config,
						request: null,
						response: {
							...error.response,
							config: obj.config,
							request: null,
						},
					};
					logger.error('request failed', cloned);
					resolve(cloned);
				});
		});
	}
});

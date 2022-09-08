import { ipcMain } from 'electron';
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
// import structuredClone from 'core-js-pure/stable/structured-clone';

/**
 * Allow self-signed certicates in development only
 */
if (process.env.NODE_ENV === 'development') {
	const httpsAgent = new https.Agent({
		rejectUnauthorized: false,
	});
	axios.defaults.httpsAgent = httpsAgent;
	// eslint-disable-next-line no-console
	console.log(process.env.NODE_ENV, `RejectUnauthorized is disabled.`);
}

/**
 * Axios instance registry
 */
const registry = new Map();

/**
 *
 */
ipcMain.handle('axios', (event, obj) => {
	console.log(obj);
	switch (obj.type) {
		case 'create':
			const instanceID = crypto.randomUUID();
			registry.set(instanceID, axios.create(obj.config));
			return instanceID;
		case 'request':
			return new Promise((resolve, reject) => {
				let instance = registry.get(obj.instanceID);

				/**
				 * No instance
				 */
				if (!instance) {
					console.log('No axios instance!');
					instance = axios;
				}

				instance
					.request(obj.config)
					.then((res) => {
						/**
						 * config and request contain objects that can't be structuredCloned
						 * @TODO - do I need anything from config or request?
						 */
						// const cloned = structuredClone({ ...res, config: null, request: null });
						const cloned = { ...res, config: null, request: null };
						console.log('success', cloned);
						resolve(cloned);
					})
					.catch((error) => {
						const cloned = {
							...error,
							config: null,
							request: null,
							response: {
								...error.response,
								config: null,
								request: null,
							},
						};
						console.log('failed', cloned);
						resolve(cloned);
					});
			});

		default:
			return new Error('Unknown type');
	}
});

import { ipcMain } from 'electron';
import axios from 'axios';
import https from 'https';
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
 *
 */
ipcMain.handle('axios', (event, obj) => {
	console.log(obj);
	switch (obj.type) {
		case 'request':
			return axios.request(obj.config).then((res) => {
				/**
				 * config and request contain objects that can't be structuredCloned
				 * @TODO - do I need anything from config or request?
				 */
				// const cloned = structuredClone({ ...res, config: null, request: null });
				const cloned = { ...res, config: null, request: null };
				console.log(cloned);
				return cloned;
			});
		default:
			return new Error('Unknown type');
	}
});

import * as path from 'path';

import { app } from 'electron';

export function initProtocolHandling() {
	app.removeAsDefaultProtocolClient('wcpos');
	if (process.defaultApp) {
		if (process.argv.length >= 2) {
			app.setAsDefaultProtocolClient('wcpos', process.execPath, [path.resolve(process.argv[1])]);
		}
	} else {
		app.setAsDefaultProtocolClient('wcpos');
	}

	app.on('open-url', (event, url) => {
		console.log('Welcome Back', `You arrived from: ${url}`);
	});
}

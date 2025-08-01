import * as path from 'path';

import { app } from 'electron';

import log from './log';
import { getMainWindow } from './window';

/**
 *
 */
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
		log.info(`Protocol handler received URL: ${url}`);

		// Simulate browser navigation to the protocol URL so expo-auth-session can handle it
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			log.info(`Simulating navigation to protocol URL: ${url}`);

			mainWindow.focus();
		} else {
			log.warn('Main window not available to handle protocol URL');
		}
	});
}

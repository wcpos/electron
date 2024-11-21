import * as path from 'path';

import { app, protocol } from 'electron';

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
		console.log('Welcome Back', `You arrived from: ${url}`);
	});

	// Use `protocol.handle` to register the 'app://' protocol
	app.whenReady().then(() => {
		protocol.handle('app', async (request) => {
			try {
				const basePath = path.join(process.resourcesPath, 'dist');
				const reqUrl = new URL(request.url);

				// Resolve the requested path relative to the base path
				const relativePath = reqUrl.pathname;
				const filePath = path.join(basePath, relativePath);

				// Ensure the resolved path is within the allowed base directory
				if (!filePath.startsWith(basePath)) {
					throw new Error(`Unauthorized file access attempt: ${filePath}`);
				}

				// Return the file as a `file://` URL
				return new URL(`file://${filePath}`);
			} catch (error) {
				console.error('Error in protocol handler:', error);
				throw error;
			}
		});
	});
}

import path from 'path';

import { ipcMain } from 'electron';

/**
 * This is used to get the base path of the app.
 *
 * @NOTE - I'm leaving off the trailing slash, because expo has the slash at the start
 */
ipcMain.on('getBasePathSync', (event) => {
	const basePath = `file://${path.join(process.resourcesPath, 'dist')}`;
	event.returnValue = basePath; // Synchronously return the basePath
});

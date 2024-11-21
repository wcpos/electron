import path from 'path';

import { ipcMain } from 'electron';

ipcMain.on('getBasePathSync', (event) => {
	const basePath = `file://${path.join(process.resourcesPath, 'dist')}/`;
	event.returnValue = basePath; // Synchronously return the basePath
});

import { app, ipcMain } from 'electron';

/**
 * This is used to get the app version.
 * The version comes from package.json and is read by Electron's app module.
 */
ipcMain.on('getAppVersionSync', (event) => {
	event.returnValue = app.getVersion();
});

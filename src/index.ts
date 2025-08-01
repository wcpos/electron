import { app, BrowserWindow } from 'electron';

import { installExtensions } from './main/extensions';
import logger from './main/log';
import { registerMenu } from './main/menu';
import { initProtocolHandling } from './main/protocol';
import { loadTranslations } from './main/translations';
import { updater } from './main/update';
import { createWindow } from './main/window';
import './main/database';
import './main/axios';
import './main/print-external-url';
import './main/basePath';

// enabled logging when in development
// if (process.env.NODE_ENV === 'development') {
// 	app.commandLine.appendSwitch('enable-logging');
// 	app.commandLine.appendSwitch('v', '1');
// }

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
	app.quit();
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app
	.whenReady()
	.then(loadTranslations)
	.then(installExtensions)
	.then(() => {
		logger.info('Starting app');
		createWindow();
		if (process.env.NODE_ENV === 'development') {
			// force protocol handling in development
			// forge will handle this in production
			initProtocolHandling();
		}
		registerMenu();
		updater.init(); // must be after createWindow
	})
	.catch((err) => {
		logger.error('Error starting app');
		logger.error(err);
	});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('activate', () => {
	// On OS X it's common to re-create a window in the app when the
	// dock icon is clicked and there are no other windows open.
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow();
	}
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

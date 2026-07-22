import { app, BrowserWindow, powerMonitor } from 'electron';

import {
	type AppContext,
	boot,
	type BootDeps,
	createMainWindowContext,
	wireMainWindowConsumers,
} from './main/boot';
import { initAuthHandler } from './main/auth-handler';
import { clearPendingAppDataOnStartup } from './main/clear-data';
import { installExtensions } from './main/extensions';
import { registerBluetoothSelection } from './main/bluetooth-select';
import { registerScannerDeviceSelection } from './main/device-select';
import { logger } from './main/log';
import { initializeRxdbStorageBridge } from './main/rxdb-storage';
import { registerMenu } from './main/menu';
import { initProtocolHandling } from './main/protocol';
import { loadTranslations } from './main/translations';
import { AutoUpdater, setUpdater } from './main/update';
import { createWindow, getMainWindow } from './main/window';
import './main/database';
import './main/axios';
import './main/image-cache';
import './main/print-external-url';
import './main/print-raw-tcp';
import './main/serial-printer';
import './main/usb-printer';
import './main/printer-discovery';
import './main/open-external-url';

// enabled logging when in development
// if (process.env.NODE_ENV === 'development') {
// 	app.commandLine.appendSwitch('enable-logging');
// 	app.commandLine.appendSwitch('v', '1');
// }

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
	app.quit();
}

const bootDeps: BootDeps = {
	whenReady: () => app.whenReady(),
	loadTranslations,
	clearPendingAppDataOnStartup,
	installExtensions,
	initializeRxdbStorageBridge,
	createWindow,
	getMainWindow,
	registerBluetoothSelection,
	registerScannerDeviceSelection,
	initAuthHandler,
	initProtocolHandling,
	registerMenu,
	createUpdater: (mainWindow) => setUpdater(new AutoUpdater(mainWindow)),
	isDevelopment: process.env.NODE_ENV === 'development',
	logger,
};

let appContext: AppContext | null = null;

boot(bootDeps)
	.then((context) => {
		appContext = context;
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
		const context = appContext ?? {};
		createMainWindowContext(bootDeps, context);
		wireMainWindowConsumers(bootDeps, context);
	}
});

// Power management - detect system suspend/resume to help diagnose
// potential issues when the app is in the background
powerMonitor.on('suspend', () => {
	logger.info('System is suspending');
});

powerMonitor.on('resume', () => {
	logger.info('System has resumed from suspend');
	// Notify the renderer that the system has resumed
	// This can help the app recover gracefully
	const mainWindow = getMainWindow();
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send('system-resume');
	}
});

powerMonitor.on('lock-screen', () => {
	logger.info('Screen was locked');
});

powerMonitor.on('unlock-screen', () => {
	logger.info('Screen was unlocked');
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

import { app, BrowserWindow, net, powerMonitor, session } from 'electron';

import { type AppContext, boot, type BootDeps, recreateMainWindow } from './main/boot';
import { initAuthHandler } from './main/auth-handler';
import { clearPendingAppDataOnStartup } from './main/clear-data';
import { installExtensions } from './main/extensions';
import { registerBluetoothSelection } from './main/bluetooth-select';
import { registerScannerDeviceSelection } from './main/device-select';
import { registerFrameHeaderRelaxation } from './main/frame-headers';
import { logger } from './main/log';
import { registerNovuBridge } from './main/novu';
import { initializeRxdbStorageBridge } from './main/rxdb-storage';
import { registerMenu } from './main/menu';
import { initProtocolHandling } from './main/protocol';
import { loadTranslations } from './main/translations';
import { AutoUpdater, setUpdater } from './main/update';
import { createWindow, getMainWindow } from './main/window';
import './main/http-bridge';
import './main/image-cache';
import './main/storage-measure';
import './main/print-external-url';
import './main/print-raw-tcp';
import './main/serial-printer';
import './main/usb-printer';
import './main/printer-discovery';
import './main/open-external-url';
import './main/telemetry-consent';

registerNovuBridge();

// enabled logging when in development
// if (process.env.NODE_ENV === 'development') {
// 	app.commandLine.appendSwitch('enable-logging');
// 	app.commandLine.appendSwitch('v', '1');
// }

if (process.env.NODE_ENV === 'development') {
	// Chromium-level replacement for the old Node TLS bypass so self-signed dev stores keep working;
	// dev-only; must run before app ready.
	app.commandLine.appendSwitch('ignore-certificate-errors');
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
	app.quit();
}

const bootDeps: BootDeps = {
	whenReady: () =>
		app.whenReady().then(() => {
			registerFrameHeaderRelaxation(session.defaultSession);
			// Route every main-process global fetch consumer (Novu SDK REST, translation
			// catalogs, image cache) through Chromium's stack — system proxy + OS trust
			// store — instead of Node's undici. net.fetch is only callable after ready.
			// Known residual: Novu's socket.io realtime channel keeps its own Node
			// transport (no injection point); REST paths cover subscriber operations.
			globalThis.fetch = net.fetch as typeof globalThis.fetch;
		}),
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
		const context: Partial<AppContext> = appContext ?? {};
		if (recreateMainWindow(bootDeps, context) && context.mainWindow && context.updater) {
			appContext = context as AppContext;
		}
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

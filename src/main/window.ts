import * as path from 'path';

import { BrowserWindow, shell } from 'electron';
import serve from 'electron-serve';

import { logger as log } from './log';
import { isDevelopment } from './util';

// Set up electron-serve
let loadURL: (window: BrowserWindow) => void;

if (isDevelopment) {
	const expoPort = process.env.EXPO_PORT || '8088';
	loadURL = (window: BrowserWindow) => window.loadURL(`http://localhost:${expoPort}`);
} else {
	// In production mode, serve the 'dist' directory from resources
	const pathToDist = path.join(process.resourcesPath, 'dist');
	loadURL = serve({
		directory: pathToDist,
		scheme: 'wcpos',
	});
}

let mainWindow: BrowserWindow | null;

export const createWindow = (): void => {
	// Create the browser window.
	mainWindow = new BrowserWindow({
		show: false,
		width: 1024,
		height: 728,
		icon: path.join(__dirname, '../../icons/icon.ico'),
		webPreferences: {
			preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
			sandbox: false, // Required for preload script to work
			nodeIntegration: false, // Prevent Node.js integration for security reasons
			contextIsolation: true, // Protect against prototype pollution
		},
		backgroundColor: '#fff',
	});

	if (isDevelopment) {
		mainWindow.webContents.openDevTools();
	}

	// Load the application
	loadURL(mainWindow);

	mainWindow.on('ready-to-show', () => {
		if (!mainWindow) {
			throw new Error('"mainWindow" is not defined');
		}
		if (process.env.START_MINIMIZED) {
			mainWindow.minimize();
		} else {
			mainWindow.show();
		}
	});

	mainWindow.on('closed', () => {
		mainWindow = null;
	});

	// Open external URLs in the user's default browser
	// Auth is now handled via IPC in auth-handler.ts
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		log.info(`Opening in external browser: ${url}`);
		shell.openExternal(url);
		return { action: 'deny' };
	});

	// Handle failed loads
	let retryCount = 0;
	const MAX_RETRIES = 30; // ~60 seconds of retries

	mainWindow.webContents.on('did-fail-load', async (event, errorCode, errorDescription) => {
		log.error(`did fail load with code ${errorCode}: ${errorDescription}`);
		if (errorDescription === 'ERR_CONNECTION_REFUSED') {
			if (retryCount >= MAX_RETRIES) {
				log.error('Max retries reached, giving up on dev server connection');
				return;
			}
			retryCount++;
			// Metro dev server isn't ready yet — retry after a short delay
			log.info('Dev server not ready, retrying in 2s...');
			setTimeout(() => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					loadURL(mainWindow);
				}
			}, 2000);
		} else {
			log.error(`Load failed without retry: ${errorDescription}`);
		}
	});
};

export const getMainWindow = (): BrowserWindow | null => {
	return mainWindow;
};

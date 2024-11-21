import * as path from 'path';

import { BrowserWindow, shell } from 'electron';
import serve from 'electron-serve';

import log from './log';

const isDevelopment = process.env.NODE_ENV === 'development';

// Set up electron-serve
let loadURL: (window: BrowserWindow) => void;

if (isDevelopment) {
	// In development mode, load from localhost
	loadURL = (window: BrowserWindow) => window.loadURL('http://localhost:8088');
} else {
	// In production mode, serve the 'dist' directory from resources
	const pathToDist = path.join(process.resourcesPath, 'dist');
	loadURL = serve({
		directory: pathToDist,
		scheme: 'http',
		hostname: 'localhost',
		file: 'index',
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

	// Open URLs in the user's browser
	mainWindow.webContents.setWindowOpenHandler((edata) => {
		shell.openExternal(edata.url);
		return { action: 'deny' };
	});

	// Handle failed loads
	mainWindow.webContents.on('did-fail-load', async (event, errorCode, errorDescription) => {
		log.error(`did fail load with code ${errorCode}: ${errorDescription}`);
		if (errorDescription !== 'ERR_CONNECTION_REFUSED') {
			// Reload the window
			loadURL(mainWindow as BrowserWindow);
		}
	});
};

export const getMainWindow = (): BrowserWindow | null => {
	return mainWindow;
};

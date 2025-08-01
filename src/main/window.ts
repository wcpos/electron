import * as path from 'path';

import { BrowserWindow, shell } from 'electron';
import serve from 'electron-serve';

import log from './log';
import { isDevelopment } from './util';

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

	// Open URLs in the user's browser
	mainWindow.webContents.setWindowOpenHandler(({ url, disposition, referrer, postBody }) => {
		// Log all popup attempts
		log.info(`Popup requested: ${url}`);

		// 1) If this is JWT‐auth popup, allow it in‐app:
		if (url.match(/\/wcpos-auth(\?|$)/)) {
			log.info(`Auth popup allowed: ${url}`);
			return {
				action: 'allow',
				overrideBrowserWindowOptions: {
					width: 500,
					height: 550,
					alwaysOnTop: true,
					webPreferences: {
						nodeIntegration: false,
						contextIsolation: true,
					},
				},
				outlivesOpener: false,
			};
		}

		// 2) Otherwise, open in the user's external browser:
		log.info(`Opening in external browser: ${url}`);
		shell.openExternal(url);
		return { action: 'deny' };
	});

	// Listen for new windows (popups) being created
	mainWindow.webContents.on('did-create-window', (window, details) => {
		log.info(`Popup window created for: ${details.url}`);

		// Listen to navigation events within the popup
		window.webContents.on('will-navigate', (event, navigationUrl) => {
			log.info(`Popup will navigate to: ${navigationUrl}`);

			// If popup is navigating to wcpos:// protocol, handle it
			if (navigationUrl.startsWith('wcpos://')) {
				event.preventDefault();
				log.info(`Auth popup redirecting to protocol URL: ${navigationUrl}`);

				// Simulate browser navigation to the protocol URL so expo-auth-session can handle it
				if (mainWindow && !mainWindow.isDestroyed()) {
					log.info(`Simulating navigation to protocol URL: ${navigationUrl}`);

					mainWindow.focus();
				}

				// Close the popup
				if (!window.isDestroyed()) {
					window.close();
				}
			}
		});

		window.webContents.on('did-navigate', (event, navigationUrl) => {
			log.info(`Popup navigated to: ${navigationUrl}`);
		});

		window.webContents.on('did-navigate-in-page', (event, navigationUrl) => {
			log.info(`Popup in-page navigation to: ${navigationUrl}`);
		});

		// Log when popup is closed
		window.on('closed', () => {
			log.info(`Popup window closed`);
		});
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

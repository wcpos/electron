import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { format as formatUrl } from 'url';
import { main } from './main';
import { isMac, isDevelopment } from './utils';
import './dev-tools';

// global reference to mainWindow (necessary to prevent window from being garbage collected)
let mainWindow;

function createMainWindow() {
	const browserWindow = new BrowserWindow({
		show: false,
		// titleBarStyle: isMac ? 'customButtonsOnHover' : 'default',
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
			// enableRemoteModule: true,
			webSecurity: false, // https://github.com/electron/electron/issues/13528
		},
	});
	browserWindow.maximize();
	browserWindow.show();

	if (isDevelopment) {
		browserWindow.webContents.openDevTools();
	}

	if (isDevelopment) {
		browserWindow.loadURL(`http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}`);
	} else {
		browserWindow.loadURL(
			formatUrl({
				pathname: path.join(__dirname, 'index.html'),
				protocol: 'file',
				slashes: true,
			})
		);
	}

	browserWindow.on('closed', () => {
		mainWindow = null;
	});

	browserWindow.webContents.on('devtools-opened', () => {
		browserWindow.focus();
		setImmediate(() => {
			browserWindow.focus();
		});
	});

	return browserWindow;
}

// quit application when all windows are closed
app.on('window-all-closed', () => {
	// on macOS it is common for applications to stay open until the user explicitly quits
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('activate', () => {
	// on macOS it is common to re-create a window even after all windows have been closed
	if (mainWindow === null) {
		mainWindow = createMainWindow();
	}
});

// create main BrowserWindow when electron is ready
app.on('ready', () => {
	mainWindow = createMainWindow();
});

app.setAboutPanelOptions({
	applicationName: 'WooCommerce POS',
	applicationVersion: app.getVersion(),
	copyright: 'Copyright © 2022 WooCommerce POS',
	version: app.getVersion(),
});

main();

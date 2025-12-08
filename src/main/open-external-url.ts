import { ipcMain, shell } from 'electron';

import logger from './log';

/**
 * IPC handler for opening URLs in the system's default external browser
 * This prevents URLs from opening within the Electron app's webview
 */
ipcMain.on('open-external-url', (_event, url: string) => {
	try {
		logger.info(`Opening external URL: ${url}`);
		shell.openExternal(url);
	} catch (error) {
		logger.error('Failed to open external URL:', error);
	}
});

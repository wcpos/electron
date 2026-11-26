import { ipcMain } from 'electron';

import { openExternalSafely } from './safe-external-url';

/**
 * IPC handler for opening URLs in the system's default external browser
 * This prevents URLs from opening within the Electron app's webview
 */
ipcMain.on('open-external-url', (_event, url: string) => {
	void openExternalSafely(url);
});

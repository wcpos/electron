import path from 'path';
import { app, ipcRenderer, dialog } from 'electron';
import fs from 'fs-extra';

export const clearAppDataDialog = () => {
	const clearAppDataMessage =
		'By clicking proceed you will be removing all added accounts and preferences WooCommerce POS. ' +
		'When the application restarts, it will be as if you are starting WooCommerce POS for the first time.';
	const getAppPath = path.join(app.getPath('appData'), app.getName());

	dialog.showMessageBox(
		{
			type: 'warning',
			buttons: ['YES', 'NO'],
			defaultId: 0,
			message: 'Are you sure',
			detail: clearAppDataMessage,
		},
		(response) => {
			if (response === 0) {
				fs.remove(getAppPath);
				// setTimeout(() => ipcRenderer.send('forward-message', 'hard-reload'), 1000);
				app.relaunch();
				app.quit();
			}
		}
	);
};

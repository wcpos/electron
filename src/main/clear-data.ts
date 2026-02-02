import path from 'path';

import { app, dialog, ipcMain } from 'electron';
import fs from 'fs-extra';

import { closeAll } from './database';
import logger from './log';
import { t } from './translations';

export const clearAppDataDialog = () => {
	const clearAppDataMessage = t(
		'By clicking proceed you will be removing all added accounts and preferences for WooCommerce POS. ' +
			'When the application restarts, it will be as if you are starting WooCommerce POS for the first time.'
	);

	const dbFolder =
		process.env.NODE_ENV === 'development'
			? path.resolve('databases')
			: path.resolve(app.getPath('userData'), 'wcpos_dbs');

	dialog
		.showMessageBox({
			type: 'warning',
			buttons: [t('Yes'), t('No')],
			message: t('Are you sure?'),
			detail: clearAppDataMessage,
		})
		.then(({ response }) => {
			if (response === 0) {
				// Close the db connection, delete the db file, and restart the app
				try {
					closeAll();
					return fs.remove(dbFolder).then(() => {
						// setTimeout(() => ipcRenderer.send('forward-message', 'hard-reload'), 1000);
						logger.info(t('Cleared app data'));
						app.relaunch();
						app.quit();
					});
				} catch (err) {
					logger.error(t('Could not clear app data'), err);
				}
			}
		});
};

ipcMain.on('clearData', (event, args) => {
	clearAppDataDialog();
});

import { app, dialog, ipcMain } from 'electron';
import fs from 'fs-extra';

import { closeAll } from './database';
import { logger } from './log';
import { getFilesystemNodeBasePath, getLegacySqliteBasePath } from './rxdb-storage';
import { t } from './translations';

export const clearAppDataDialog = () => {
	const clearAppDataMessage = t(
		'By clicking proceed you will be removing all added accounts and preferences for WooCommerce POS. ' +
			'When the application restarts, it will be as if you are starting WooCommerce POS for the first time.'
	);

	const dbFolders = [getLegacySqliteBasePath(), getFilesystemNodeBasePath()];

	dialog
		.showMessageBox({
			type: 'warning',
			buttons: [t('common.yes'), t('common.no')],
			message: t('app.are_you_sure'),
			detail: clearAppDataMessage,
		})
		.then(({ response }) => {
			if (response === 0) {
				// Close legacy sqlite connections, delete all db folders, and restart the app.
				// filesystem-node storage has no explicit close — relaunch releases its fds.
				try {
					closeAll();
					return Promise.all(dbFolders.map((folder) => fs.remove(folder))).then(() => {
						logger.info(`${t('app.cleared_app_data')} (${dbFolders.join(', ')})`);
						app.relaunch();
						app.quit();
					});
				} catch (err) {
					logger.error(t('app.could_not_clear_app_data'), err);
				}
			}
		});
};

ipcMain.on('clearData', (event, args) => {
	clearAppDataDialog();
});

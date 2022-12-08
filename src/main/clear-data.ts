import path from 'path';

import { app, ipcRenderer, dialog } from 'electron';
import fs from 'fs-extra';

import { closeAll } from './database';
import logger from './log';
import { t } from './translations';

export const clearAppDataDialog = () => {
	const clearAppDataMessage = t(
		'By clicking proceed you will be removing all added accounts and preferences for WooCommerce POS. ' +
			'When the application restarts, it will be as if you are starting WooCommerce POS for the first time.',
		{ _tags: 'electron' }
	);

	const dbFolder =
		process.env.NODE_ENV === 'development'
			? path.resolve('databases')
			: path.resolve(app.getPath('userData'), 'databases');

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
				closeAll()
					.then(() => {
						return fs.remove(dbFolder).then(() => {
							// setTimeout(() => ipcRenderer.send('forward-message', 'hard-reload'), 1000);
							app.relaunch();
							app.quit();
						});
					})
					.catch((err) => {
						logger.error(t('Could not clear app data', { _tags: 'electron' }), err);
					});
			}
		});
};

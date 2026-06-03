import { app, dialog, ipcMain } from 'electron';
import fs from 'fs-extra';

import { closeAll } from './database';
import { logger } from './log';
import { getFilesystemNodeBasePath, getLegacySqliteBasePath } from './rxdb-storage';
import { t } from './translations';

const CLEAR_APP_DATA_ON_STARTUP_ARG = '--clear-app-data-on-startup';

const getDbFolders = () => [getLegacySqliteBasePath(), getFilesystemNodeBasePath()];

const getRelaunchArgs = () => [
	...process.argv.slice(1).filter((arg) => arg !== CLEAR_APP_DATA_ON_STARTUP_ARG),
	CLEAR_APP_DATA_ON_STARTUP_ARG,
];

const clearAppDataFolders = async () => {
	const dbFolders = getDbFolders();

	closeAll();
	await Promise.all(dbFolders.map((folder) => fs.remove(folder)));
	logger.info(`${t('app.cleared_app_data')} (${dbFolders.join(', ')})`);
};

export const clearPendingAppDataOnStartup = async () => {
	if (!process.argv.includes(CLEAR_APP_DATA_ON_STARTUP_ARG)) {
		return;
	}

	try {
		await clearAppDataFolders();
	} catch (err) {
		logger.error(t('app.could_not_clear_app_data'), err);
	}
};

export const clearAppDataDialog = () => {
	const clearAppDataMessage = t(
		'By clicking proceed you will be removing all added accounts and preferences for WCPOS. ' +
			'When the application restarts, it will be as if you are starting WCPOS for the first time.'
	);

	dialog
		.showMessageBox({
			type: 'warning',
			buttons: [t('common.yes'), t('common.no')],
			message: t('app.are_you_sure'),
			detail: clearAppDataMessage,
		})
		.then(({ response }) => {
			if (response === 0) {
				// Close legacy sqlite connections and relaunch before deleting all db folders.
				// filesystem-node storage has no explicit close, so the relaunched process clears it
				// before the storage bridge is initialised and opens filesystem handles.
				try {
					closeAll();
					app.relaunch({ args: getRelaunchArgs() });
					app.quit();
				} catch (err) {
					logger.error(t('app.could_not_clear_app_data'), err);
				}
			}
		});
};

ipcMain.on('clearData', (event, args) => {
	clearAppDataDialog();
});

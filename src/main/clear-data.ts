import { app, dialog, ipcMain } from 'electron';
import fs from 'fs-extra';

import { logger } from './log';
import {
	getFilesystemNodeBasePath,
	getLegacySqliteBasePath,
	getSqliteBasePath,
} from './rxdb-storage';
import { t } from './translations';

import type { ClearDataRequestResult } from '../ipc-channels';

const CLEAR_APP_DATA_ON_STARTUP_ARG = '--clear-app-data-on-startup';

const getDbFolders = () => [
	getSqliteBasePath(),
	getLegacySqliteBasePath(),
	getFilesystemNodeBasePath(),
];

const getRelaunchArgs = () => [
	...process.argv.slice(1).filter((arg) => arg !== CLEAR_APP_DATA_ON_STARTUP_ARG),
	CLEAR_APP_DATA_ON_STARTUP_ARG,
];

const clearAppDataFolders = async () => {
	const dbFolders = getDbFolders();

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

export const askToClearAppData = async (): Promise<ClearDataRequestResult> => {
	const clearAppDataMessage = t(
		'By clicking proceed you will be removing all added accounts and preferences for WCPOS. ' +
			'When the application restarts, it will be as if you are starting WCPOS for the first time.'
	);

	const { response } = await dialog.showMessageBox({
		type: 'warning',
		buttons: [t('common.yes'), t('common.no')],
		cancelId: 1, // Esc must mean No; the default only finds an untranslated "No" label
		message: t('app.are_you_sure'),
		detail: clearAppDataMessage,
	});

	if (response !== 0) return 'declined';

	// Quit on a later macrotask: the invoke reply must reach the renderer before the
	// quit starts, so the renderer can stop hydrating.
	setImmediate(() => {
		// Relaunch before deleting the db folders so no active storage connections
		// can write to files while Clear data removes them.
		try {
			app.relaunch({ args: getRelaunchArgs() });
			app.quit();
		} catch (err) {
			logger.error(t('app.could_not_clear_app_data'), err);
		}
	});
	return 'relaunching';
};

export const clearAppDataDialog = () => {
	askToClearAppData().catch((err) => logger.error(t('app.could_not_clear_app_data'), err));
};

ipcMain.on('clearData', (event, args) => {
	clearAppDataDialog();
});

ipcMain.handle('clearData:request', () => askToClearAppData());

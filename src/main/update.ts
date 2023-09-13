import fs from 'fs';

/**
 * The default autoUpdater downloads the update automatically
 * For the moment I will use electron-updater, but could be replaced with the default
 * with a custom checkForUpdates function
 */
import { dialog, MenuItem, app, autoUpdater } from 'electron';
// import { autoUpdater } from 'electron-updater';

import log from './log';
import { t } from './translations';

let updater: MenuItem | undefined;
let isSilentCheck = true;
// autoUpdater.autoDownload = false;

const server = 'https://updates.wcpos.com';
const url = `${server}/electron/${process.platform}-${process.arch}/${app.getVersion()}`;

autoUpdater.setFeedURL({ url });

autoUpdater.on('error', (error) => {
	dialog.showErrorBox('Error: ', error == null ? 'unknown' : (error.stack || error).toString());
});

// autoUpdater.on('update-available', () => {
// 	dialog
// 		.showMessageBox({
// 			type: 'info',
// 			title: t('Found Updates', { _tags: 'electron' }),
// 			message: t('Found updates, do you want update now?', { _tags: 'electron' }),
// 			buttons: [t('Yes'), t('No')],
// 		})
// 		.then(({ response }) => {
// 			if (response === 0) {
// 				autoUpdater.downloadUpdate().catch((err) => {
// 					log.error('Error downloading update', err);
// 					if (err.message && err.message.includes('file already exists') && err.path) {
// 						// If the file already exists, then it's probably a partial download
// 						// so we'll just delete it and try again
// 						// fs.unlinkSync(err.path);
// 						// autoUpdater.downloadUpdate();
// 					}
// 				});
// 			} else if (updater) {
// 				updater.enabled = true;
// 				updater = undefined;
// 			}
// 		});
// });

autoUpdater.on('update-not-available', () => {
	if (!isSilentCheck) {
		dialog.showMessageBox({
			title: t('No Updates', { _tags: 'electron' }),
			message: t('Current version is up-to-date.', { _tags: 'electron' }),
		});
		if (updater) {
			updater.enabled = true;
			updater = undefined;
		}
	}
});

autoUpdater.on('update-downloaded', () => {
	dialog
		.showMessageBox({
			title: t('Install Updates', { _tags: 'electron' }),
			message: t('Updates downloaded, application will restart for update to take effect.', {
				_tags: 'electron',
			}),
		})
		.then(() => {
			setImmediate(() => autoUpdater.quitAndInstall());
		});
});

const canUpdate = () => {
	// TODO: Figure out how to resolve the protected app access error
	const _au: any = autoUpdater;
	// Don't check for updates if update config is not found (auto-update via electron is not supported)
	return _au.app && _au.app.appUpdateConfigPath && fs.existsSync(_au.app.appUpdateConfigPath);
};

export const setupAutoUpdates = () => {
	// if (!canUpdate()) {
	// 	return;
	// }

	// log.transports.file.level = 'info';
	// autoUpdater.logger = log;
	// autoUpdater.checkForUpdatesAndNotify();
	autoUpdater.checkForUpdates();
};

// export this to MenuItem click callback
export function checkForUpdates(menuItem, focusedWindow, event) {
	// if (!canUpdate()) {
	// 	return;
	// }

	if (menuItem) {
		updater = menuItem;
		updater.enabled = false;
	}
	isSilentCheck = false;
	autoUpdater.checkForUpdates();
}

export default autoUpdater;

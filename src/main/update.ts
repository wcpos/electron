import fs from 'fs';
import { dialog, MenuItem } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from './log';

let updater: MenuItem | undefined;
let isSilentCheck = true;
autoUpdater.autoDownload = false;

autoUpdater.on('error', (error) => {
	dialog.showErrorBox('Error: ', error == null ? 'unknown' : (error.stack || error).toString());
});

autoUpdater.on('update-available', () => {
	dialog
		.showMessageBox({
			type: 'info',
			title: 'Found Updates',
			message: 'Found updates, do you want update now?',
			buttons: ['Yes', 'No'],
		})
		.then(({ response }) => {
			if (response === 0) {
				autoUpdater.downloadUpdate().catch((err) => {
					log.error('Error downloading update', err);
					if (err.message && err.message.includes('file already exists') && err.path) {
						// If the file already exists, then it's probably a partial download
						// so we'll just delete it and try again
						// fs.unlinkSync(err.path);
						// autoUpdater.downloadUpdate();
					}
				});
				autoUpdater.downloadUpdate();
			} else if (updater) {
				updater.enabled = true;
				updater = undefined;
			}
		});
});

autoUpdater.on('update-not-available', () => {
	if (!isSilentCheck) {
		dialog.showMessageBox({
			title: 'No Updates',
			message: 'Current version is up-to-date.',
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
			title: 'Install Updates',
			message: 'Updates downloaded, application will be quit for update...',
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
	if (!canUpdate()) {
		return;
	}

	log.transports.file.level = 'info';
	autoUpdater.logger = log;
	// autoUpdater.checkForUpdatesAndNotify();
	autoUpdater.checkForUpdates();
};

// export this to MenuItem click callback
export function checkForUpdates(menuItem, focusedWindow, event) {
	if (!canUpdate()) {
		return;
	}

	if (menuItem) {
		updater = menuItem;
		updater.enabled = false;
	}
	isSilentCheck = false;
	autoUpdater.checkForUpdates();
}

export default autoUpdater;

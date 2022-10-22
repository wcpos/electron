import { dialog, app } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from './log';

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// -------------------------------------------------------------------
// Auto updates - Option 1 - Simplest version
//
// This will immediately download an update, then install when the
// app quits.
// -------------------------------------------------------------------
app.on('ready', function () {
	autoUpdater.checkForUpdatesAndNotify();
});

// -------------------------------------------------------------------
// Auto updates - Option 2 - More control
//
// For details about these events, see the Wiki:
// https://github.com/electron-userland/electron-builder/wiki/Auto-Update#events
//
// The app doesn't need to listen to any events except `update-downloaded`
//
// Uncomment any of the below events to listen for them.  Also,
// look in the previous section to see them being used.
// -------------------------------------------------------------------
// app.on('ready', function()  {
//   autoUpdater.checkForUpdates();
// });
// autoUpdater.on('checking-for-update', () => {
// })
// autoUpdater.on('update-available', (info) => {
// })
// autoUpdater.on('update-not-available', (info) => {
// })
// autoUpdater.on('error', (err) => {
// })
// autoUpdater.on('download-progress', (progressObj) => {
// })
// autoUpdater.on('update-downloaded', (info) => {
//   autoUpdater.quitAndInstall();
// })

// -------------------------------------------------------------------
// Manual updates
//
// -------------------------------------------------------------------
let updater;
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
			buttons: ['Sure', 'No'],
		})
		.then((buttonIndex) => {
			if (buttonIndex === 0) {
				autoUpdater.downloadUpdate();
			} else {
				updater.enabled = true;
				updater = null;
			}
		});
});

autoUpdater.on('update-not-available', () => {
	dialog.showMessageBox({
		title: 'No Updates',
		message: 'Current version is up-to-date.',
	});
	updater.enabled = true;
	updater = null;
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

// export this to MenuItem click callback
function checkForUpdates(menuItem, focusedWindow, event) {
	updater = menuItem;
	updater.enabled = false;
	autoUpdater.checkForUpdates();
}

export { checkForUpdates };
export default autoUpdater;

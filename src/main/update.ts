// Use GitHub releases to detect new versions prompt user to update the app.
// @see https://www.electronforge.io/advanced/auto-update
// @see https://github.com/electron/update-electron-app
import autoUpdate from 'update-electron-app';
import logger from 'electron-log';

/**
 *
 */
export const checkForUpdates = () => {
	autoUpdate({
		repo: 'wcpos/electron',
		updateInterval: '1 hour',
		logger,
	});
};

/**
 * From ERB
 */
// export default class AppUpdater {
// 	constructor() {
// 		log.transports.file.level = 'info';
// 		autoUpdater.logger = log;
// 		autoUpdater.checkForUpdatesAndNotify();
// 	}
// }

/**
 * From https://github.com/DeniKucevic/electron-mini-subscription-manager
 */
// autoUpdater.on('update-not-available', (_event, releaseNotes, releaseName) => {
//   const translations = getUpdateNotAvailableMessage();
//   const dialogOpts = {
//     type: 'info',
//     buttons: translations.buttons,
//     title: translations.title,
//     message: process.platform === 'win32' ? releaseNotes : releaseName,
//     detail: translations.message,
//   };
//   if (mainWindow) {
//     dialog.showMessageBox(mainWindow, dialogOpts);
//   }
// });

// autoUpdater.on('update-available', (_event, releaseNotes, releaseName) => {
//   const translations = getUpdateAvailableMessage();
//   const dialogOpts = {
//     type: 'info',
//     buttons: translations.buttons,
//     title: translations.title,
//     message: process.platform === 'win32' ? releaseNotes : releaseName,
//     detail: translations.detail,
//   };
//   if (mainWindow) {
//     dialog.showMessageBox(mainWindow, dialogOpts);
//   }
// });

// autoUpdater.on('error', (error) => {
//   dialog.showErrorBox(
//     'Error: ',
//     error == null ? 'unknown' : (error.stack || error).toString()
//   );
// });

// autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
//   const translations = getUpdateDownloaded();
//   const dialogOpts = {
//     type: 'info',
//     buttons: translations.buttons,
//     title: translations.title,
//     message: process.platform === 'win32' ? releaseNotes : releaseName,
//     detail: translations.detail,
//   };
//   dialog
//     .showMessageBox(dialogOpts)
//     .then((returnValue) => {
//       if (returnValue.response === 0) autoUpdater.quitAndInstall();
//     })
//     .catch((err) => {
//       if (mainWindow) dialog.showErrorBox('error updating', err);
//     });
// });

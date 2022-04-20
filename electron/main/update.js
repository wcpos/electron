// Use GitHub releases to detect new versions prompt user to update the app.
// @see https://www.electronforge.io/advanced/auto-update
// @see https://github.com/electron/update-electron-app
import autoUpdate from 'update-electron-app';
import logger from 'electron-log';

export const checkForUpdates = () => {
	autoUpdate({
		repo: 'wcpos/electron',
		updateInterval: '1 hour',
		logger,
	});
};

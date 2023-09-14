import fs from 'fs';
import path from 'path';
import * as stream from 'stream';
import { promisify } from 'util';

import axios from 'axios';
import { dialog, MenuItem, app, autoUpdater } from 'electron';
import semver from 'semver';

import logger from './log';
import ProgressBar from './progress-bar';
import { t } from './translations';
import { createDir, isDevelopment } from './util';
import { getMainWindow } from './window';

interface Asset {
	url: string;
	name: string;
	contentType: string;
	size: number;
}

interface LatestRelease {
	version: string;
	name: string;
	releaseDate: string;
	notes: string;
	assets: Asset[];
}

const server = isDevelopment ? 'http://localhost:8080' : 'https://updates.wcpos.com';

export const setupAutoUpdates = () => {};

/**
 *
 */
function getUpdatesAPI() {
	const url = `${server}/electron/${process.platform}-${process.arch}/${app.getVersion()}`;
	return url;
}

/**
 *
 */
function getTmpDirectory() {
	const tempDirPath = path.join(app.getPath('temp'), 'NTWRK');
	createDir(tempDirPath);
	return tempDirPath;
}

/**
 *
 */
async function download(name: string, url: string, showProgress = true): Promise<void> {
	const finished = promisify(stream.finished);
	const tempDirPath = getTmpDirectory();
	const filePath = `${tempDirPath}/${name}`;
	const writer = fs.createWriteStream(filePath, { flags: 'w+' });
	const { data, headers } = await axios.get(url, { responseType: 'stream' });

	if (showProgress || name !== 'RELEASES') {
		let loaded = 0;
		const total = parseFloat(headers['content-length']);
		const progressBar = new ProgressBar();
		data.on('data', (chunk: string) => {
			loaded += Buffer.byteLength(chunk);
			const percentCompleted = Math.floor((loaded / total) * 100);
			// logger.info(`Downloaded ${percentCompleted}%`);
			progressBar.updateProgress(percentCompleted);
			if (percentCompleted === 100) {
				progressBar.close();
			}
		});
	}

	data.pipe(writer);
	return finished(writer);
}

/**
 *
 */
async function installUpdates() {
	return new Promise((_resolve, reject) => {
		autoUpdater.on('error', (error: Error) => reject(error));
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

		const tempDirPath = getTmpDirectory();
		autoUpdater.setFeedURL({ url: tempDirPath });
		autoUpdater.checkForUpdates();
	});
}

/**
 *
 */
async function downloadAndInstallUpdates(assets: Asset[]) {
	try {
		await Promise.all(assets.map((asset) => download(asset.name, asset.url)));
		// await installUpdates();
	} catch (error) {
		logger.error('Error applying the updates', error);
	}
}

/**
 *
 */
async function confirmUpdateDialog(version, name, releaseDate, notes) {
	const mainWindow = getMainWindow();
	return dialog
		.showMessageBox(mainWindow, {
			type: 'question',
			title: t('Found Updates', { _tags: 'electron' }),
			message: t('Found updates, do you want update now?', { _tags: 'electron' }),
			detail: t('New version: {version}', { version }),
			buttons: [t('Yes'), t('No')],
		})
		.then(({ response }) => response === 0);
}

/**
 * Check for updates, this runs on startup and every hour
 * - if no updates, do nothing
 * - if updates, asks user if they want to download and install
 */
export async function checkForUpdates() {
	try {
		const { data } = await axios.get(getUpdatesAPI());
		const { version, name, assets, releaseDate, notes } = data;
		const hasUpdate = semver.gt(version, app.getVersion());

		// early exit if no updates
		if (!hasUpdate) {
			return false;
		}

		const confirmUpdate = await confirmUpdateDialog(version, name, releaseDate, notes);

		if (confirmUpdate) {
			downloadAndInstallUpdates(assets);
		}

		return true;
	} catch (err) {
		logger.error('Error checking for updates', err);
	}
}

/**
 * Manual check for updates
 */
export async function manualCheckForUpdates(menuItem: MenuItem) {
	// if manual check, then disable the menu item until we're done
	if (menuItem) {
		menuItem.enabled = false;
	}

	// check updates.wcpos.com for the latest version
	try {
		const hasUpdate = await checkForUpdates();
		if (hasUpdate === false) {
			const mainWindow = getMainWindow();
			dialog.showMessageBox(mainWindow, {
				title: t('No Updates', { _tags: 'electron' }),
				message: t('Current version is up-to-date.', { _tags: 'electron' }),
			});
		}
	} finally {
		// if manual check, then re-enable the menu item
		if (menuItem) {
			menuItem.enabled = true;
		}
	}
}

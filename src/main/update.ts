import { createWriteStream, createReadStream, stat } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import * as stream from 'stream';
import { promisify } from 'util';

import axios from 'axios';
import { dialog, MenuItem, app, autoUpdater, shell } from 'electron';
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

export const setupAutoUpdates = () => {
	// Check for updates immediately on startup
	checkForUpdates().catch((error) => {
		logger.error('Error checking for updates on startup', error);
	});

	// Check for updates every hour
	setInterval(() => {
		checkForUpdates().catch((error) => {
			logger.error('Error checking for updates in interval', error);
		});
	}, 3600 * 1000); // 3600 * 1000 ms equals 1 hour
};

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
function getProxyUrl(tempDirPath: string): Promise<string> {
	const server = createServer();

	server.on('request', async (request: IncomingMessage, response: ServerResponse) => {
		const requestUrl = request.url!;
		if (requestUrl.endsWith('.zip')) {
			try {
				const downloadedFile = path.join(tempDirPath, path.basename(requestUrl));
				const fileStat = await promisify(stat)(downloadedFile);
				const updateFileSize = fileStat.size;

				const readStream = createReadStream(downloadedFile);
				response.writeHead(200, {
					'Content-Type': 'application/zip',
					'Content-Length': updateFileSize,
				});
				readStream.pipe(response);
			} catch (error) {
				response.writeHead(500);
				response.end(`Internal Server Error: ${error.message}`);
			}
		} else {
			response.writeHead(404);
			response.end('Not Found');
		}
	});

	return new Promise((resolve, reject) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address && typeof address === 'object') {
				const serverUrl = `http://127.0.0.1:${address.port}`;
				resolve(serverUrl);
			} else {
				reject(new Error('Failed to obtain server address'));
			}
		});
	});
}

/**
 *
 */
async function download(name: string, url: string, showProgress = true): Promise<void> {
	const finished = promisify(stream.finished);
	const tempDirPath = getTmpDirectory();
	const filePath = `${tempDirPath}/${name}`;
	const writer = createWriteStream(filePath, { flags: 'w+' });
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
	const tempDirPath = getTmpDirectory();
	let url = tempDirPath; // just a path works fine for windows

	if (process.platform === 'linux') {
		// I'm not sure what to do here, just open the temp direct and let the user install it?
		shell.showItemInFolder(tempDirPath);
		return; // don't continue
	}

	if (process.platform === 'darwin') {
		// mac needs a server :/ electron-updater uses a similar method to get around this
		url = await getProxyUrl(tempDirPath);
	}

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

		autoUpdater.setFeedURL({ url });
		autoUpdater.checkForUpdates();
	});
}

/**
 *
 */
async function downloadAndInstallUpdates(assets: Asset[]) {
	try {
		await Promise.all(assets.map((asset) => download(asset.name, asset.url)));
		await installUpdates();
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
		const hasUpdate = semver.gt(semver.coerce(version), semver.coerce(app.getVersion()));

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

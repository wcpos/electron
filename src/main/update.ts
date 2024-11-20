import { createWriteStream, writeFileSync } from 'fs';
import path from 'path';
import * as stream from 'stream';
import { promisify } from 'util';

import axios from 'axios';
import { dialog, MenuItem, app, autoUpdater, shell, BrowserWindow } from 'electron';
import Store from 'electron-store';
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

const REMIND_LATER_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const updateServer = isDevelopment ? 'http://localhost:8080' : 'https://updates.wcpos.com';
const store = new Store();

export class AutoUpdater {
	private mainWindow: BrowserWindow;
	private targetPath: string;
	private tempDirPath: string;
	private readonly updateUrl = `${updateServer}/electron/${process.platform}-${process.arch}/${app.getVersion()}`;

	constructor() {
		this.targetPath = '';
		this.mainWindow = getMainWindow();

		const tempDirPath = path.join(app.getPath('temp'), 'NTWRK');
		createDir(tempDirPath);
		this.tempDirPath = tempDirPath;
	}

	public init() {
		// Check for updates immediately on startup
		this.checkForUpdates().catch((error) => {
			logger.error('Error checking for updates on startup', error);
		});

		// Check for updates every hour
		setInterval(() => {
			this.checkForUpdates().catch((error) => {
				logger.error('Error checking for updates in interval', error);
			});
		}, 3600 * 1000); // 1 hour interval
	}

	private async download(name: string, url: string, showProgress = true): Promise<void> {
		const finished = promisify(stream.finished);
		const filePath = `${this.tempDirPath}/${name}`;
		const writer = createWriteStream(filePath, { flags: 'w+' });
		const { data, headers } = await axios.get(url, { responseType: 'stream' });

		if (name !== 'RELEASES') {
			this.targetPath = filePath;
		}

		if (showProgress || name !== 'RELEASES') {
			let loaded = 0;
			const total = parseFloat(headers['content-length']);
			const progressBar = new ProgressBar();
			data.on('data', (chunk: string) => {
				loaded += Buffer.byteLength(chunk);
				const percentCompleted = Math.floor((loaded / total) * 100);
				progressBar.updateProgress(percentCompleted);
				if (percentCompleted === 100) {
					progressBar.close();
				}
			});
		}

		data.pipe(writer);
		return finished(writer);
	}

	private async installUpdates() {
		let feedURL = this.tempDirPath;

		if (!this.targetPath) {
			throw new Error('No update file downloaded');
		}

		if (process.platform === 'darwin') {
			const json = { url: `file://${this.targetPath}` };
			writeFileSync(this.tempDirPath + '/feed.json', JSON.stringify(json));
			feedURL = `file://${this.tempDirPath}/feed.json`;
		}

		if (process.platform === 'linux') {
			shell.showItemInFolder(this.targetPath);
			return;
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

			autoUpdater.setFeedURL({ url: feedURL });
			autoUpdater.checkForUpdates();
		});
	}

	private async downloadAndInstallUpdates(assets: Asset[]) {
		try {
			await Promise.all(assets.map((asset) => this.download(asset.name, asset.url)));
			await this.installUpdates();
		} catch (error) {
			logger.error('Error applying the updates', error, error.stack);
			if (this.targetPath) {
				shell.showItemInFolder(this.targetPath);
			}
		}
	}

	private async confirmUpdateDialog(
		version: string,
		name: string,
		releaseDate: string,
		notes: string
	) {
		const { response } = await dialog.showMessageBox(this.mainWindow, {
			type: 'question',
			title: t('Found Updates', { _tags: 'electron' }),
			message: t('A new version ({version}) is available. Do you want to update now?', { version }),
			buttons: [t('Yes'), t('Remind me later'), t('No')],
			cancelId: 2, // Index of 'No' button
		});

		return response;
	}

	public async checkForUpdates(manual = false) {
		const remindLaterTimestamp = store.get('remindLaterTimestamp', 0);
		const now = Date.now();

		if (!manual && remindLaterTimestamp && now - remindLaterTimestamp < REMIND_LATER_DURATION) {
			logger.info('Update check skipped due to Remind me later selection.');
			return false;
		}

		this.targetPath = '';

		try {
			const response = await axios.get(this.updateUrl);
			const data = response.data?.data || response.data;
			const { version, name, assets, releaseDate, notes } = data;
			const hasUpdate = semver.gt(semver.coerce(version), semver.coerce(app.getVersion()));

			if (!hasUpdate) {
				return false;
			}

			const userChoice = await this.confirmUpdateDialog(version, name, releaseDate, notes);

			if (userChoice === 0) {
				this.downloadAndInstallUpdates(assets);
			} else if (userChoice === 1) {
				store.set('remindLaterTimestamp', Date.now());
			} else {
				logger.info('User chose not to update.');
			}

			return true;
		} catch (err) {
			logger.error('Error checking for updates', err);
		}
	}

	public async manualCheckForUpdates(menuItem: MenuItem) {
		if (menuItem) {
			menuItem.enabled = false;
		}

		try {
			const hasUpdate = await this.checkForUpdates(true);
			if (hasUpdate === false) {
				dialog.showMessageBox(this.mainWindow, {
					title: t('No Updates', { _tags: 'electron' }),
					message: t('Current version is up-to-date.', { _tags: 'electron' }),
				});
			}
		} finally {
			if (menuItem) {
				menuItem.enabled = true;
			}
		}
	}
}

// Usage
export const updater = new AutoUpdater();

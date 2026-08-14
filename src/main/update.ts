import { createWriteStream, writeFileSync } from 'fs';
import path from 'path';
import * as stream from 'stream';
import { promisify } from 'util';

import axios from 'axios';
import { app, autoUpdater, BrowserWindow, dialog, MenuItem, shell } from 'electron';
import Store from 'electron-store';
import semver from 'semver';

import { logger } from './log';
import { ProgressBar } from './progress-bar';
import { t } from './translations';
import { createDir, isDevelopment } from './util';

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

interface UpdateStoreSchema extends Record<string, unknown> {
	remindLaterTimestamp: number;
}

const REMIND_LATER_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const updateServer = isDevelopment ? 'http://localhost:8080' : 'https://updates.wcpos.com';
const store = new Store<UpdateStoreSchema>();

export interface UpdaterHandle {
	init: () => void;
	manualCheckForUpdates: (menuItem: MenuItem) => Promise<void>;
	setMainWindow: (mainWindow: BrowserWindow) => void;
}

export class AutoUpdater implements UpdaterHandle {
	private mainWindow: BrowserWindow;
	private targetPath: string;
	private tempDirPath: string;
	private readonly updateUrl = `${updateServer}/electron/${process.platform}-${process.arch}/${app.getVersion()}`;

	constructor(mainWindow: BrowserWindow) {
		this.targetPath = '';
		this.mainWindow = mainWindow;

		const tempDirPath = path.join(app.getPath('temp'), 'NTWRK');
		createDir(tempDirPath);
		this.tempDirPath = tempDirPath;
	}

	public setMainWindow(mainWindow: BrowserWindow): void {
		this.mainWindow = mainWindow;
	}

	// On macOS the app outlives its windows: after window-all-closed the stored window
	// is destroyed until 'activate' recreates one. A destroyed parent makes
	// dialog.showMessageBox throw, so fall back to an unparented dialog.
	private dialogParent(): BrowserWindow | undefined {
		return this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : undefined;
	}

	public init() {
		if (isDevelopment) {
			logger.info('Skipping auto-update in development mode');
			return;
		}

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
		const pipeline = promisify(stream.pipeline);
		const filePath = `${this.tempDirPath}/${name}`;
		const writer = createWriteStream(filePath, { flags: 'w+' });
		const { data, headers } = await axios.get(url, { responseType: 'stream' });

		if (name !== 'RELEASES') {
			this.targetPath = filePath;
		}

		let progressBar: ProgressBar | undefined;
		if (showProgress || name !== 'RELEASES') {
			let loaded = 0;
			const contentLengthHeader = headers['content-length'];
			const total =
				typeof contentLengthHeader === 'number'
					? contentLengthHeader
					: typeof contentLengthHeader === 'string'
						? parseFloat(contentLengthHeader)
						: 0;
			progressBar = new ProgressBar();
			data.on('data', (chunk: string) => {
				loaded += Buffer.byteLength(chunk);
				const percentCompleted = Math.floor((loaded / total) * 100);
				progressBar?.updateProgress(percentCompleted);
				if (percentCompleted === 100) {
					progressBar?.close();
					progressBar = undefined;
				}
			});
		}

		try {
			await pipeline(data, writer);
		} catch (error) {
			progressBar?.close();
			throw error;
		}
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
						title: t('update.install_updates'),
						message: t('update.updates_downloaded_application_will_restart_for'),
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
		const options = {
			type: 'question' as const,
			title: t('update.found_updates'),
			message: t('update.a_new_version_is_available_do', { version }),
			buttons: [t('common.yes'), t('update.remind_me_later'), t('common.no')],
			cancelId: 2, // Index of 'No' button
		};
		const parent = this.dialogParent();
		const { response } = parent
			? await dialog.showMessageBox(parent, options)
			: await dialog.showMessageBox(options);

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
				const options = {
					title: t('update.no_updates'),
					message: t('update.current_version_is_up-to-date'),
				};
				const parent = this.dialogParent();
				if (parent) {
					dialog.showMessageBox(parent, options);
				} else {
					dialog.showMessageBox(options);
				}
			}
		} finally {
			if (menuItem) {
				menuItem.enabled = true;
			}
		}
	}
}

let activeUpdater: AutoUpdater | null = null;

export const setUpdater = (nextUpdater: AutoUpdater): AutoUpdater => {
	activeUpdater = nextUpdater;
	return nextUpdater;
};

const getUpdater = (): AutoUpdater => {
	if (!activeUpdater) {
		throw new Error('AutoUpdater has not been configured');
	}

	return activeUpdater;
};

// Stable menu-facing handle. It resolves to the boot-configured updater at use time.
export const updater: UpdaterHandle = {
	init: () => getUpdater().init(),
	manualCheckForUpdates: (menuItem: MenuItem) => getUpdater().manualCheckForUpdates(menuItem),
	setMainWindow: (mainWindow: BrowserWindow) => getUpdater().setMainWindow(mainWindow),
};

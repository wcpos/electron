import { createWriteStream, createReadStream, stat } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import * as stream from 'stream';
import { promisify } from 'util';

import axios from 'axios';
import { dialog, MenuItem, app, autoUpdater, shell, BrowserWindow } from 'electron';
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

/**
 *
 */
const updateServer = isDevelopment ? 'http://localhost:8080' : 'https://updates.wcpos.com';

/**
 *
 */
export class AutoUpdater {
	private mainWindow: BrowserWindow;
	private targetPath: string;
	private tempDirPath: string;
	private readonly updateUrl = `${updateServer}/electron/${process.platform}-${
		process.arch
	}/${app.getVersion()}`;

	constructor() {
		this.targetPath = '';
		this.mainWindow = getMainWindow();

		// maybe create tmp directory
		// NTWRK allows windows to access as web server
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
		}, 3600 * 1000); // 3600 * 1000 ms equals 1 hour
	}

	/**
	 * Following MacUpdater from electron-updater
	 */
	private async createProxyServer(): Promise<string> {
		const server = createServer();

		server.on('request', async (request: IncomingMessage, response: ServerResponse) => {
			if (!request.url) {
				response.writeHead(400);
				response.end('Bad Request: URL is required');
				return;
			}

			const requestUrl = new URL(request.url, `http://${request.headers.host}`);
			const fileParam = requestUrl.searchParams.get('file');

			if (fileParam === this.targetPath) {
				try {
					const fileStat = await promisify(stat)(this.targetPath);
					const updateFileSize = fileStat.size;
					logger.info(`Serving update file: ${this.targetPath}`);
					logger.info(`Update file size: ${updateFileSize}`);

					const readStream = createReadStream(this.targetPath);
					response.writeHead(200, {
						'Content-Type': 'application/zip',
						'Content-Length': updateFileSize,
					});
					readStream.pipe(response);
				} catch (error) {
					logger.error('Error handling .zip file request', error);
					response.writeHead(500);
					response.end(`Internal Server Error: ${error.message}`);
				}
			} else {
				const address = server.address();
				if (address && typeof address === 'object') {
					const serverUrl = `http://127.0.0.1:${address.port}/?file=${path.basename(
						this.targetPath
					)}`;
					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ url: serverUrl }));
				} else {
					response.writeHead(500);
					response.end('Internal Server Error: Failed to obtain server address');
				}
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

	private async download(name: string, url: string, showProgress = true): Promise<void> {
		const finished = promisify(stream.finished);
		const filePath = `${this.tempDirPath}/${name}`;
		const writer = createWriteStream(filePath, { flags: 'w+' });
		const { data, headers } = await axios.get(url, { responseType: 'stream' });

		// if not RELEASES, set target path
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

	private async installUpdates() {
		let url = this.tempDirPath; // just a path works fine for windows

		// we should have a downloaded target path now
		if (!this.targetPath) {
			throw new Error('No update file downloaded');
		}

		if (process.platform === 'linux') {
			// I'm not sure what to do here, just open the temp direct and let the user install it?
			shell.showItemInFolder(this.targetPath);
			return; // don't continue
		}

		if (process.platform === 'darwin') {
			// mac needs a server :/ electron-updater uses a similar method to get around this
			url = await this.createProxyServer();
		}

		// run the default autoUpdater to finish the job
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

	private async downloadAndInstallUpdates(assets: Asset[]) {
		try {
			await Promise.all(assets.map((asset) => this.download(asset.name, asset.url)));
			await this.installUpdates();
		} catch (error) {
			logger.error('Error applying the updates', error, error.stack);
			/**
			 * At the very least, we should open the temp directory
			 */
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
		return dialog
			.showMessageBox(this.mainWindow, {
				type: 'question',
				title: t('Found Updates', { _tags: 'electron' }),
				message: t('Found updates, do you want update now?', { _tags: 'electron' }),
				detail: t('New version: {version}', { version }),
				buttons: [t('Yes'), t('No')],
			})
			.then(({ response }) => response === 0);
	}

	public async checkForUpdates() {
		// reset target path, just in case
		this.targetPath = '';

		try {
			const { data } = await axios.get(this.updateUrl);
			const { version, name, assets, releaseDate, notes } = data;
			const hasUpdate = semver.gt(semver.coerce(version), semver.coerce(app.getVersion()));

			// early exit if no updates
			if (!hasUpdate) {
				return false;
			}

			const confirmUpdate = await this.confirmUpdateDialog(version, name, releaseDate, notes);

			if (confirmUpdate) {
				this.downloadAndInstallUpdates(assets);
			}

			return true;
		} catch (err) {
			logger.error('Error checking for updates', err);
		}
	}

	public async manualCheckForUpdates(menuItem: MenuItem) {
		// if manual check, then disable the menu item until we're done
		if (menuItem) {
			menuItem.enabled = false;
		}

		// check updates.wcpos.com for the latest version
		try {
			const hasUpdate = await this.checkForUpdates();
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
}

// Usage
export const updater = new AutoUpdater();

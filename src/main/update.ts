import { createWriteStream, writeFileSync } from 'fs';
import path from 'path';
import * as stream from 'stream';
import { promisify } from 'util';

import { app, autoUpdater, BrowserWindow, dialog, MenuItem, net, shell } from 'electron';
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
// Deadline for fetching and reading the release manifest. Checks that arrive while one is in
// flight join it rather than starting another, so a manifest request that stalls (proxy,
// captive portal) must fail on its own rather than hold every later check. The manifest is
// a few KB; 30 s is generous for it and well inside the hourly cadence.
const UPDATE_CHECK_TIMEOUT = 30 * 1000;
const updateServer = isDevelopment ? 'http://localhost:8080' : 'https://updates.wcpos.com';
const store = new Store<UpdateStoreSchema>();

export interface UpdaterHandle {
	init: () => void;
	manualCheckForUpdates: (menuItem: MenuItem) => Promise<void>;
	setMainWindow: (mainWindow: BrowserWindow) => void;
}

export class AutoUpdater implements UpdaterHandle {
	private mainWindow: BrowserWindow;
	private tempDirPath: string;
	private readonly updateUrl = `${updateServer}/electron/${process.platform}-${process.arch}/${app.getVersion()}`;
	// The check in progress, if any. A check blocks on the "Found Updates" dialog until the
	// user answers it, and the hourly timer keeps firing meanwhile: an app left open overnight
	// used to queue one dialog per hour behind the first, each revealed as the previous one
	// was dismissed. While this is set, further checks join it instead of starting another.
	private inFlight: Promise<boolean | undefined> | null = null;

	constructor(mainWindow: BrowserWindow) {
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
		// A next-lane build (1.11.0-next.57) is a tester's install: the update server only ever
		// serves the latest stable release, which would "upgrade" it back to the release lane
		// every hour. Manual checks still work for whoever wants that.
		// semver prerelease identifiers follow the first hyphen (1.11.0-next.57); the local
		// semver typings expose no parse(), and a hyphen is the whole test.
		if (app.getVersion().includes('-')) {
			logger.info('Skipping scheduled update checks on a prerelease build', app.getVersion());
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

	// Resolves with the downloaded installer's path (undefined for the Windows RELEASES
	// manifest). The path is returned rather than stored on the instance: a check that
	// starts while a download is streaming must not be able to clear it.
	private async download(
		name: string,
		url: string,
		showProgress = true
	): Promise<string | undefined> {
		const pipeline = promisify(stream.pipeline);
		const filePath = `${this.tempDirPath}/${name}`;
		// Chromium's stack (net.fetch): downloads honor the system proxy and OS trust
		// store — a corporate-proxy network must not silently break auto-update while
		// the migrated app transport (main/http-bridge.ts) keeps working.
		const response = await net.fetch(url);
		if (!response.ok || !response.body) {
			throw new Error(`Update download failed: HTTP ${response.status} for ${name}`);
		}
		// The writer opens only after the response validates, so an early failure
		// never leaks the file descriptor.
		const writer = createWriteStream(filePath, { flags: 'w+' });
		const data = stream.Readable.fromWeb(response.body as import('stream/web').ReadableStream);

		let progressBar: ProgressBar | undefined;
		const total = Number(response.headers.get('content-length')) || 0;
		// No Content-Length means no denominator — skip the bar rather than feed
		// it Infinity.
		if ((showProgress || name !== 'RELEASES') && total > 0) {
			let loaded = 0;
			progressBar = new ProgressBar();
			data.on('data', (chunk: Buffer) => {
				loaded += chunk.length;
				progressBar?.updateProgress(Math.floor((loaded / total) * 100));
			});
		}

		try {
			await pipeline(data, writer);
		} finally {
			progressBar?.close();
			progressBar = undefined;
		}

		return name !== 'RELEASES' ? filePath : undefined;
	}

	private async installUpdates(targetPath: string) {
		let feedURL = this.tempDirPath;

		if (!targetPath) {
			throw new Error('No update file downloaded');
		}

		if (process.platform === 'darwin') {
			const json = { url: `file://${targetPath}` };
			writeFileSync(this.tempDirPath + '/feed.json', JSON.stringify(json));
			feedURL = `file://${this.tempDirPath}/feed.json`;
		}

		if (process.platform === 'linux') {
			shell.showItemInFolder(targetPath);
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
		let targetPath = '';
		try {
			const paths = await Promise.all(assets.map((asset) => this.download(asset.name, asset.url)));
			targetPath = paths.find((filePath) => Boolean(filePath)) ?? '';
			await this.installUpdates(targetPath);
		} catch (error) {
			logger.error('Error applying the updates', error, error.stack);
			// A finished download that failed to install is still useful: reveal it so
			// the user can run it by hand.
			if (targetPath) {
				shell.showItemInFolder(targetPath);
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

	public checkForUpdates(manual = false): Promise<boolean | undefined> {
		if (this.inFlight) {
			logger.info('Update check skipped: a previous check is still waiting on the user.');
			return this.inFlight;
		}

		this.inFlight = this.runCheck(manual).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async runCheck(manual: boolean): Promise<boolean | undefined> {
		const remindLaterTimestamp = store.get('remindLaterTimestamp', 0);
		const now = Date.now();

		if (!manual && remindLaterTimestamp && now - remindLaterTimestamp < REMIND_LATER_DURATION) {
			logger.info('Update check skipped due to Remind me later selection.');
			return false;
		}

		try {
			// The signal covers the body read as well, so a stall inside response.json() also
			// aborts. The user dialog that follows is deliberately not on a deadline.
			const signal = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT);
			const response = await net.fetch(this.updateUrl, { signal });
			if (!response.ok) {
				throw new Error(`Update check failed: HTTP ${response.status}`);
			}
			const payload = await response.json();
			const data = payload?.data || payload;
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

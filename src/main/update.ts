import { createWriteStream, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
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
// Each download directory is named for the process that owns it, so another process can tell
// a live download from a leftover without trusting a timestamp. mtime is not usable here: on
// Windows, the platform this matters on, a file's last-write time is not finalised while a
// write handle stays open, so a download running for hours can still report an early mtime.
const DOWNLOAD_DIR_PREFIX = 'update-';
// Backstop for the one case ownership cannot settle: the owning process is gone but its id has
// since been reused, so the directory looks live forever. A week is far longer than any
// download and still bounds the disk use.
const ORPHAN_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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
		this.sweepStaleDownloads();
	}

	// Each accepted update downloads into its own directory (see downloadAndInstallUpdates),
	// and an installed update restarts the app before anything could tidy up, so leftovers
	// from earlier runs are cleared here.
	//
	// Boot is NOT a moment when nothing is downloading: the app takes no single-instance
	// lock, so on Windows a second process can start while the first is mid-download. An
	// unconditional sweep deleted that download out from under it. A directory owned by a
	// process that is still running is left alone.
	private sweepStaleDownloads(): void {
		let entries: string[];
		try {
			entries = readdirSync(this.tempDirPath);
		} catch (error) {
			logger.warn('Could not list update downloads', error);
			return;
		}

		for (const entry of entries) {
			if (!entry.startsWith(DOWNLOAD_DIR_PREFIX)) continue;
			const dir = path.join(this.tempDirPath, entry);
			try {
				if (this.isOwnedByLiveProcess(entry) && !this.olderThan(dir, ORPHAN_DIR_MAX_AGE_MS)) {
					logger.info('Leaving an update download owned by a running process', dir);
					continue;
				}
				rmSync(dir, { recursive: true, force: true });
			} catch (error) {
				logger.warn('Could not sweep an update download', error);
			}
		}
	}

	// Directory names are `update-<pid>-<random>`. Signal 0 tests for the process without
	// touching it, on Windows too. An unparseable name predates this scheme, so it is a
	// leftover by definition and not owned.
	private isOwnedByLiveProcess(entry: string): boolean {
		const pid = Number(entry.slice(DOWNLOAD_DIR_PREFIX.length).split('-')[0]);
		if (!Number.isInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private olderThan(dir: string, ageMs: number): boolean {
		try {
			return statSync(dir).mtimeMs < Date.now() - ageMs;
		} catch {
			return false;
		}
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
		dir: string,
		name: string,
		url: string,
		showProgress = true
	): Promise<string | undefined> {
		const pipeline = promisify(stream.pipeline);
		const filePath = path.join(dir, name);
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

	// `dir` is the operation's download directory: on Windows Squirrel reads RELEASES and
	// the package from it, on macOS it holds the feed.json that points at the installer.
	private async installUpdates(dir: string, targetPath: string) {
		let feedURL = dir;

		if (!targetPath) {
			throw new Error('No update file downloaded');
		}

		if (process.platform === 'darwin') {
			const json = { url: `file://${targetPath}` };
			const feedPath = path.join(dir, 'feed.json');
			writeFileSync(feedPath, JSON.stringify(json));
			feedURL = `file://${feedPath}`;
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
		// Every accepted update downloads into its own directory. Two acceptances in one
		// session (the hourly check prompts again while a download is running) used to write
		// the same file names into the shared temp dir and truncate each other mid-stream.
		// The pid in the name is how another process's boot sweep knows this download is live.
		const dir = mkdtempSync(path.join(this.tempDirPath, `${DOWNLOAD_DIR_PREFIX}${process.pid}-`));
		let targetPath = '';
		try {
			// Recorded as each download finishes, not after all of them: on Windows the
			// installer and the RELEASES manifest download together, and a finished installer
			// should still be revealed below if its sibling fails. Windows also ships the
			// Squirrel package (.nupkg) beside the setup program; the reveal must point at the
			// program the user can run, so the package never displaces a recorded installer.
			const downloads = await Promise.allSettled(
				assets.map(async (asset) => {
					const filePath = await this.download(dir, asset.name, asset.url);
					if (filePath && (!targetPath || targetPath.endsWith('.nupkg'))) {
						targetPath = filePath;
					}
				})
			);
			for (const download of downloads) {
				if (download.status === 'rejected') throw download.reason;
			}
			await this.installUpdates(dir, targetPath);
		} catch (error) {
			logger.error('Error applying the updates', error, error.stack);
			// A finished download that failed to install is still useful: reveal it so
			// the user can run it by hand. A partial download is never recorded here, and
			// there is nothing worth keeping in its directory. The Windows .nupkg is not
			// runnable on its own, so if only it survived there is nothing to offer either.
			if (targetPath && !targetPath.endsWith('.nupkg')) {
				shell.showItemInFolder(targetPath);
			} else {
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch (cleanupError) {
					logger.warn('Could not remove failed update downloads', cleanupError);
				}
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
				this.downloadAndInstallUpdates(assets).catch((error) => {
					logger.error('Error downloading and installing updates', error);
				});
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

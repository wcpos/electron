import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

// Regression: the hourly timer kept firing while the "Found Updates" dialog sat unanswered,
// so an app left open overnight stacked one dialog per hour behind the first. A check that
// starts while another is still waiting on the user must join it, not open a second dialog.

const backing = new Map<string, unknown>();
class FakeStore {
	get(key: string, fallback?: unknown) {
		return backing.has(key) ? backing.get(key) : fallback;
	}
	set(key: string, value: unknown) {
		backing.set(key, value);
	}
}

type Deferred = { resolve: (value: { response: number }) => void };
const openDialogs: Deferred[] = [];
const noUpdateDialogs: unknown[] = [];
const loggedErrors: string[] = [];
const loggedWarnings: string[] = [];
let failRestartDialog = false;
let failFeedUrl = false;
const writers: import('node:fs').WriteStream[] = [];
let failCleanup = false;
let failMkdtemp = false;
// One entry per hand-off to the installer: setFeedURL on macOS/Windows, a folder reveal on
// Linux. The error path also reveals, but it logs "Error applying the updates" first.
const installStarted: string[] = [];

// The release manifest names one asset. By default its download never completes, so a "Yes"
// answer leaves a download stalled in the background; the streaming asset instead hands the
// test a fetch it resolves by hand with a body it closes by hand.
const STALLED_ASSET_URL = 'https://updates.test/app.zip';
const STREAMING_ASSET_URL = 'https://updates.test/app-streaming.zip';
const FAILING_ASSET_URL = 'https://updates.test/app-failing.zip';
let assetUrl = STALLED_ASSET_URL;
let assetNames = ['app.zip'];
const pendingDownloads: ((response: unknown) => void)[] = [];
const foundUpdatePayload = async (url: string): Promise<unknown> => {
	if (url === STALLED_ASSET_URL) {
		return new Promise<never>(() => {});
	}
	if (url === FAILING_ASSET_URL) {
		throw new Error('download failed');
	}
	if (url === STREAMING_ASSET_URL) {
		return new Promise<unknown>((resolve) => {
			pendingDownloads.push(resolve);
		});
	}
	return {
		ok: true,
		json: async () => ({
			version: '9.9.9',
			name: 'Next',
			releaseDate: '2026-09-15',
			notes: '',
			assets: assetNames.map((name) => ({
				name,
				url: assetUrl,
				contentType: 'application/zip',
				size: 1,
			})),
		}),
	};
};

// A real temp dir: the streaming case writes the installer to disk through the real pipeline.
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'wcpos-update-test-'));

const electronStub = {
	app: {
		getVersion: () => '1.0.0',
		getPath: () => tempRoot,
	},
	autoUpdater: {
		listeners: [] as string[],
		handlers: new Map<string, () => void>(),
		on(event: string, handler: () => void) {
			electronStub.autoUpdater.listeners.push(event);
			electronStub.autoUpdater.handlers.set(event, handler);
		},
		removeListener(event: string) {
			const at = electronStub.autoUpdater.listeners.indexOf(event);
			if (at >= 0) electronStub.autoUpdater.listeners.splice(at, 1);
			electronStub.autoUpdater.handlers.delete(event);
		},
		setFeedURL() {
			if (failFeedUrl) throw new Error('no feed');
			installStarted.push('feed');
		},
		checkForUpdates() {},
		quitAndInstall() {
			installStarted.push('quit');
		},
	},
	BrowserWindow: class FakeBrowserWindow {},
	dialog: {
		showMessageBox(...args: unknown[]) {
			const options = (args.length === 2 ? args[1] : args[0]) as { type?: string };
			if (options.type !== 'question') {
				noUpdateDialogs.push(options);
				return failRestartDialog
					? Promise.reject(new Error('no display'))
					: Promise.resolve({ response: 0 });
			}
			return new Promise<{ response: number }>((resolve) => {
				openDialogs.push({ resolve });
			});
		},
	},
	net: { fetch: foundUpdatePayload },
	shell: {
		showItemInFolder() {
			installStarted.push('reveal');
		},
	},
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'fs') {
		const fs = originalLoad.call(this, request, parent, isMain) as typeof import('node:fs');
		return {
			...fs,
			createWriteStream(...args: Parameters<typeof fs.createWriteStream>) {
				const writer = fs.createWriteStream(...args);
				writers.push(writer);
				return writer;
			},
			mkdtempSync(...args: Parameters<typeof fs.mkdtempSync>) {
				if (failMkdtemp) throw new Error('ENOSPC');
				return fs.mkdtempSync(...args);
			},
			rmSync(...args: Parameters<typeof rmSync>) {
				assert.ok(
					writers.every((writer) => writer.closed),
					'cleanup waits for every writer'
				);
				if (failCleanup) throw new Error('EPERM');
				return rmSync(...args);
			},
		};
	}
	if (request === 'electron') return electronStub;
	if (request === 'electron-store') return FakeStore;
	if (request === './log') {
		return {
			logger: {
				error(...args: unknown[]) {
					loggedErrors.push(String(args[0]));
				},
				info() {},
				warn(message: string) {
					loggedWarnings.push(message);
				},
				debug() {},
			},
		};
	}
	if (request === './progress-bar') return { ProgressBar: class {} };
	if (request === './translations') return { t: (key: string) => key };
	if (request === './util') {
		return {
			createDir(dir: string) {
				mkdirSync(dir, { recursive: true });
			},
			isDevelopment: false,
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
// The streaming cases run a real file pipeline, so they need wall-clock time. The budget is
// generous because a loaded CI runner is far slower than a laptop, and it is only spent in
// full when the condition never arrives, which is a real failure.
const waitFor = async (ready: () => boolean, attempts = 2000) => {
	for (let i = 0; i < attempts && !ready(); i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
};
// A fetch response whose body stays open until the test closes the handed-out controller.
const streamingResponse = (
	onController: (controller: ReadableStreamDefaultController<Uint8Array>) => void
) => ({
	ok: true,
	status: 200,
	headers: { get: (): string | null => null },
	body: new ReadableStream<Uint8Array>({
		start(controller) {
			onController(controller);
			controller.enqueue(new Uint8Array([1]));
		},
	}),
});
// Per-update download directories on disk, and the installers inside them. The file takes
// the manifest's asset name, whichever URL it was fetched from.
const updateDirs = () => {
	const root = path.join(tempRoot, 'NTWRK');
	return readdirSync(root)
		.filter((entry) => entry.startsWith('update-'))
		.map((entry) => path.join(root, entry));
};
const downloadedInstallers = () =>
	updateDirs()
		.map((dir) => path.join(dir, 'app.zip'))
		.filter((file) => existsSync(file));

// The install hand-off this file exercises only exists on macOS and Windows: on Linux
// installUpdates reveals the file and returns before touching the singleton autoUpdater. CI
// runs on Linux and a laptop does not, so pin the platform rather than assert different
// things on each. Restored in the finally block below.
const realPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

(async () => {
	try {
		const { AutoUpdater } = await import('./update');
		const updater = new AutoUpdater({ isDestroyed: () => false } as never);

		// Three hourly ticks land while the first dialog is still open.
		const ticks = [updater.checkForUpdates(), updater.checkForUpdates(), updater.checkForUpdates()];
		await flush();
		assert.equal(
			openDialogs.length,
			1,
			'only one Found Updates dialog opens while one is unanswered'
		);

		// A manual check from the menu joins the open dialog too: no second box, and no
		// "up to date" box when it settles.
		const menuItem = { enabled: true };
		const manual = updater.manualCheckForUpdates(menuItem as never);
		await flush();
		assert.equal(openDialogs.length, 1, 'manual check joins the open dialog');
		assert.equal(menuItem.enabled, false, 'menu item is disabled while the check is pending');

		// User picks "Remind me later"; every waiter settles on that single answer.
		openDialogs[0].resolve({ response: 1 });
		const results = await Promise.all(ticks);
		await manual;
		assert.deepEqual(results, [true, true, true]);
		assert.equal(
			noUpdateDialogs.length,
			0,
			'no "up to date" box after joining a found-update dialog'
		);
		assert.equal(menuItem.enabled, true, 'menu item re-enabled once the check settles');
		assert.ok(backing.get('remindLaterTimestamp'), 'Remind me later is recorded');

		// The next tick honours Remind me later without opening anything.
		assert.equal(await updater.checkForUpdates(), false);
		assert.equal(openDialogs.length, 1);

		// Once the snooze lapses a new check may prompt again: the guard was released.
		backing.delete('remindLaterTimestamp');
		const later = updater.checkForUpdates();
		await flush();
		assert.equal(openDialogs.length, 2, 'a fresh check after the dialog closed prompts again');
		openDialogs[1].resolve({ response: 2 });
		assert.equal(await later, true);

		// A failed check releases the guard as well.
		electronStub.net.fetch = async () => {
			throw new Error('offline');
		};
		assert.equal(await updater.checkForUpdates(), undefined);
		electronStub.net.fetch = foundUpdatePayload;
		const afterFailure = updater.checkForUpdates();
		await flush();
		assert.equal(openDialogs.length, 3, 'a check after a failed one can prompt again');
		openDialogs[2].resolve({ response: 2 });
		await afterFailure;

		// "Yes" hands off to the download, which must not hold the guard: a stalled download
		// would otherwise silence every later check for the rest of the session.
		const yes = updater.checkForUpdates();
		await flush();
		openDialogs[3].resolve({ response: 0 });
		assert.equal(
			await yes,
			true,
			'the check settles once the user answers, not when the download ends'
		);
		const duringDownload = updater.checkForUpdates();
		await flush();
		assert.equal(openDialogs.length, 5, 'a check during a stalled download can prompt again');
		openDialogs[4].resolve({ response: 2 });
		await duringDownload;

		// A check that starts while the installer is still streaming must not disturb that
		// download. The path used to live on the instance and every check reset it, so the
		// install then failed with "No update file downloaded".
		assetUrl = STREAMING_ASSET_URL;
		const accept = updater.checkForUpdates();
		await flush();
		openDialogs[5].resolve({ response: 0 });
		await accept;
		await flush();
		assert.equal(pendingDownloads.length, 1, 'the installer download started');
		let body: ReadableStreamDefaultController<Uint8Array> | undefined;
		pendingDownloads[0](
			streamingResponse((controller) => {
				body = controller;
			})
		);
		await flush();
		const midStream = updater.checkForUpdates();
		await flush();
		openDialogs[6].resolve({ response: 2 });
		await midStream;
		body?.close();
		await waitFor(
			() => installStarted.length > 0 || loggedErrors.some((m) => m.includes('applying'))
		);
		assert.deepEqual(
			loggedErrors.filter((m) => m.includes('applying')),
			[],
			'the install was not disturbed by the concurrent check'
		);
		assert.equal(installStarted.length, 1, 'the downloaded installer reached the installer');
		assert.equal(downloadedInstallers().length, 1);

		// Squirrel answering that there is nothing to install releases the guard, so a later
		// update can hand off. Without this a session would wedge after one hand-off.
		electronStub.autoUpdater.handlers.get('update-not-available')?.();
		await flush();
		assert.deepEqual(
			electronStub.autoUpdater.listeners,
			[],
			'a settled install leaves no listeners on the singleton updater'
		);

		// Two accepted updates in one session download into separate directories, so the
		// second cannot truncate the first's installer while it is still streaming.
		// Count feed hand-offs specifically: installStarted also records reveals and the
		// quitAndInstall that follows a completed install.
		const feeds = () => installStarted.filter((entry) => entry === 'feed').length;
		const feedsBefore = feeds();
		const first = updater.checkForUpdates();
		await flush();
		openDialogs[7].resolve({ response: 0 });
		await first;
		await flush();
		const second = updater.checkForUpdates();
		await flush();
		openDialogs[8].resolve({ response: 0 });
		await second;
		await flush();
		assert.equal(pendingDownloads.length, 3, 'both accepted updates started downloading');
		const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
		for (const resolve of pendingDownloads.slice(1)) {
			resolve(streamingResponse((controller) => bodies.push(controller)));
		}
		await flush();
		for (const controller of bodies) {
			controller.close();
		}
		await waitFor(() => feeds() > feedsBefore || loggedErrors.some((m) => m.includes('applying')));
		await flush();
		assert.deepEqual(
			loggedErrors.filter((m) => m.includes('applying')),
			[]
		);
		// electron's autoUpdater is a singleton with one feed URL, so only the first of the two
		// hands off; a second would overwrite that feed and double the restart dialog.
		assert.equal(
			feeds() - feedsBefore,
			1,
			'two concurrent installs hand off to the singleton updater once'
		);
		assert.deepEqual(
			electronStub.autoUpdater.listeners,
			['error', 'update-downloaded', 'update-not-available'],
			'and register one set of listeners, not one per hand-off'
		);

		assert.equal(
			downloadedInstallers().length,
			3,
			'each accepted update kept its own installer on disk'
		);

		// Squirrel reports the download and the restart dialog opens. That dialog can sit open
		// for a long time, and the app is committed to restarting, so the guard must stay set:
		// a later accepted update handing off here would raise a second restart dialog.
		const feedsAtRestart = feeds();
		electronStub.autoUpdater.handlers.get('update-downloaded')?.();
		await flush();
		assert.deepEqual(
			electronStub.autoUpdater.listeners,
			[],
			'the hand-off drops its listeners once the download is reported'
		);
		const downloadsAtRestart = pendingDownloads.length;
		const writersAtRestart = writers.length;
		const afterRestartPrompt = updater.checkForUpdates();
		await flush();
		openDialogs[openDialogs.length - 1].resolve({ response: 0 });
		await afterRestartPrompt;
		// waitFor returns silently when it times out, so each wait is followed by an assertion
		// that the thing actually happened. Without these the final check could pass because
		// the later download never started, rather than because the guard held.
		await waitFor(() => pendingDownloads.length > downloadsAtRestart);
		assert.ok(
			pendingDownloads.length > downloadsAtRestart,
			'the later accepted update started downloading'
		);
		const tail: ReadableStreamDefaultController<Uint8Array>[] = [];
		for (const resolve of pendingDownloads.slice(downloadsAtRestart)) {
			resolve(streamingResponse((controller) => tail.push(controller)));
		}
		await waitFor(() => tail.length > 0);
		assert.ok(tail.length > 0, 'and its body was handed to the download');
		for (const controller of tail) {
			controller.close();
		}
		const writtenHere = () => writers.slice(writersAtRestart);
		await waitFor(() => writtenHere().length > 0 && writtenHere().every((w) => w.closed));
		assert.ok(writtenHere().length > 0, 'the later download opened a writer');
		assert.ok(
			writtenHere().every((writer) => writer.closed),
			'and finished writing, so it reached the install hand-off path'
		);
		// Long enough for a hand-off to show up if the guard were released.
		await waitFor(() => feeds() > feedsAtRestart, 100);
		assert.equal(feeds(), feedsAtRestart, 'no second hand-off while the restart dialog is open');

		// A download that fails leaves nothing worth keeping, so its directory goes with it.
		const dirsBeforeFailure = updateDirs().length;
		assetUrl = FAILING_ASSET_URL;
		const failing = updater.checkForUpdates();
		await flush();
		openDialogs[10].resolve({ response: 0 });
		await failing;
		await waitFor(() => loggedErrors.some((m) => m.includes('applying')));
		assert.equal(updateDirs().length, dirsBeforeFailure, 'a failed download removed its directory');

		// A second process can boot while this one is downloading, so the sweep must spare a
		// directory owned by a running process. These belong to this very process.
		assert.ok(updateDirs().length > 0, 'precondition: earlier updates left directories');
		const liveDirs = updateDirs().length;
		new AutoUpdater({ isDestroyed: () => false } as never);
		assert.equal(updateDirs().length, liveDirs, 'a live download survives another boot sweep');

		// A directory whose owning process has exited is a leftover. spawnSync returns the pid
		// of a process that has already finished, so this pid is reliably dead.
		const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
		const orphan = path.join(tempRoot, 'NTWRK', `update-${deadPid}-orphan`);
		mkdirSync(orphan, { recursive: true });
		// Named by the pre-pid scheme, so it cannot be attributed to any owner.
		const unowned = path.join(tempRoot, 'NTWRK', 'update-legacy');
		mkdirSync(unowned, { recursive: true });

		new AutoUpdater({ isDestroyed: () => false } as never);
		// A pid we cannot signal is not a dead pid. process.kill throws EPERM when the process
		// exists but belongs to another user, and treating that as dead would delete a live
		// download.
		const guarded = path.join(tempRoot, 'NTWRK', `update-${deadPid + 1}-guarded`);
		mkdirSync(guarded, { recursive: true });
		const realKill = process.kill.bind(process);
		process.kill = ((pid: number, signal?: string | number) => {
			if (pid === deadPid + 1) {
				const denied: NodeJS.ErrnoException = new Error('EPERM');
				denied.code = 'EPERM';
				throw denied;
			}
			return realKill(pid, signal as never);
		}) as typeof process.kill;

		new AutoUpdater({ isDestroyed: () => false } as never);
		process.kill = realKill;
		assert.equal(existsSync(guarded), true, 'a pid we cannot signal counts as a live owner');
		rmSync(guarded, { recursive: true, force: true });

		assert.equal(existsSync(orphan), false, 'a dead owner’s directory is swept');
		assert.equal(existsSync(unowned), false, 'an unattributable directory is swept');
		assert.equal(updateDirs().length, liveDirs, 'and the live ones are still spared');

		// A failed asset must wait for its open RELEASES sibling; cleanup errors are swallowed.
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on('unhandledRejection', onUnhandled);
		assetNames = ['app.zip', 'RELEASES'];
		assetUrl = STREAMING_ASSET_URL;
		for (const cleanupFailure of [false, true]) {
			failCleanup = cleanupFailure;
			const errorsBefore = loggedErrors.length;
			const downloadsBefore = pendingDownloads.length;
			const writersBefore = writers.length;
			const check = updater.checkForUpdates();
			await flush();
			openDialogs[11 + Number(cleanupFailure)].resolve({ response: 0 });
			assert.equal(await check, true, 'check settles before downloads finish');
			const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
			for (const resolve of pendingDownloads.slice(downloadsBefore)) {
				resolve(streamingResponse((controller) => controllers.push(controller)));
			}
			await waitFor(
				() =>
					writers.length === writersBefore + 2 &&
					writers.slice(writersBefore).every((w) => !w.pending)
			);
			controllers[0].error(new Error('download failed'));
			await waitFor(() => writers[writersBefore].closed);
			assert.ok(writers[writersBefore].closed, 'failed download has settled');
			assert.equal(loggedErrors.length, errorsBefore, 'no cleanup while sibling streams');
			assert.equal(writers[writersBefore + 1].closed, false);
			const dir = path.dirname(String(writers[writersBefore + 1].path));
			assert.ok(existsSync(dir), 'open sibling directory remains');
			controllers[1].close();
			await waitFor(() => loggedErrors.length > errorsBefore);
			await flush();
			assert.equal(loggedErrors[errorsBefore], 'Error applying the updates');
			assert.equal(existsSync(dir), cleanupFailure);
			assert.equal(loggedWarnings.length, Number(cleanupFailure));
			assert.deepEqual(unhandled, []);
		}
		// The loop leaves the stub throwing; later cases expect cleanup to work.
		failCleanup = false;
		// Windows ships a runnable setup program beside a .nupkg. If only the package survives
		// there is nothing the user can run, so it is removed rather than revealed.
		assetNames = ['wcpos-setup.exe', 'wcpos.nupkg'];
		const revealsBefore = installStarted.length;
		const downloadsBeforeNupkg = pendingDownloads.length;
		const errorsBeforeNupkg = loggedErrors.length;
		const writersBeforeNupkg = writers.length;
		const nupkgCheck = updater.checkForUpdates();
		await flush();
		openDialogs[13].resolve({ response: 0 });
		await nupkgCheck;
		const nupkgControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
		for (const resolve of pendingDownloads.slice(downloadsBeforeNupkg)) {
			resolve(streamingResponse((controller) => nupkgControllers.push(controller)));
		}
		// The controllers are captured synchronously, so wait for the writers themselves
		// before reading the directory off one.
		await waitFor(() => writers.length === writersBeforeNupkg + 2);
		const nupkgDir = path.dirname(String(writers[writersBeforeNupkg].path));
		nupkgControllers[0].error(new Error('setup download failed'));
		await waitFor(() => writers[writersBeforeNupkg].closed);
		nupkgControllers[1].close();
		await waitFor(() => loggedErrors.length > errorsBeforeNupkg);
		await flush();
		assert.equal(installStarted.length, revealsBefore, 'a lone .nupkg is never revealed');
		assert.equal(existsSync(nupkgDir), false, 'its directory is removed instead');
		assetNames = ['app.zip'];

		// The download directory is created before the try block, so a failure there rejects
		// downloadAndInstallUpdates itself. The check hands that promise off without awaiting
		// it, so the rejection has to be observed at the call site or it goes unhandled.
		failMkdtemp = true;
		const errorsBeforeMkdtemp = loggedErrors.length;
		const mkdtempCheck = updater.checkForUpdates();
		await flush();
		openDialogs[14].resolve({ response: 0 });
		assert.equal(await mkdtempCheck, true, 'the check still settles when the directory fails');
		await waitFor(() => loggedErrors.length > errorsBeforeMkdtemp);
		await flush();
		assert.equal(loggedErrors[errorsBeforeMkdtemp], 'Error downloading and installing updates');
		assert.deepEqual(unhandled, [], 'the rejected download promise was observed');
		failMkdtemp = false;

		process.off('unhandledRejection', onUnhandled);
		// If the restart prompt cannot be shown, the restart never happens, so the commitment
		// that justified holding the guard is gone. Without releasing it the session could
		// never install another update. A fresh updater starts with an unheld guard.
		assetUrl = STREAMING_ASSET_URL;
		const restartFailUpdater = new AutoUpdater({ isDestroyed: () => false } as never);
		failRestartDialog = true;
		const beforeRestartFail = feeds();
		const accepted = restartFailUpdater.checkForUpdates();
		await flush();
		openDialogs[openDialogs.length - 1].resolve({ response: 0 });
		await accepted;
		const queuedAt = pendingDownloads.length - 1;
		let restartBody: ReadableStreamDefaultController<Uint8Array> | undefined;
		pendingDownloads[queuedAt](
			streamingResponse((controller) => {
				restartBody = controller;
			})
		);
		await flush();
		restartBody?.close();
		await waitFor(() => feeds() > beforeRestartFail);
		assert.equal(feeds(), beforeRestartFail + 1, 'the accepted update handed off');

		electronStub.autoUpdater.handlers.get('update-downloaded')?.();
		await waitFor(() => loggedErrors.some((m) => m.includes('prompt to restart')));
		assert.ok(
			loggedErrors.some((m) => m.includes('prompt to restart')),
			'the failed restart prompt is reported'
		);

		// The guard is released, so the next accepted update can still hand off.
		failRestartDialog = false;
		const afterFailure2 = restartFailUpdater.checkForUpdates();
		await flush();
		openDialogs[openDialogs.length - 1].resolve({ response: 0 });
		await afterFailure2;
		const nextQueued = pendingDownloads.length - 1;
		let nextBody: ReadableStreamDefaultController<Uint8Array> | undefined;
		pendingDownloads[nextQueued](
			streamingResponse((controller) => {
				nextBody = controller;
			})
		);
		await flush();
		nextBody?.close();
		await waitFor(() => feeds() > beforeRestartFail + 1);
		assert.equal(
			feeds(),
			beforeRestartFail + 2,
			'a failed restart prompt does not wedge the session'
		);

		// The same applies when the updater itself throws as the hand-off starts: the promise
		// rejects, the caller logs it, and without releasing first the guard and the listeners
		// would be left behind so no later update could hand off.
		const feedFailUpdater = new AutoUpdater({ isDestroyed: () => false } as never);
		failFeedUrl = true;
		const beforeFeedFail = feeds();
		// An earlier hand-off in this file is still pending, so its listeners are registered.
		// What matters is that the throwing hand-off adds and removes its own.
		const listenersBefore = electronStub.autoUpdater.listeners.length;
		const applying = () => loggedErrors.filter((m) => m.includes('applying')).length;
		const applyingBefore = applying();
		const feedAccepted = feedFailUpdater.checkForUpdates();
		await flush();
		openDialogs[openDialogs.length - 1].resolve({ response: 0 });
		await feedAccepted;
		const feedQueued = pendingDownloads.length - 1;
		let feedBody: ReadableStreamDefaultController<Uint8Array> | undefined;
		pendingDownloads[feedQueued](
			streamingResponse((controller) => {
				feedBody = controller;
			})
		);
		await flush();
		feedBody?.close();
		// Earlier cases already logged "applying" errors, so wait for a NEW one. Waiting on the
		// bare predicate would return instantly and assert nothing.
		await waitFor(() => applying() > applyingBefore);
		assert.equal(applying(), applyingBefore + 1, 'the failed hand-off is reported');
		assert.equal(
			electronStub.autoUpdater.listeners.length,
			listenersBefore,
			'a throwing hand-off leaves no listeners behind'
		);

		failFeedUrl = false;
		const afterFeedFail = feedFailUpdater.checkForUpdates();
		await flush();
		openDialogs[openDialogs.length - 1].resolve({ response: 0 });
		await afterFeedFail;
		const nextFeedQueued = pendingDownloads.length - 1;
		let nextFeedBody: ReadableStreamDefaultController<Uint8Array> | undefined;
		pendingDownloads[nextFeedQueued](
			streamingResponse((controller) => {
				nextFeedBody = controller;
			})
		);
		await flush();
		nextFeedBody?.close();
		await waitFor(() => feeds() > beforeFeedFail);
		assert.equal(feeds(), beforeFeedFail + 1, 'a throwing hand-off does not wedge the session');

		console.log('update.test.ts passed');
	} catch (error) {
		console.error(error);
		process.exit(1);
	} finally {
		mutableModule._load = originalLoad;
		Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
		rmSync(tempRoot, { recursive: true, force: true });
	}
})();

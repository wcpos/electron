import * as Sentry from '@sentry/electron/main';
import { app, BrowserWindow, dialog } from 'electron';
import logger from 'electron-log/main';

import { getInstallId } from './install-id';
import { scrubBreadcrumbUrl, shouldDropEvent } from './sentry-filters';

const isDevelopment = process.env.NODE_ENV === 'development';

let quitting = false;
app.on('before-quit', () => {
	quitting = true;
});

const countWindows = () => {
	try {
		return BrowserWindow.getAllWindows().length;
	} catch {
		// Unknown → assume a window is alive so nothing is dropped by mistake.
		return 1;
	}
};

/**
 * Sentry is off until the merchant opts in (src/main/telemetry-consent.ts).
 *
 * The SDK is initialised ONCE, at module load, before app `ready`: its protocol
 * and IPC handlers must be registered before `ready` and cannot be registered
 * twice. It is initialised ENABLED, because `Client.init()` only installs the
 * integrations (uncaught-exception capture, breadcrumbs, sessions, minidumps)
 * for an enabled client and never revisits them when `enabled` is flipped
 * later. Consent is enforced one layer down instead: every envelope goes
 * through `consentGatedTransport`, which drops it while `reportingEnabled` is
 * false, so nothing leaves the process until the merchant has said yes.
 */
let reportingEnabled = false;

const consentGatedTransport: ReturnType<typeof Sentry.makeElectronOfflineTransport> = (
	options
) => {
	const inner = Sentry.makeElectronOfflineTransport()(options);
	return {
		send: (envelope) => (reportingEnabled ? inner.send(envelope) : Promise.resolve({})),
		flush: (timeout) => inner.flush(timeout),
	};
};

if (!isDevelopment) {
	Sentry.init({
		transport: consentGatedTransport,
		dsn: 'https://39233e9d1e5046cbb67dae52f807de5f@o159038.ingest.sentry.io/1220733',
		// Pinned rather than left to the SDK's `${app.name}@${version}` default so it
		// is identical by construction to the release the main-process source maps
		// are uploaded under (webpack.main.config.ts).
		release: `WCPOS@${app.getVersion()}`,
		sendDefaultPii: false,
		beforeSend(event) {
			return shouldDropEvent(event, { quitting, windowsAlive: countWindows() }) ? null : event;
		},
		// electron.net breadcrumbs carry the full request URL, i.e. the merchant's
		// store hostname. Keep the path, drop the origin.
		beforeBreadcrumb: scrubBreadcrumbUrl,
	});
}

function setSentryEnabled(enabled: boolean): void {
	if (isDevelopment) {
		return;
	}
	reportingEnabled = enabled;
	// A random per-install UUID (see install-id.ts) so Sentry's "users affected"
	// count means installs, not zero. Cleared when reporting is turned off.
	Sentry.setUser(enabled ? { id: getInstallId() } : null);
}

export const enableSentry = () => setSentryEnabled(true);
export const disableSentry = () => setSentryEnabled(false);
/** Whether envelopes currently leave the process (consent granted, production build). */
export const isSentryReporting = () => reportingEnabled;

// Production keeps info so the printer handlers' one-line-per-job diagnostics (Spec F,
// wcpos/monorepo#1597) reach a merchant's main.log; the chatty http-bridge lines are debug.
logger.transports.file.level = isDevelopment ? 'debug' : 'info';
logger.transports.console.level = isDevelopment ? 'debug' : 'error';
logger.initialize({ preload: true });

// Prevent EPIPE errors on stdout/stderr from becoming uncaught exceptions.
// These occur when the parent process (electron-forge / concurrently) closes its pipe.
for (const std of [process.stdout, process.stderr]) {
	std.on('error', (err: NodeJS.ErrnoException) => {
		if (err.code !== 'EPIPE') throw err;
	});
}

logger.errorHandler.startCatching({
	showDialog: false,
	onError({ createIssue, error, versions }) {
		// EPIPE is a broken-pipe signal — not actionable by the user
		if ((error as NodeJS.ErrnoException).code === 'EPIPE') return;

		dialog
			.showMessageBox({
				title: 'An error occurred',
				message: error.message,
				// detail: error.stack, // there is too much info here
				type: 'error',
				buttons: ['Quit', 'Report', 'Ignore'],
			})
			.then((result) => {
				if (result.response === 1) {
					createIssue('https://github.com/wcpos/electron/issues/new', {
						title: `Error report for ${versions.app}`,
						body: 'Error:\n```' + error.stack + '\n```\n' + `OS: ${versions.os}`,
					});
					return;
				}

				if (result.response === 0) {
					app.quit();
				}
			});
	},
});

process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
	if (error.code === 'EPIPE') return;
	logger.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
	if (reason instanceof Error && (reason as NodeJS.ErrnoException).code === 'EPIPE') return;
	logger.error('Unhandled rejection:', reason);
});

export { Sentry, logger };

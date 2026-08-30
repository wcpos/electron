import * as Sentry from '@sentry/electron/main';
import { app, BrowserWindow, dialog } from 'electron';
import logger from 'electron-log';

import { getInstallId } from './install-id';
import { shouldDropEvent } from './sentry-filters';

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

Sentry.init({
	dsn: 'https://39233e9d1e5046cbb67dae52f807de5f@o159038.ingest.sentry.io/1220733',
	// Pinned rather than left to the SDK's `${app.name}@${version}` default so it
	// is identical by construction to the release the main-process source maps
	// are uploaded under (webpack.main.config.ts).
	release: `WCPOS@${app.getVersion()}`,
	enabled: !isDevelopment,
	sendDefaultPii: false,
	beforeSend(event) {
		return shouldDropEvent(event, { quitting, windowsAlive: countWindows() }) ? null : event;
	},
});
// A random per-install UUID (see install-id.ts) so Sentry's "users affected"
// count means installs, not zero.
Sentry.setUser({ id: getInstallId() });

logger.transports.file.level = isDevelopment ? 'debug' : 'error';
logger.transports.console.level = isDevelopment ? 'debug' : 'error';

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

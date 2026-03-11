import * as Sentry from '@sentry/electron/main';
import { app, dialog } from 'electron';
import logger from 'electron-log';

const isDevelopment = process.env.NODE_ENV === 'development';

Sentry.init({ dsn: 'https://39233e9d1e5046cbb67dae52f807de5f@o159038.ingest.sentry.io/1220733' });

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

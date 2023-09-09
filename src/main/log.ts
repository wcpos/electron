import * as Sentry from '@sentry/electron/main';
import { dialog, app } from 'electron';
import logger from 'electron-log';

const isDevelopment = process.env.NODE_ENV === 'development';

Sentry.init({ dsn: 'https://39233e9d1e5046cbb67dae52f807de5f@o159038.ingest.sentry.io/1220733' });

logger.transports.file.level = isDevelopment ? 'debug' : 'error';
logger.transports.console.level = isDevelopment ? 'debug' : 'error';

logger.errorHandler.startCatching({
	showDialog: false,
	onError({ createIssue, error, versions }) {
		dialog
			.showMessageBox({
				title: 'An error occurred',
				message: error.message,
				detail: error.stack,
				type: 'error',
				buttons: ['Ignore', 'Report', 'Exit'],
			})
			.then((result) => {
				if (result.response === 1) {
					createIssue('https://github.com/wcpos/electron/issues/new', {
						title: `Error report for ${versions.app}`,
						body: 'Error:\n```' + error.stack + '\n```\n' + `OS: ${versions.os}`,
					});
					return;
				}

				if (result.response === 2) {
					app.quit();
				}
			});
	},
});

process.on('uncaughtException', (error) => {
	logger.error('Uncaught exception:', error);
});

export default logger;

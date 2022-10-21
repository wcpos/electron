import { dialog, app } from 'electron';
import logger from 'electron-log';
import * as Sentry from '@sentry/electron';

Sentry.init({ dsn: 'https://39233e9d1e5046cbb67dae52f807de5f@o159038.ingest.sentry.io/1220733' });

logger.catchErrors({
	showDialog: false,
	onError(error, versions /* , submitIssue*/) {
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
					// @TODO: automaticcaly post issue to sentry

					// submitIssue("https://github.com/arvindr21/priority/issues/new", {
					//     title: `Error report for ${versions.app}`,
					//     body: "Error:\n```" + error.stack + "\n```\n" + `OS: ${versions.os}`,
					// });

					// opts.title = `Error report for ${versions.app}`;
					// opts.body = `Error:\n\`\`\`${error.stack}\n\`\`\`\n` + `OS: ${versions.os}`;

					// createGHIssue('arvindr21/priority', opts.title, opts, (err, issue, info) => {
					// 	if (info) {
					// 		LOG.info('Limit: %d', info.limit);
					// 		LOG.info('Remaining: %d', info.remaining);
					// 		LOG.info('Reset: %s', new Date(info.reset * 1000).toISOString());
					// 	}
					// 	if (err) {
					// 		LOG.error(err.message);
					// 		throw new Error(err.message);
					// 	}
					// 	LOG.info(JSON.stringify(issue));
					// 	dialog.showMessageBox({
					// 		title: 'Error Issue Created',
					// 		message: JSON.stringify(issue),
					// 		type: 'info',
					// 		buttons: ['Thanks!'],
					// 	});
					// });

					return;
				}

				if (result.response === 2) {
					app.quit();
				}
			});
	},
});

export default logger;

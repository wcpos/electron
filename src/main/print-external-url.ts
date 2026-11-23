import { BrowserWindow, ipcMain, IpcMainEvent } from 'electron';

import { logger } from './log';

// A hidden print window whose page never finishes loading reports an error and closes after this.
const PRINT_LOAD_TIMEOUT_MS = 30_000;
// printJobId is built into reply channel names, so it must be a short plain token.
const PRINT_JOB_ID = /^[\w-]{1,64}$/;

// The renderer sends system-printer receipts as data:text/html URLs.
function isPrintableURL(value: unknown): value is string {
	try {
		if (typeof value !== 'string') return false;
		const { protocol } = new URL(value);
		if (protocol === 'http:' || protocol === 'https:') return true;
		const lower = value.toLowerCase();
		return (
			protocol === 'data:' &&
			(lower.startsWith('data:text/html,') || lower.startsWith('data:text/html;'))
		);
	} catch {
		return false;
	}
}

function printExternalURL(externalURL: string, printJobId: string, event: IpcMainEvent) {
	const printWindow = new BrowserWindow({
		show: false,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			// Isolated, non-persistent session: external receipt pages must not
			// share the default session, where the wcpos-image:// handler is
			// registered — a hostile page there could use it as an SSRF
			// read-proxy through the main process. Receipt URLs are tokenized
			// (?key=wc_order_...), so no shared cookies are needed.
			partition: 'external-print',
		},
	});
	printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

	const closeWindow = () => {
		if (!printWindow.isDestroyed()) printWindow.close();
	};
	let done = false;
	// Every exit goes through here, so each print job reports exactly one outcome.
	const finish = (kind: 'after' | 'error', message?: string) => {
		if (done) return;
		done = true;
		clearTimeout(loadTimeout);
		if (kind === 'error') {
			event.sender.send(`onPrintError-${printJobId}`, message);
			closeWindow();
		} else {
			event.sender.send(`onAfterPrint-${printJobId}`);
			setTimeout(closeWindow, 1000); // Adjust the delay as needed
		}
	};
	const loadTimeout = setTimeout(() => {
		logger.error('Print page load timed out');
		finish('error', 'Print page load timed out');
	}, PRINT_LOAD_TIMEOUT_MS);

	// Load the external URL
	printWindow.loadURL(externalURL).catch(() => {}); // failures are reported via did-fail-load

	// Wait for the content to finish loading
	printWindow.webContents.once('did-finish-load', () => {
		// The page has loaded; the print dialog may stay open as long as the user needs.
		clearTimeout(loadTimeout);
		logger.info('Page loaded, sending onBeforePrint');
		// Notify the renderer process that onBeforePrint can be called
		event.sender.send(`onBeforePrint-${printJobId}`);

		/**
		 * There seems to be a bug which prevents the print dialog from showing if no printers are installed.
		 * https://github.com/electron/electron/issues/36897
		 */
		// printWindow.webContents.print(
		// 	{
		// 		silent: false, // Ensure the print dialog is shown
		// 		printBackground: true, // Include background graphics
		// 	},
		// 	(success, errorType) => {
		// 		if (!success) {
		// 			logger.error('Print failed:', errorType);
		// 			// Notify the renderer process about the error
		// 			event.sender.send(`onPrintError-${printJobId}`, errorType);
		// 		} else {
		// 			logger.info('Print successful');
		// 			// Notify the renderer process that printing is done
		// 			event.sender.send(`onAfterPrint-${printJobId}`);
		// 		}
		// 		// Close the window after printing
		// 		printWindow.close();
		// 		printWindow = null;
		// 	}
		// );

		printWindow.webContents
			.executeJavaScript('window.print();')
			.then(() => {
				logger.info('Print dialog opened');
				// Since we cannot detect when the user has completed printing,
				// we can call onAfterPrint immediately after opening the print dialog
				finish('after');
			})
			.catch((error) => {
				logger.error('Failed to execute window.print():', error);
				finish('error', error.message);
			});
	});

	// Handle any errors loading the URL
	printWindow.webContents.on(
		'did-fail-load',
		(_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
			if (!isMainFrame || errorCode === -3) return; // subframes and ERR_ABORTED are not failures
			logger.error('Failed to load URL:', errorDescription);
			// Notify the renderer process about the error
			finish('error', errorDescription);
		}
	);
}

ipcMain.on('print-external-url', (event, args) => {
	const { externalURL, printJobId } = args ?? {};
	logger.info('Received print request for URL:', externalURL);
	if (typeof printJobId !== 'string' || !PRINT_JOB_ID.test(printJobId)) {
		logger.warn('Rejected print request: invalid printJobId');
		return;
	}
	if (!isPrintableURL(externalURL)) {
		logger.warn('Rejected print request: invalid print URL');
		event.sender.send(`onPrintError-${printJobId}`, 'Invalid print URL');
		return;
	}
	printExternalURL(externalURL, printJobId, event);
});

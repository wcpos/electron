import { BrowserWindow, ipcMain, IpcMainEvent } from 'electron';

import logger from './log';

function printExternalURL(externalURL: string, printJobId: string, event: IpcMainEvent) {
	let printWindow = new BrowserWindow({
		show: false,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	// Load the external URL
	printWindow.loadURL(externalURL);

	// Wait for the content to finish loading
	printWindow.webContents.on('did-finish-load', () => {
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
				event.sender.send(`onAfterPrint-${printJobId}`);
				// Optionally, close the window after a delay
				setTimeout(() => {
					if (printWindow) {
						printWindow.close();
						printWindow = null;
					}
				}, 1000); // Adjust the delay as needed
			})
			.catch((error) => {
				logger.error('Failed to execute window.print():', error);
				event.sender.send(`onPrintError-${printJobId}`, error.message);
				// Close the window
				printWindow.close();
				printWindow = null;
			});
	});

	// Handle any errors loading the URL
	printWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
		logger.error('Failed to load URL:', errorDescription);
		// Notify the renderer process about the error
		event.sender.send(`onPrintError-${printJobId}`, errorDescription);
		// Close the window
		printWindow.close();
		printWindow = null;
	});
}

ipcMain.on('print-external-url', (event, args) => {
	const { externalURL, printJobId } = args;
	logger.info('Received print request for URL:', externalURL);
	printExternalURL(externalURL, printJobId, event);
});

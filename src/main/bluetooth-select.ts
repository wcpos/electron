import { type BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';

import { logger } from './log';

/**
 * Wire Bluetooth device selection for a window. Call once per BrowserWindow after creation.
 *
 * Chromium fires `select-bluetooth-device` repeatedly during one requestDevice() chooser
 * session as the candidate list grows. Only the LATEST callback may be invoked, exactly
 * once — so a single persistent reply listener holds a single pending callback, instead
 * of queueing one `ipcMain.once` per firing (stale FIFO listeners ate real selections).
 */
export function registerBluetoothSelection(window: BrowserWindow): void {
	let pendingCallback: ((deviceId: string) => void) | null = null;

	window.webContents.on('select-bluetooth-device', (event, devices, callback) => {
		event.preventDefault();
		logger.debug(`[bluetooth] select-bluetooth-device fired with ${devices.length} device(s)`);
		pendingCallback = callback;
		// Surface candidates to the renderer picker.
		window.webContents.send(
			'bluetooth-devices',
			devices.map((d) => ({ id: d.deviceId, name: d.deviceName }))
		);
	});

	// Renderer replies with the chosen deviceId ('' cancels the chooser).
	const onSelected = (event: IpcMainEvent, deviceId: string) => {
		if (event.sender !== window.webContents) return;
		if (!pendingCallback) {
			logger.info('[bluetooth] selection received with no pending chooser — ignored');
			return;
		}
		logger.info(`[bluetooth] device selected: ${deviceId || '(cancelled)'}`);
		const callback = pendingCallback;
		pendingCallback = null;
		callback(deviceId);
	};

	ipcMain.on('bluetooth-device-selected', onSelected);
	window.on('closed', () => {
		ipcMain.removeListener('bluetooth-device-selected', onSelected);
		pendingCallback = null;
	});
}

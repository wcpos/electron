import { type BrowserWindow, ipcMain } from 'electron';

import { logger } from './log';

/** Wire Bluetooth device selection for a window. Call once per BrowserWindow after creation. */
export function registerBluetoothSelection(window: BrowserWindow): void {
	window.webContents.on('select-bluetooth-device', (event, devices, callback) => {
		event.preventDefault();
		// Surface candidates to the renderer picker.
		window.webContents.send(
			'bluetooth-devices',
			devices.map((d) => ({ id: d.deviceId, name: d.deviceName }))
		);
		// Renderer replies with the chosen deviceId (or '' to cancel).
		ipcMain.once('bluetooth-device-selected', (_e, deviceId: string) => {
			logger.info(`Bluetooth device selected: ${deviceId || '(cancelled)'}`);
			callback(deviceId);
		});
	});
}

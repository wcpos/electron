import {
	type BrowserWindow,
	type Event,
	ipcMain,
	type IpcMainEvent,
	type WebContents,
} from 'electron';

import { logger } from './log';

/**
 * Wire Web Serial / WebHID device selection for a window so barcode scanners can
 * connect directly in the Electron shell (wcpos/monorepo#742). Call once per
 * BrowserWindow after creation, alongside `registerBluetoothSelection`.
 *
 * Chromium won't expose serial/HID devices to the renderer unless the main
 * process (a) grants access via `setDevicePermissionHandler` and (b) answers the
 * `select-serial-port` / `select-hid-device` chooser events — otherwise
 * `navigator.serial.requestPort()` / `navigator.hid.requestDevice()` reject and
 * the renderer sees no devices. Mirroring the Bluetooth flow, each chooser event
 * surfaces its candidates to the renderer picker and a single persistent reply
 * listener holds one pending callback (the chooser may fire repeatedly as the
 * candidate list grows; only the latest callback may be invoked, exactly once).
 *
 * Serial and HID chooser events are emitted on the Session (not webContents, as
 * Bluetooth is), so the listeners live on `webContents.session` and filter by the
 * requesting contents where the event exposes it.
 */

interface SerialPortLike {
	portId: string;
	portName?: string;
	displayName?: string;
}

interface HidDeviceLike {
	deviceId: string;
	name?: string;
	productName?: string;
}

interface HidSelectDetails {
	deviceList: HidDeviceLike[];
}

export function registerScannerDeviceSelection(window: BrowserWindow): void {
	const { session } = window.webContents;

	// Grant serial + HID device access (one handler per session; the logic is
	// identical per window, so re-registering across windows is harmless).
	session.setDevicePermissionHandler(
		(details) => details.deviceType === 'serial' || details.deviceType === 'hid'
	);
	session.setPermissionCheckHandler(
		(_webContents, permission) => permission === 'serial' || permission === 'hid'
	);

	// --- Serial ---------------------------------------------------------------
	let pendingSerial: ((portId: string) => void) | null = null;

	const onSelectSerialPort = (
		event: Event,
		portList: SerialPortLike[],
		webContents: WebContents,
		callback: (portId: string) => void
	) => {
		if (webContents !== window.webContents) return;
		event.preventDefault();
		logger.debug(`[device-select] select-serial-port fired with ${portList.length} port(s)`);
		pendingSerial = callback;
		window.webContents.send(
			'serial-ports',
			portList.map((port) => ({
				id: port.portId,
				name: port.portName || port.displayName || port.portId,
			}))
		);
	};
	session.on('select-serial-port', onSelectSerialPort);

	const onSerialSelected = (event: IpcMainEvent, portId: string) => {
		if (event.sender !== window.webContents) return;
		if (!pendingSerial) {
			logger.info('[device-select] serial selection received with no pending chooser — ignored');
			return;
		}
		logger.info(`[device-select] serial port selected: ${portId || '(cancelled)'}`);
		const callback = pendingSerial;
		pendingSerial = null;
		callback(portId);
	};
	ipcMain.on('serial-port-selected', onSerialSelected);

	// --- HID ------------------------------------------------------------------
	let pendingHid: ((deviceId: string) => void) | null = null;

	const onSelectHidDevice = (
		event: Event,
		details: HidSelectDetails,
		callback: (deviceId: string) => void
	) => {
		event.preventDefault();
		logger.debug(
			`[device-select] select-hid-device fired with ${details.deviceList.length} device(s)`
		);
		pendingHid = callback;
		window.webContents.send(
			'hid-devices',
			details.deviceList.map((device) => ({
				id: device.deviceId,
				name: device.name || device.productName || device.deviceId,
			}))
		);
	};
	session.on('select-hid-device', onSelectHidDevice);

	const onHidSelected = (event: IpcMainEvent, deviceId: string) => {
		if (event.sender !== window.webContents) return;
		if (!pendingHid) {
			logger.info('[device-select] hid selection received with no pending chooser — ignored');
			return;
		}
		logger.info(`[device-select] hid device selected: ${deviceId || '(cancelled)'}`);
		const callback = pendingHid;
		pendingHid = null;
		callback(deviceId);
	};
	ipcMain.on('hid-device-selected', onHidSelected);

	window.on('closed', () => {
		session.removeListener('select-serial-port', onSelectSerialPort);
		session.removeListener('select-hid-device', onSelectHidDevice);
		ipcMain.removeListener('serial-port-selected', onSerialSelected);
		ipcMain.removeListener('hid-device-selected', onHidSelected);
		pendingSerial = null;
		pendingHid = null;
	});
}

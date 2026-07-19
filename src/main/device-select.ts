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
 * the renderer sees no devices. Each chooser surfaces its candidates to the
 * renderer picker and a single persistent reply listener holds one pending
 * callback (invoked exactly once).
 *
 * These are Session events (not webContents, as Bluetooth is), and a Session is
 * shared across windows, so both choosers are filtered to THIS window — serial by
 * the `webContents` argument, HID by `details.frame`. While a chooser is open the
 * `*-added` / `*-removed` events refresh the candidate list live (they only fire
 * between the select event and its callback — Electron device docs).
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
	frame?: unknown;
}

interface HidDeviceDetails {
	device: HidDeviceLike;
	frame?: unknown;
}

export function registerScannerDeviceSelection(window: BrowserWindow): void {
	const { session } = window.webContents;
	const isThisWindow = (webContents: WebContents | undefined) => webContents === window.webContents;

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
	let serialPorts: SerialPortLike[] = [];
	const sendSerialPorts = () => {
		window.webContents.send(
			'serial-ports',
			serialPorts.map((port) => ({
				id: port.portId,
				name: port.portName || port.displayName || port.portId,
			}))
		);
	};

	const onSelectSerialPort = (
		event: Event,
		portList: SerialPortLike[],
		webContents: WebContents,
		callback: (portId: string) => void
	) => {
		if (!isThisWindow(webContents)) return;
		event.preventDefault();
		logger.debug(`[device-select] select-serial-port fired with ${portList.length} port(s)`);
		pendingSerial = callback;
		serialPorts = [...portList];
		sendSerialPorts();
	};
	const onSerialAdded = (_event: Event, port: SerialPortLike) => {
		if (!pendingSerial || serialPorts.some((p) => p.portId === port.portId)) return;
		serialPorts.push(port);
		sendSerialPorts();
	};
	const onSerialRemoved = (_event: Event, port: SerialPortLike) => {
		if (!pendingSerial) return;
		serialPorts = serialPorts.filter((p) => p.portId !== port.portId);
		sendSerialPorts();
	};
	session.on('select-serial-port', onSelectSerialPort);
	session.on('serial-port-added', onSerialAdded);
	session.on('serial-port-removed', onSerialRemoved);

	const onSerialSelected = (event: IpcMainEvent, portId: string) => {
		if (!isThisWindow(event.sender)) return;
		if (!pendingSerial) {
			logger.info('[device-select] serial selection received with no pending chooser — ignored');
			return;
		}
		logger.info(`[device-select] serial port selected: ${portId || '(cancelled)'}`);
		const callback = pendingSerial;
		pendingSerial = null;
		serialPorts = [];
		callback(portId); // serial: '' cancels the request
	};
	ipcMain.on('serial-port-selected', onSerialSelected);

	// --- HID ------------------------------------------------------------------
	let pendingHid: ((deviceId?: string) => void) | null = null;
	let hidDevices: HidDeviceLike[] = [];
	const sendHidDevices = () => {
		window.webContents.send(
			'hid-devices',
			hidDevices.map((device) => ({
				id: device.deviceId,
				name: device.name || device.productName || device.deviceId,
			}))
		);
	};
	const isThisFrame = (frame: unknown) =>
		!frame || frame === (window.webContents as unknown as { mainFrame?: unknown }).mainFrame;

	const onSelectHidDevice = (
		event: Event,
		details: HidSelectDetails,
		callback: (deviceId?: string) => void
	) => {
		if (!isThisFrame(details.frame)) return;
		event.preventDefault();
		logger.debug(
			`[device-select] select-hid-device fired with ${details.deviceList.length} device(s)`
		);
		pendingHid = callback;
		hidDevices = [...details.deviceList];
		sendHidDevices();
	};
	const onHidAdded = (_event: Event, details: HidDeviceDetails) => {
		if (!pendingHid || !details.device) return;
		if (hidDevices.some((d) => d.deviceId === details.device.deviceId)) return;
		hidDevices.push(details.device);
		sendHidDevices();
	};
	const onHidRemoved = (_event: Event, details: HidDeviceDetails) => {
		if (!pendingHid || !details.device) return;
		hidDevices = hidDevices.filter((d) => d.deviceId !== details.device.deviceId);
		sendHidDevices();
	};
	session.on('select-hid-device', onSelectHidDevice);
	session.on('hid-device-added', onHidAdded);
	session.on('hid-device-removed', onHidRemoved);

	const onHidSelected = (event: IpcMainEvent, deviceId: string) => {
		if (!isThisWindow(event.sender)) return;
		if (!pendingHid) {
			logger.info('[device-select] hid selection received with no pending chooser — ignored');
			return;
		}
		logger.info(`[device-select] hid device selected: ${deviceId || '(cancelled)'}`);
		const callback = pendingHid;
		pendingHid = null;
		hidDevices = [];
		// HID: call with no argument to cancel (an empty string is not a valid id).
		if (deviceId) {
			callback(deviceId);
		} else {
			callback();
		}
	};
	ipcMain.on('hid-device-selected', onHidSelected);

	window.on('closed', () => {
		session.removeListener('select-serial-port', onSelectSerialPort);
		session.removeListener('serial-port-added', onSerialAdded);
		session.removeListener('serial-port-removed', onSerialRemoved);
		session.removeListener('select-hid-device', onSelectHidDevice);
		session.removeListener('hid-device-added', onHidAdded);
		session.removeListener('hid-device-removed', onHidRemoved);
		ipcMain.removeListener('serial-port-selected', onSerialSelected);
		ipcMain.removeListener('hid-device-selected', onHidSelected);
		pendingSerial = null;
		pendingHid = null;
	});
}

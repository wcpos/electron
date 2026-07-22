import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const fakeIpcMain = new EventEmitter();

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return { ipcMain: fakeIpcMain };
	if (request === './log') {
		return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	const { registerScannerDeviceSelection } =
		require('./device-select') as typeof import('./device-select');

	class FakeSession extends EventEmitter {
		devicePermissionHandler: ((details: { deviceType: string }) => boolean) | null = null;
		permissionCheckHandler: ((wc: unknown, permission: string) => boolean) | null = null;
		setDevicePermissionHandler(handler: (details: { deviceType: string }) => boolean) {
			this.devicePermissionHandler = handler;
		}
		setPermissionCheckHandler(handler: (wc: unknown, permission: string) => boolean) {
			this.permissionCheckHandler = handler;
		}
	}
	class FakeWebContents extends EventEmitter {
		session = new FakeSession();
		mainFrame = { id: 'main-frame' };
		sent: { channel: string; payload: unknown }[] = [];
		send(channel: string, payload: unknown) {
			this.sent.push({ channel, payload });
		}
		lastPayload(channel: string) {
			const forChannel = this.sent.filter((s) => s.channel === channel);
			return forChannel[forChannel.length - 1]?.payload;
		}
	}
	const webContents = new FakeWebContents();
	const win = new EventEmitter() as EventEmitter & { webContents: FakeWebContents };
	win.webContents = webContents;
	const session = webContents.session;

	registerScannerDeviceSelection(win as never);

	// Permission handlers grant serial + hid only.
	assert.equal(session.devicePermissionHandler!({ deviceType: 'serial' }), true);
	assert.equal(session.devicePermissionHandler!({ deviceType: 'hid' }), true);
	assert.equal(session.devicePermissionHandler!({ deviceType: 'usb' }), false);
	assert.equal(session.permissionCheckHandler!(null, 'hid'), true);
	assert.equal(session.permissionCheckHandler!(null, 'geolocation'), false);

	const noopEvent = { preventDefault() {} };
	const serialCalls: string[] = [];
	const hidCalls: (string | undefined)[][] = [];

	// --- Serial: chooser surfaces candidates; hot-plug refreshes them live. ----
	session.emit(
		'select-serial-port',
		noopEvent,
		[{ portId: 's1', portName: 'Scanner COM3' }],
		webContents,
		(portId: string) => serialCalls.push(portId)
	);
	assert.equal(fakeIpcMain.listenerCount('serial-port-selected'), 1);
	// A port plugged in while the picker is open is appended and re-sent.
	session.emit('serial-port-added', noopEvent, { portId: 's2', portName: 'Scanner COM4' });
	assert.deepEqual(webContents.lastPayload('serial-ports'), [
		{ id: 's1', name: 'Scanner COM3' },
		{ id: 's2', name: 'Scanner COM4' },
	]);
	// Unplugging removes it.
	session.emit('serial-port-removed', noopEvent, { portId: 's1' });
	assert.deepEqual(webContents.lastPayload('serial-ports'), [{ id: 's2', name: 'Scanner COM4' }]);
	// Selection invokes the callback once; after that hot-plug is inert.
	fakeIpcMain.emit('serial-port-selected', { sender: webContents }, 's2');
	assert.deepEqual(serialCalls, ['s2']);
	const sentCount = webContents.sent.length;
	session.emit('serial-port-added', noopEvent, { portId: 's9' });
	assert.equal(webContents.sent.length, sentCount, 'no refresh once serial chooser resolved');

	// A serial chooser from another window's webContents is ignored.
	const before = webContents.sent.length;
	session.emit('select-serial-port', noopEvent, [{ portId: 'x' }], new FakeWebContents(), () =>
		serialCalls.push('other')
	);
	assert.equal(webContents.sent.length, before, 'foreign serial request not surfaced');

	// --- HID: frame filter, live refresh, and no-arg cancel. -------------------
	// A request from a different frame is ignored.
	session.emit(
		'select-hid-device',
		noopEvent,
		{ deviceList: [{ deviceId: 'zz' }], frame: { id: 'other-frame' } },
		(deviceId?: string) => hidCalls.push([deviceId])
	);
	assert.equal(webContents.sent.filter((s) => s.channel === 'hid-devices').length, 0);

	// This window's request surfaces candidates.
	session.emit(
		'select-hid-device',
		noopEvent,
		{ deviceList: [{ deviceId: 'h1', productName: 'Barcode HID' }], frame: webContents.mainFrame },
		(deviceId?: string) => hidCalls.push([deviceId])
	);
	assert.deepEqual(webContents.lastPayload('hid-devices'), [{ id: 'h1', name: 'Barcode HID' }]);
	// Hot-plug add refreshes.
	session.emit('hid-device-added', noopEvent, { device: { deviceId: 'h2', name: 'Second HID' } });
	assert.deepEqual(webContents.lastPayload('hid-devices'), [
		{ id: 'h1', name: 'Barcode HID' },
		{ id: 'h2', name: 'Second HID' },
	]);
	// Cancelling (empty id) calls the callback with NO argument, not ''.
	fakeIpcMain.emit('hid-device-selected', { sender: webContents }, '');
	assert.deepEqual(hidCalls, [[undefined]]);

	// A real selection passes the id through.
	session.emit(
		'select-hid-device',
		noopEvent,
		{ deviceList: [{ deviceId: 'h3' }], frame: webContents.mainFrame },
		(deviceId?: string) => hidCalls.push([deviceId])
	);
	fakeIpcMain.emit('hid-device-selected', { sender: webContents }, 'h3');
	assert.deepEqual(hidCalls[1], ['h3']);

	// --- Window close removes every listener.
	win.emit('closed');
	assert.equal(fakeIpcMain.listenerCount('serial-port-selected'), 0);
	assert.equal(fakeIpcMain.listenerCount('hid-device-selected'), 0);
	assert.equal(session.listenerCount('select-serial-port'), 0);
	assert.equal(session.listenerCount('serial-port-added'), 0);
	assert.equal(session.listenerCount('select-hid-device'), 0);
	assert.equal(session.listenerCount('hid-device-added'), 0);

	console.log('device-select tests passed');
} finally {
	mutableModule._load = originalLoad;
}

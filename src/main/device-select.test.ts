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

	// Fake session: an EventEmitter plus the permission setters the module calls.
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
		sent: { channel: string; payload: unknown }[] = [];
		send(channel: string, payload: unknown) {
			this.sent.push({ channel, payload });
		}
	}
	const webContents = new FakeWebContents();
	const win = new EventEmitter() as EventEmitter & { webContents: FakeWebContents };
	win.webContents = webContents;
	const session = webContents.session;

	registerScannerDeviceSelection(win as never);

	// Permission handlers grant serial + hid, deny everything else.
	assert.ok(session.devicePermissionHandler, 'device permission handler registered');
	assert.equal(session.devicePermissionHandler!({ deviceType: 'serial' }), true);
	assert.equal(session.devicePermissionHandler!({ deviceType: 'hid' }), true);
	assert.equal(session.devicePermissionHandler!({ deviceType: 'usb' }), false);
	assert.ok(session.permissionCheckHandler, 'permission check handler registered');
	assert.equal(session.permissionCheckHandler!(null, 'serial'), true);
	assert.equal(session.permissionCheckHandler!(null, 'hid'), true);
	assert.equal(session.permissionCheckHandler!(null, 'geolocation'), false);

	const noopEvent = { preventDefault() {} };
	const serialCalls: string[] = [];
	const hidCalls: string[] = [];

	// --- Serial: chooser fires (session event) → candidates surfaced to renderer.
	session.emit(
		'select-serial-port',
		noopEvent,
		[{ portId: 's1', portName: 'Scanner COM3' }],
		webContents,
		(portId: string) => serialCalls.push(`stale:${portId}`)
	);
	session.emit(
		'select-serial-port',
		noopEvent,
		[{ portId: 's1', portName: 'Scanner COM3' }, { portId: 's2' }],
		webContents,
		(portId: string) => serialCalls.push(`latest:${portId}`)
	);
	assert.equal(fakeIpcMain.listenerCount('serial-port-selected'), 1);
	assert.deepEqual(webContents.sent[webContents.sent.length - 1], {
		channel: 'serial-ports',
		payload: [
			{ id: 's1', name: 'Scanner COM3' },
			{ id: 's2', name: 's2' },
		],
	});
	// Only the latest callback fires, exactly once.
	fakeIpcMain.emit('serial-port-selected', { sender: webContents }, 's2');
	assert.deepEqual(serialCalls, ['latest:s2']);
	// A second reply with no pending chooser is dropped.
	fakeIpcMain.emit('serial-port-selected', { sender: webContents }, 's2');
	assert.deepEqual(serialCalls, ['latest:s2']);

	// A serial chooser from another window's webContents is ignored.
	const sentBefore = webContents.sent.length;
	session.emit(
		'select-serial-port',
		noopEvent,
		[{ portId: 'x' }],
		new FakeWebContents(),
		(portId: string) => serialCalls.push(`other:${portId}`)
	);
	assert.equal(webContents.sent.length, sentBefore, 'foreign serial request not surfaced');

	// --- HID: chooser fires → candidates surfaced, reply invokes callback.
	session.emit(
		'select-hid-device',
		noopEvent,
		{ deviceList: [{ deviceId: 'h1', productName: 'Barcode HID' }] },
		(deviceId: string) => hidCalls.push(deviceId)
	);
	assert.deepEqual(webContents.sent[webContents.sent.length - 1], {
		channel: 'hid-devices',
		payload: [{ id: 'h1', name: 'Barcode HID' }],
	});
	fakeIpcMain.emit('hid-device-selected', { sender: webContents }, 'h1');
	assert.deepEqual(hidCalls, ['h1']);

	// --- Window close removes every listener.
	win.emit('closed');
	assert.equal(fakeIpcMain.listenerCount('serial-port-selected'), 0);
	assert.equal(fakeIpcMain.listenerCount('hid-device-selected'), 0);
	assert.equal(session.listenerCount('select-serial-port'), 0);
	assert.equal(session.listenerCount('select-hid-device'), 0);

	console.log('device-select tests passed');
} finally {
	mutableModule._load = originalLoad;
}

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
	const { registerBluetoothSelection } =
		require('./bluetooth-select') as typeof import('./bluetooth-select');

	// Fake BrowserWindow: webContents is an EventEmitter with a send() recorder.
	class FakeWebContents extends EventEmitter {
		sent: { channel: string; payload: unknown }[] = [];
		send(channel: string, payload: unknown) {
			this.sent.push({ channel, payload });
		}
	}
	const webContents = new FakeWebContents();
	const win = new EventEmitter() as EventEmitter & { webContents: FakeWebContents };
	win.webContents = webContents;

	registerBluetoothSelection(win as never);

	const calls: string[][] = [];
	const makeCallback = (label: string) => {
		const received: string[] = [];
		calls.push(received);
		return (deviceId: string) => received.push(`${label}:${deviceId}`);
	};
	const noopEvent = { preventDefault() {} };

	// The chooser event fires repeatedly during one session — exactly ONE reply
	// listener must exist regardless of firing count.
	webContents.emit(
		'select-bluetooth-device',
		noopEvent,
		[{ deviceId: 'a', deviceName: 'Printer A' }],
		makeCallback('first')
	);
	webContents.emit(
		'select-bluetooth-device',
		noopEvent,
		[
			{ deviceId: 'a', deviceName: 'Printer A' },
			{ deviceId: 'b', deviceName: 'Printer B' },
		],
		makeCallback('second')
	);
	assert.equal(fakeIpcMain.listenerCount('bluetooth-device-selected'), 1);

	// Candidates are forwarded to the renderer on every firing.
	assert.equal(webContents.sent.length, 2);
	assert.deepEqual(webContents.sent[1], {
		channel: 'bluetooth-devices',
		payload: [
			{ id: 'a', name: 'Printer A' },
			{ id: 'b', name: 'Printer B' },
		],
	});

	// A reply invokes ONLY the latest callback, exactly once.
	fakeIpcMain.emit('bluetooth-device-selected', { sender: webContents }, 'b');
	assert.deepEqual(calls[0], []);
	assert.deepEqual(calls[1], ['second:b']);

	// A second reply with no pending chooser is dropped, not crashed.
	fakeIpcMain.emit('bluetooth-device-selected', { sender: webContents }, 'b');
	assert.deepEqual(calls[1], ['second:b']);

	// Replies from another window's webContents are ignored.
	webContents.emit(
		'select-bluetooth-device',
		noopEvent,
		[{ deviceId: 'c', deviceName: 'Printer C' }],
		makeCallback('third')
	);
	fakeIpcMain.emit('bluetooth-device-selected', { sender: new FakeWebContents() }, 'c');
	assert.deepEqual(calls[2], []);

	// Window close removes the IPC listener entirely.
	win.emit('closed');
	assert.equal(fakeIpcMain.listenerCount('bluetooth-device-selected'), 0);

	console.log('bluetooth-select tests passed');
} finally {
	mutableModule._load = originalLoad;
}

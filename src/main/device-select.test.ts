import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const fakeIpcMain = new EventEmitter();
// webContents.fromFrame: a main frame resolves to the webContents currently holding
// it; a subframe resolves through this map; anything else (a gone frame) is undefined.
const allWebContents: { mainFrame: unknown }[] = [];
const subframeOwners = new Map<unknown, unknown>();
const fromFrame = (frame: unknown) =>
	subframeOwners.get(frame) ?? allWebContents.find((wc) => wc.mainFrame === frame);
// Set to fake './util' (development mode) for a second load of device-select.
let fakeUtil: { isDevelopment: boolean } | null = null;

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return { ipcMain: fakeIpcMain, webContents: { fromFrame } };
	if (request === './util' && fakeUtil) return fakeUtil;
	if (request === './log') {
		return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	const { registerScannerDeviceSelection } =
		require('./device-select') as typeof import('./device-select');

	class FakeSession extends EventEmitter {
		devicePermissionHandler: ((details: { deviceType: string; origin: string }) => boolean) | null =
			null;
		permissionCheckHandler:
			| ((
					wc: unknown,
					permission: string,
					origin: string,
					details: { isMainFrame: boolean }
			  ) => boolean)
			| null = null;
		setDevicePermissionHandler(
			handler: (details: { deviceType: string; origin: string }) => boolean
		) {
			this.devicePermissionHandler = handler;
		}
		setPermissionCheckHandler(handler: typeof this.permissionCheckHandler) {
			this.permissionCheckHandler = handler;
		}
	}
	class FakeWebContents extends EventEmitter {
		session = new FakeSession();
		mainFrame = { id: 'initial-main-frame', url: 'about:blank' };
		sent: { channel: string; payload: unknown }[] = [];
		constructor() {
			super();
			allWebContents.push(this);
		}
		send(channel: string, payload: unknown) {
			this.sent.push({ channel, payload });
		}
		lastPayload(channel: string) {
			const forChannel = this.sent.filter((s) => s.channel === channel);
			return forChannel[forChannel.length - 1]?.payload;
		}
	}
	const webContents = new FakeWebContents();
	const win = new EventEmitter() as EventEmitter & {
		webContents: FakeWebContents;
	};
	win.webContents = webContents;
	const session = webContents.session;

	registerScannerDeviceSelection(win as never);
	// Initial navigation replaces the frame that existed when the handlers were registered.
	webContents.mainFrame = { id: 'main-frame-after-navigation', url: 'wcpos://-/index.html' };

	// Permission handlers grant serial + hid only, and only to the trusted
	// main frame of this window. 'media' stays unconditionally grantable.
	assert.equal(
		session.devicePermissionHandler!({
			deviceType: 'serial',
			origin: 'wcpos://-',
		}),
		true
	);
	assert.equal(
		session.devicePermissionHandler!({
			deviceType: 'hid',
			origin: 'https://evil.example',
		}),
		false
	);
	assert.equal(
		session.devicePermissionHandler!({
			deviceType: 'usb',
			origin: 'wcpos://-',
		}),
		false
	);
	assert.equal(
		session.permissionCheckHandler!(webContents, 'hid', 'wcpos://-', {
			isMainFrame: true,
		}),
		true
	);
	assert.equal(
		session.permissionCheckHandler!(webContents, 'hid', 'https://evil.example', {
			isMainFrame: true,
		}),
		false
	);
	assert.equal(
		session.permissionCheckHandler!(webContents, 'hid', 'wcpos://-', {
			isMainFrame: false,
		}),
		false
	);
	assert.equal(
		session.permissionCheckHandler!(null, 'hid', 'wcpos://-', {
			isMainFrame: true,
		}),
		false
	);
	// media checks must pass, or navigator.permissions.query({name:'camera'})
	// reports "denied" and the POS camera scanner re-asks on every open. This
	// holds regardless of origin/frame — see the handler's carve-out comment.
	assert.equal(
		session.permissionCheckHandler!(null, 'media', 'https://evil.example', {
			isMainFrame: false,
		}),
		true
	);
	assert.equal(
		session.permissionCheckHandler!(webContents, 'media', 'wcpos://-', {
			isMainFrame: true,
		}),
		true
	);
	// Anything that is neither a device permission nor media stays denied.
	assert.equal(
		session.permissionCheckHandler!(webContents, 'geolocation', 'wcpos://-', {
			isMainFrame: true,
		}),
		false
	);

	// The development origin (EXPO_PORT=80) is tested at the end, with development
	// mode on; this run is production.
	assert.equal(
		session.permissionCheckHandler!(webContents, 'hid', 'wcpos://-', { isMainFrame: true }),
		true,
		'production origin still trusted'
	);

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
	assert.deepEqual(webContents.lastPayload('serial-ports'), [{ id: 's1', name: 'Scanner COM3' }]);
	// A port plugged in while the picker is open is appended and re-sent.
	session.emit('serial-port-added', noopEvent, {
		portId: 's2',
		portName: 'Scanner COM4',
	});
	assert.deepEqual(webContents.lastPayload('serial-ports'), [
		{ id: 's1', name: 'Scanner COM3' },
		{ id: 's2', name: 'Scanner COM4' },
	]);
	// Unplugging removes it.
	session.emit('serial-port-removed', noopEvent, { portId: 's1' });
	assert.deepEqual(webContents.lastPayload('serial-ports'), [{ id: 's2', name: 'Scanner COM4' }]);
	// Selection invokes the callback once; after that hot-plug is inert.
	// A reply from an untrusted/sub frame cannot complete the chooser.
	fakeIpcMain.emit(
		'serial-port-selected',
		{ sender: webContents, senderFrame: { url: 'https://evil.example' } },
		's1'
	);
	assert.deepEqual(serialCalls, []);
	fakeIpcMain.emit(
		'serial-port-selected',
		{ sender: webContents, senderFrame: webContents.mainFrame },
		's2'
	);
	assert.deepEqual(serialCalls, ['s2']);
	const sentCount = webContents.sent.length;
	session.emit('serial-port-added', noopEvent, { portId: 's9' });
	assert.equal(webContents.sent.length, sentCount, 'no refresh once serial chooser resolved');

	// An untrusted frame's chooser is REFUSED, not merely ignored: the event is
	// prevented and the request cancelled with '', so an unhandled-event fail-open
	// cannot grant the very request the trust check exists to refuse.
	{
		let prevented = false;
		const refusedCalls: string[] = [];
		webContents.mainFrame = { id: 'hostile-frame', url: 'https://evil.example/' };
		session.emit(
			'select-serial-port',
			{
				preventDefault() {
					prevented = true;
				},
			},
			[{ portId: 'x1', portName: 'Scanner' }],
			webContents,
			(portId: string) => refusedCalls.push(portId)
		);
		assert.equal(prevented, true, 'untrusted serial chooser must be prevented');
		assert.deepEqual(refusedCalls, [''], 'untrusted serial chooser must be cancelled');
		webContents.mainFrame = { id: 'main-frame-after-navigation', url: 'wcpos://-/index.html' };
	}

	// A serial chooser from another window's webContents is ignored.
	const before = webContents.sent.length;
	session.emit('select-serial-port', noopEvent, [{ portId: 'x' }], new FakeWebContents(), () =>
		serialCalls.push('other')
	);
	assert.equal(webContents.sent.length, before, 'foreign serial request not surfaced');

	// A reply from a DIFFERENT (but still trusted) frame cannot complete a chooser the
	// previous document opened — the reload case greptile flagged on #318.
	{
		const staleCalls: string[] = [];
		session.emit(
			'select-serial-port',
			noopEvent,
			[{ portId: 'p1', portName: 'Scanner' }],
			webContents,
			(portId: string) => staleCalls.push(portId)
		);
		const opener = webContents.mainFrame;
		// The renderer reloads: Electron replaces the main frame with a new object.
		webContents.mainFrame = { id: 'replacement-frame', url: 'wcpos://-/index.html' };
		fakeIpcMain.emit(
			'serial-port-selected',
			{ sender: webContents, senderFrame: webContents.mainFrame },
			'p1'
		);
		assert.deepEqual(staleCalls, [], 'a replacement document must not complete the old chooser');
		// Nor can the frame that opened it: that document is gone, so isTrustedFrame
		// already rejects it.
		fakeIpcMain.emit('serial-port-selected', { sender: webContents, senderFrame: opener }, 'p1');
		assert.deepEqual(staleCalls, [], 'the replaced document cannot complete it either');
		// The main-frame navigation cancels the chooser with '' instead of stranding it.
		webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
		assert.deepEqual(staleCalls, [''], 'navigation cancels the open chooser');
		fakeIpcMain.emit(
			'serial-port-selected',
			{ sender: webContents, senderFrame: webContents.mainFrame },
			'p1'
		);
		assert.deepEqual(staleCalls, [''], 'a reply after the cancel does nothing');
		webContents.mainFrame = opener;
	}

	// --- HID: frame filter, live refresh, and no-arg cancel. -------------------
	// A request from another window's frame is not ours: not prevented, not answered.
	{
		const otherWindow = new FakeWebContents();
		otherWindow.mainFrame = { id: 'other-window-frame', url: 'wcpos://-/index.html' };
		let prevented = false;
		const foreignCalls: unknown[][] = [];
		session.emit(
			'select-hid-device',
			{
				preventDefault() {
					prevented = true;
				},
			},
			{ deviceList: [{ deviceId: 'zz' }], frame: otherWindow.mainFrame },
			(...args: unknown[]) => foreignCalls.push(args)
		);
		assert.equal(prevented, false, "another window's HID chooser must not be prevented");
		assert.deepEqual(foreignCalls, [], "another window's HID chooser must not be answered");
	}
	// A subframe of this window (the checkout iframe), and a frame that is already
	// gone (null), are refused: prevented and cancelled with no argument.
	{
		const checkoutFrame = { id: 'checkout-iframe', url: 'https://store.example/checkout' };
		subframeOwners.set(checkoutFrame, webContents);
		for (const frame of [checkoutFrame, null]) {
			let prevented = false;
			const refusedCalls: unknown[][] = [];
			session.emit(
				'select-hid-device',
				{
					preventDefault() {
						prevented = true;
					},
				},
				{ deviceList: [{ deviceId: 'zz' }], frame },
				(...args: unknown[]) => refusedCalls.push(args)
			);
			assert.equal(prevented, true, `untrusted HID chooser (${frame?.id}) must be prevented`);
			assert.deepEqual(refusedCalls, [[]], `untrusted HID chooser (${frame?.id}) cancelled`);
		}
	}
	assert.equal(webContents.sent.filter((s) => s.channel === 'hid-devices').length, 0);

	// This window's request surfaces candidates.
	session.emit(
		'select-hid-device',
		noopEvent,
		{
			deviceList: [{ deviceId: 'h1', productName: 'Barcode HID' }],
			frame: webContents.mainFrame,
		},
		(deviceId?: string) => hidCalls.push([deviceId])
	);
	assert.deepEqual(webContents.lastPayload('hid-devices'), [{ id: 'h1', name: 'Barcode HID' }]);
	// Hot-plug add refreshes.
	session.emit('hid-device-added', noopEvent, {
		device: { deviceId: 'h2', name: 'Second HID' },
	});
	assert.deepEqual(webContents.lastPayload('hid-devices'), [
		{ id: 'h1', name: 'Barcode HID' },
		{ id: 'h2', name: 'Second HID' },
	]);
	// Cancelling (empty id) calls the callback with NO argument, not ''.
	fakeIpcMain.emit(
		'hid-device-selected',
		{ sender: webContents, senderFrame: webContents.mainFrame },
		''
	);
	assert.deepEqual(hidCalls, [[undefined]]);

	// A real selection passes the id through.
	session.emit(
		'select-hid-device',
		noopEvent,
		{ deviceList: [{ deviceId: 'h3' }], frame: webContents.mainFrame },
		(deviceId?: string) => hidCalls.push([deviceId])
	);
	fakeIpcMain.emit(
		'hid-device-selected',
		{ sender: webContents, senderFrame: webContents.mainFrame },
		'h3'
	);
	assert.deepEqual(hidCalls[1], ['h3']);

	// --- Navigation: a new main-frame document cancels any open chooser. --------
	{
		const navSerial: string[] = [];
		const navHid: unknown[][] = [];
		const openBoth = () => {
			session.emit('select-serial-port', noopEvent, [{ portId: 'n1' }], webContents, (id: string) =>
				navSerial.push(id)
			);
			session.emit(
				'select-hid-device',
				noopEvent,
				{ deviceList: [{ deviceId: 'nh1' }], frame: webContents.mainFrame },
				(...args: unknown[]) => navHid.push(args)
			);
		};
		const replyBoth = () => {
			const reply = { sender: webContents, senderFrame: webContents.mainFrame };
			fakeIpcMain.emit('serial-port-selected', reply, 'n1');
			fakeIpcMain.emit('hid-device-selected', reply, 'nh1');
		};

		// An in-page route change and a subframe navigation leave both choosers open.
		openBoth();
		webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
		webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
		assert.deepEqual(navSerial, [], 'same-document/subframe navigation keeps serial open');
		assert.deepEqual(navHid, [], 'same-document/subframe navigation keeps HID open');
		replyBoth();
		assert.deepEqual(navSerial, ['n1'], 'serial chooser still completes after them');
		assert.deepEqual(navHid, [['nh1']], 'HID chooser still completes after them');

		// A main-frame navigation to a new document cancels both.
		openBoth();
		webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
		assert.deepEqual(navSerial, ['n1', ''], "navigation cancels serial with ''");
		assert.deepEqual(navHid, [['nh1'], []], 'navigation cancels HID with no argument');
		replyBoth();
		assert.deepEqual(navSerial, ['n1', ''], 'a later serial reply does nothing');
		assert.deepEqual(navHid, [['nh1'], []], 'a later HID reply does nothing');
	}

	// --- Window close removes every listener.
	win.emit('closed');
	assert.equal(fakeIpcMain.listenerCount('serial-port-selected'), 0);
	assert.equal(fakeIpcMain.listenerCount('hid-device-selected'), 0);
	assert.equal(session.listenerCount('select-serial-port'), 0);
	assert.equal(session.listenerCount('serial-port-added'), 0);
	assert.equal(session.listenerCount('select-hid-device'), 0);
	assert.equal(session.listenerCount('hid-device-added'), 0);

	// --- Development mode, EXPO_PORT=80 (a documented configuration). ---------
	// The URL parser drops a default port, so comparing url.port ('') against '80'
	// disabled every trust check; origins compare correctly. Load device-select
	// again with './util' faked to development so the isDevelopment branch runs.
	{
		const modulePath = require.resolve('./device-select');
		const originalExpoPort = process.env.EXPO_PORT;
		delete require.cache[modulePath];
		fakeUtil = { isDevelopment: true };
		process.env.EXPO_PORT = '80';
		try {
			const devModule = require('./device-select') as typeof import('./device-select');
			const devContents = new FakeWebContents();
			const devWin = new EventEmitter() as EventEmitter & { webContents: FakeWebContents };
			devWin.webContents = devContents;
			devModule.registerScannerDeviceSelection(devWin as never);
			const devHandler = devContents.session.devicePermissionHandler!;
			assert.equal(devHandler({ deviceType: 'serial', origin: 'http://localhost' }), true);
			assert.equal(devHandler({ deviceType: 'serial', origin: 'http://localhost:8088' }), false);
			assert.equal(devHandler({ deviceType: 'serial', origin: 'wcpos://-' }), false);
			devWin.emit('closed');
		} finally {
			fakeUtil = null;
			if (originalExpoPort === undefined) delete process.env.EXPO_PORT;
			else process.env.EXPO_PORT = originalExpoPort;
			delete require.cache[modulePath];
		}
	}

	console.log('device-select tests passed');
} finally {
	mutableModule._load = originalLoad;
}

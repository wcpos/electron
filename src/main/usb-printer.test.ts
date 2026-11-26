import assert from 'node:assert/strict';
import Module from 'node:module';
import { mock } from 'node:test';

import { buildUsbKey } from './device-key';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
type Handler = (event: unknown, args: unknown) => Promise<void>;
type TransferCallback = (err?: Error) => void;

const handlers = new Map<string, Handler>();
const fakeIpcMain = {
	handle(channel: string, fn: Handler) {
		handlers.set(channel, fn);
	},
};

// Models node-usb's behaviour: no default endpoint timeout, close refused while a transfer is pending.
const state = { transferPending: false, closed: false, recordedTimeout: -1 };

const out = {
	direction: 'out',
	transferType: 2,
	timeout: 0,
	transfer(_bytes: Buffer, cb: TransferCallback) {
		state.recordedTimeout = this.timeout;
		state.transferPending = true;
		if (this.timeout > 0) {
			setTimeout(() => {
				state.transferPending = false;
				cb(new Error('LIBUSB_TRANSFER_TIMED_OUT'));
			}, this.timeout);
		}
	},
};

const iface = {
	descriptor: { bInterfaceClass: 0x07 },
	claim() {},
	release(_closeEndpoints: boolean, cb: () => void) {
		cb();
	},
	isKernelDriverActive() {
		return false;
	},
	endpoints: [out],
};

const device = {
	deviceDescriptor: { idVendor: 0x04b8, idProduct: 0x0e28, iProduct: 0 },
	busNumber: 1,
	deviceAddress: 7,
	configDescriptor: { interfaces: [[{ bInterfaceClass: 0x07 }]] },
	interfaces: [iface],
	open() {
		state.closed = false;
	},
	close() {
		if (state.transferPending) throw new Error("Can't close device with a pending request");
		state.closed = true;
	},
};

const fakeUsb = {
	getDeviceList: () => [device],
	usb: { LIBUSB_TRANSFER_TYPE_BULK: 2 },
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
const originalPlatform = process.platform;

function setPlatform(platform: string) {
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function flush(turns = 5): Promise<void> {
	for (let i = 0; i < turns; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

async function main() {
	mutableModule._load = function patchedLoad(
		request: string,
		parent: NodeModule | null,
		isMain: boolean
	) {
		if (request === 'electron') return { ipcMain: fakeIpcMain };
		if (request === 'usb') return fakeUsb;
		if (request === './log') {
			return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	setPlatform('darwin');
	mock.timers.enable({ apis: ['setTimeout'] });

	require('./usb-printer');
	const handler = handlers.get('print-raw-usb');
	assert.ok(handler, 'print-raw-usb handler must be registered');

	const key = buildUsbKey({
		vid: device.deviceDescriptor.idVendor,
		pid: device.deviceDescriptor.idProduct,
		bus: device.busNumber,
		address: device.deviceAddress,
	});
	let rejection: unknown;
	const printing = handler(null, { device: key, data: [0x1b, 0x40] }).catch((err: unknown) => {
		rejection = err;
	});
	await flush();

	// Case 1
	assert.ok(
		state.recordedTimeout > 0 && state.recordedTimeout <= 20_000,
		'print-raw-usb sets a finite timeout on the bulk OUT endpoint'
	);

	// Case 2
	const case2 = 'a timed-out print leaves no pending transfer and closes the device';
	mock.timers.tick(20_000);
	await flush();
	mock.timers.tick(20_000);
	await flush();
	await printing;
	assert.match(rejection instanceof Error ? rejection.message : '', /timed out/, case2);
	assert.equal(state.transferPending, false, case2);
	assert.equal(state.closed, true, case2);

	console.log('usb-printer tests passed');
}

main()
	.then(() => {
		mock.timers.reset();
		setPlatform(originalPlatform);
		mutableModule._load = originalLoad;
		process.exit(0);
	})
	.catch((error) => {
		mock.timers.reset();
		setPlatform(originalPlatform);
		mutableModule._load = originalLoad;
		console.error(error);
		process.exit(1);
	});

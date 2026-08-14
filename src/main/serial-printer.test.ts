import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

// ── Fake ipcMain ──────────────────────────────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const fakeIpcMain = {
	handle(channel: string, fn: (...args: unknown[]) => unknown) {
		handlers.set(channel, fn);
	},
};

// ── Fake SerialPort ───────────────────────────────────────────────────────────
type PortCallback = (err?: Error | null) => void;

interface PortCall {
	method: string;
	arg?: unknown;
}

class FakeSerialPort extends EventEmitter {
	static listResult: { path: string }[] = [];
	static listError: Error | null = null;
	static instances: FakeSerialPort[] = [];

	readonly path: string;
	readonly baudRate: number;
	isOpen = false;
	calls: PortCall[] = [];

	// Control knobs set per-test
	openError: Error | null = null;
	writeError: Error | null = null;
	drainError: Error | null = null;

	constructor(opts: { path: string; baudRate: number; autoOpen: boolean }) {
		super();
		this.path = opts.path;
		this.baudRate = opts.baudRate;
		FakeSerialPort.instances.push(this);
	}

	static list(): Promise<{ path: string }[]> {
		if (FakeSerialPort.listError) return Promise.reject(FakeSerialPort.listError);
		return Promise.resolve(FakeSerialPort.listResult);
	}

	open(cb: PortCallback) {
		this.calls.push({ method: 'open' });
		if (this.openError) {
			cb(this.openError);
			return;
		}
		this.isOpen = true;
		cb(null);
	}

	write(buf: Buffer, cb: PortCallback) {
		this.calls.push({ method: 'write', arg: Array.from(buf) });
		cb(this.writeError ?? null);
	}

	drain(cb: PortCallback) {
		this.calls.push({ method: 'drain' });
		cb(this.drainError ?? null);
	}

	close(cb?: () => void) {
		this.calls.push({ method: 'close' });
		this.isOpen = false;
		cb?.();
	}
}

// ── Module patching ───────────────────────────────────────────────────────────
const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;

function installDefaultLoad() {
	mutableModule._load = function patchedLoad(
		request: string,
		parent: NodeModule | null,
		isMain: boolean
	) {
		if (request === 'electron') return { ipcMain: fakeIpcMain };
		if (request === './log') {
			return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
		}
		if (request === 'serialport') return { SerialPort: FakeSerialPort };
		return originalLoad.call(this, request, parent, isMain);
	};
}

function setPlatform(platform: string) {
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

const originalPlatform = process.platform;

async function main() {
	installDefaultLoad();

	// Load module — registers handlers at top level via ipcMain.handle
	const { filterSerialPorts, SERIAL_PREFIX } =
		require('./serial-printer') as typeof import('./serial-printer');

	// ──────────────────────────────────────────────────────────────────────────
	// filterSerialPorts — darwin
	// ──────────────────────────────────────────────────────────────────────────

	setPlatform('darwin');

	// Only /dev/cu.* pass on macOS; /dev/tty.* are dropped; noise patterns excluded
	assert.deepEqual(
		filterSerialPorts([
			{ path: '/dev/tty.Bluetooth-Incoming-Port' },
			{ path: '/dev/cu.Bluetooth-Incoming-Port' }, // noise pattern also drops this
			{ path: '/dev/tty.usbserial-0001' },
			{ path: '/dev/cu.usbserial-0001' },
			{ path: '/dev/cu.TM-P20-SerialPort' },
		]),
		[
			{ id: 'serial:/dev/cu.usbserial-0001', name: 'usbserial 0001' },
			{ id: 'serial:/dev/cu.TM-P20-SerialPort', name: 'TM P20 SerialPort' },
		]
	);

	// Noise-pattern test: Bluetooth-Incoming-Port is excluded
	const noisy = filterSerialPorts([{ path: '/dev/cu.Bluetooth-Incoming-Port' }]);
	assert.equal(noisy.length, 0, 'Bluetooth-Incoming-Port should be filtered out');

	// Name mapping: hyphen/underscore → space
	const mapped = filterSerialPorts([{ path: '/dev/cu.TM-T20III-Receipt' }]);
	assert.deepEqual(mapped, [{ id: 'serial:/dev/cu.TM-T20III-Receipt', name: 'TM T20III Receipt' }]);

	// ──────────────────────────────────────────────────────────────────────────
	// filterSerialPorts — linux rfcomm naming
	// ──────────────────────────────────────────────────────────────────────────

	setPlatform('linux');

	// /dev/rfcomm0 → stripped is '0' (just digits) → fall back to basename 'rfcomm0'
	const rfcomm = filterSerialPorts([{ path: '/dev/rfcomm0' }, { path: '/dev/rfcomm12' }]);
	assert.deepEqual(rfcomm, [
		{ id: 'serial:/dev/rfcomm0', name: 'rfcomm0' },
		{ id: 'serial:/dev/rfcomm12', name: 'rfcomm12' },
	]);

	// /dev/ttyUSB0 on Linux (no darwin filter): regex strips cu./tty./rfcomm but not plain 'tty',
	// so the full basename 'ttyUSB0' is used as-is (not all-digits, so fallback doesn't apply).
	const linuxUsb = filterSerialPorts([{ path: '/dev/ttyUSB0' }]);
	assert.deepEqual(linuxUsb, [{ id: 'serial:/dev/ttyUSB0', name: 'ttyUSB0' }]);

	// ──────────────────────────────────────────────────────────────────────────
	// SERIAL_PREFIX constant
	// ──────────────────────────────────────────────────────────────────────────
	assert.equal(SERIAL_PREFIX, 'serial:');

	// ──────────────────────────────────────────────────────────────────────────
	// serial-discovery handler — win32 returns [] without calling list()
	// ──────────────────────────────────────────────────────────────────────────
	const discoveryHandler = handlers.get('serial-discovery') as () => Promise<unknown>;
	assert.ok(discoveryHandler, 'serial-discovery handler must be registered');

	FakeSerialPort.instances.length = 0;
	FakeSerialPort.listResult = [{ path: '/dev/cu.Printer-1' }];

	setPlatform('win32');
	const win32Result = await discoveryHandler();
	assert.deepEqual(win32Result, [], 'serial-discovery should return [] on win32');
	// list() must not be called on win32
	assert.equal(FakeSerialPort.instances.length, 0, 'SerialPort.list should not be called on win32');

	// ──────────────────────────────────────────────────────────────────────────
	// serial-discovery handler — non-win32 calls SerialPort.list
	// ──────────────────────────────────────────────────────────────────────────
	setPlatform('darwin');
	FakeSerialPort.listResult = [
		{ path: '/dev/tty.Bluetooth-Incoming-Port' },
		{ path: '/dev/cu.TM-T88V-SerialPort' },
	];
	const darwinResult = (await discoveryHandler()) as { id: string; name: string }[];
	assert.equal(darwinResult.length, 1, 'darwin discovery should return 1 filtered port');
	assert.deepEqual(darwinResult[0], {
		id: 'serial:/dev/cu.TM-T88V-SerialPort',
		name: 'TM T88V SerialPort',
		connectionType: 'bluetooth',
		address: 'serial:/dev/cu.TM-T88V-SerialPort',
		vendor: 'generic',
	});

	// ──────────────────────────────────────────────────────────────────────────
	// print-raw-serial handler — arg validation
	// ──────────────────────────────────────────────────────────────────────────
	const printHandler = handlers.get('print-raw-serial') as (
		_e: null,
		args: unknown
	) => Promise<void>;
	assert.ok(printHandler, 'print-raw-serial handler must be registered');

	// missing args
	await assert.rejects(
		() => printHandler(null, null),
		/Invalid arguments/,
		'should reject missing args'
	);

	// wrong prefix
	await assert.rejects(
		() => printHandler(null, { device: 'usb:1:2:3:4', data: [0x1b, 0x40] }),
		/Invalid serial device key/,
		'should reject non-serial device key'
	);

	// non-byte data
	await assert.rejects(
		() => printHandler(null, { device: 'serial:/dev/cu.Printer', data: [0, 300] }),
		/Invalid data/,
		'should reject out-of-range byte values'
	);

	// non-array data
	await assert.rejects(
		() => printHandler(null, { device: 'serial:/dev/cu.Printer', data: 'hello' }),
		/Invalid data/,
		'should reject non-array data'
	);

	// ──────────────────────────────────────────────────────────────────────────
	// print-raw-serial handler — happy path: open → write → drain → close
	// ──────────────────────────────────────────────────────────────────────────
	FakeSerialPort.instances.length = 0;
	setPlatform('darwin');

	await printHandler(null, { device: 'serial:/dev/cu.TestPrinter', data: [0x1b, 0x40, 0x0a] });

	assert.equal(FakeSerialPort.instances.length, 1, 'exactly one SerialPort should be constructed');
	const happyPort = FakeSerialPort.instances[0];
	assert.equal(happyPort.path, '/dev/cu.TestPrinter');
	assert.equal(happyPort.baudRate, 9600);
	assert.deepEqual(
		happyPort.calls.map((c) => c.method),
		['open', 'write', 'drain', 'close'],
		'calls should be open → write → drain → close'
	);
	assert.deepEqual(
		happyPort.calls[1].arg,
		[0x1b, 0x40, 0x0a],
		'write should receive the data buffer'
	);

	// ──────────────────────────────────────────────────────────────────────────
	// print-raw-serial handler — write failure still calls close
	// ──────────────────────────────────────────────────────────────────────────

	// Re-require with a FakeSerialPort variant that fails on write
	delete require.cache[require.resolve('./serial-printer')];
	handlers.clear();

	class WriteFailSerialPort extends FakeSerialPort {
		constructor(opts: { path: string; baudRate: number; autoOpen: boolean }) {
			super(opts);
			this.writeError = new Error('write failed intentionally');
		}
	}

	mutableModule._load = function patchedLoadWriteFail(
		request: string,
		parent: NodeModule | null,
		isMain: boolean
	) {
		if (request === 'electron') return { ipcMain: fakeIpcMain };
		if (request === './log') {
			return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
		}
		if (request === 'serialport') return { SerialPort: WriteFailSerialPort };
		return originalLoad.call(this, request, parent, isMain);
	};

	require('./serial-printer');

	const printHandlerWriteFail = handlers.get('print-raw-serial') as (
		_e: null,
		args: unknown
	) => Promise<void>;

	FakeSerialPort.instances.length = 0;
	await assert.rejects(
		() =>
			printHandlerWriteFail(null, {
				device: 'serial:/dev/cu.TestPrinter',
				data: [0x1b, 0x40],
			}),
		/write failed intentionally/,
		'should propagate write error'
	);

	assert.ok(
		FakeSerialPort.instances.length > 0 &&
			FakeSerialPort.instances[FakeSerialPort.instances.length - 1].calls.some(
				(c) => c.method === 'close'
			),
		'close should be called even when write fails'
	);

	// ──────────────────────────────────────────────────────────────────────────
	// print-raw-serial handler — ghost-print guard: open() resolves after timeout
	// ──────────────────────────────────────────────────────────────────────────
	// Arrange: use a FakeSerialPort that captures the open callback without
	// calling it immediately (simulating a slow device handshake that exceeds
	// the print timeout). The module's PRINT_TIMEOUT_MS export is set to a
	// small value so the test runs fast.
	delete require.cache[require.resolve('./serial-printer')];
	handlers.clear();

	let capturedOpenCallback: PortCallback | null = null;

	class DeferredOpenSerialPort extends FakeSerialPort {
		open(cb: PortCallback) {
			this.calls.push({ method: 'open' });
			// Capture a wrapper that sets isOpen before calling the original callback,
			// matching what the real SerialPort does when it finally opens.
			capturedOpenCallback = (err?: Error | null): void => {
				if (!err) this.isOpen = true;
				cb(err);
			};
		}
	}

	mutableModule._load = function patchedLoadDeferred(
		request: string,
		parent: NodeModule | null,
		isMain: boolean
	) {
		if (request === 'electron') return { ipcMain: fakeIpcMain };
		if (request === './log') {
			return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
		}
		if (request === 'serialport') return { SerialPort: DeferredOpenSerialPort };
		return originalLoad.call(this, request, parent, isMain);
	};

	// Shrink the timeout to 10ms so the test completes immediately.
	// printConfig is an exported mutable object — mutating its property affects the
	// live module scope because the handler reads printConfig.timeoutMs at call time.
	const { printConfig } = require('./serial-printer') as typeof import('./serial-printer');
	const originalTimeoutMs = printConfig.timeoutMs;
	printConfig.timeoutMs = 10;

	const ghostPrintHandler = handlers.get('print-raw-serial') as (
		_e: null,
		args: unknown
	) => Promise<void>;

	FakeSerialPort.instances.length = 0;
	capturedOpenCallback = null;

	// Start the print — it will time out in 10ms before open() resolves.
	// Immediately attach a catch handler to prevent Node from treating the
	// eventual rejection as unhandled before assert.rejects observes it.
	const ghostPrintPromise = ghostPrintHandler(null, {
		device: 'serial:/dev/cu.GhostPrinter',
		data: [0x1b, 0x40],
	});
	// Suppress unhandled-rejection noise; assert.rejects below will still see the error.
	ghostPrintPromise.catch((_err: unknown): void => undefined);

	// Assert the promise rejects with a timeout error (also waits for it to settle)
	await assert.rejects(
		() => ghostPrintPromise,
		/timed out/,
		'ghost-print: should reject with timeout when open() takes too long'
	);

	// Now fire the late open callback — simulates the device finally opening
	// after the renderer has already seen a failure
	assert.ok(capturedOpenCallback !== null, 'ghost-print: open callback should have been captured');
	(capturedOpenCallback as PortCallback)(null);

	// Give the late callback a tick to run cleanup
	await new Promise<void>((res) => setTimeout(res, 10));

	assert.equal(FakeSerialPort.instances.length, 1, 'ghost-print: exactly one port created');
	const ghostPort = FakeSerialPort.instances[0];

	// write must NEVER have been called — the guard prevented the ghost print
	assert.ok(
		!ghostPort.calls.some((c) => c.method === 'write'),
		'ghost-print: write must not be called after timeout'
	);

	// close must be called — the guard closes the now-open port
	assert.ok(
		ghostPort.calls.some((c) => c.method === 'close'),
		'ghost-print: close must be called to release the port after late open'
	);

	// Restore printConfig.timeoutMs to its original value for subsequent tests
	printConfig.timeoutMs = originalTimeoutMs;

	// ──────────────────────────────────────────────────────────────────────────
	// print-raw-serial handler — empty path: 'serial:' with no path component
	// ──────────────────────────────────────────────────────────────────────────
	// Re-use the last loaded module's handler (deferred-open variant is fine for
	// validation tests — the handler rejects before constructing a SerialPort)
	await assert.rejects(
		() => ghostPrintHandler(null, { device: 'serial:', data: [0x1b] }),
		/Invalid serial device key/,
		'empty path: device "serial:" with no port path should be rejected'
	);

	// Restore default loader
	installDefaultLoad();

	console.log('serial-printer tests passed');
}

main()
	.then(() => {
		setPlatform(originalPlatform);
		mutableModule._load = originalLoad;
	})
	.catch((error) => {
		setPlatform(originalPlatform);
		mutableModule._load = originalLoad;
		console.error(error);
		process.exit(1);
	});

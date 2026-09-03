import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

interface FakeConnectOptions {
	host: string;
	port: number;
	servername: string;
	rejectUnauthorized: boolean;
}

class FakeSocket extends EventEmitter {
	static instances: FakeSocket[] = [];
	static connect(options: FakeConnectOptions, callback: () => void): FakeSocket {
		const socket = new FakeSocket();
		socket.options = options;
		queueMicrotask(callback);
		return socket;
	}
	options: FakeConnectOptions | null = null;
	written: Buffer[] = [];
	ended = false;
	destroyed = false;
	constructor() {
		super();
		FakeSocket.instances.push(this);
	}
	write(bytes: Buffer, callback: (err?: Error) => void): boolean {
		this.written.push(bytes);
		queueMicrotask(() => callback());
		return true;
	}
	end(callback: () => void): this {
		this.ended = true;
		queueMicrotask(callback);
		return this;
	}
	destroy(): this {
		this.destroyed = true;
		return this;
	}
}

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;

mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'tls') return { connect: FakeSocket.connect };
	if (request === 'electron') {
		return {
			ipcMain: {
				handle(channel: string, handler: (...args: unknown[]) => unknown) {
					handlers.set(channel, handler);
				},
			},
		};
	}
	if (request === './log') {
		return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
	}
	return originalLoad.call(this, request, parent, isMain);
};

(async () => {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- test installs Module._load fakes before loading the module
		const { createTlsDelivery } = require('./print-raw-tls') as {
			createTlsDelivery: (
				host: string,
				port: number
			) => {
				send(bytes: Buffer, ctx: { settled: () => boolean }): Promise<void>;
				cleanup(): void;
			};
		};

		// The factory must not open a socket; only send() does.
		const delivery = createTlsDelivery('192.168.1.50', 9143);
		assert.equal(FakeSocket.instances.length, 0, 'no socket is created at factory time');

		await delivery.send(Buffer.from([0x1b, 0x40]), { settled: () => false });
		assert.equal(FakeSocket.instances.length, 1, 'send() creates the socket');
		const socket = FakeSocket.instances[0];
		assert.deepEqual(socket.options, {
			host: '192.168.1.50',
			port: 9143,
			servername: '192.168.1.50',
			rejectUnauthorized: false,
		});
		assert.deepEqual(socket.written, [Buffer.from([0x1b, 0x40])]);
		assert.equal(socket.ended, true);

		delivery.cleanup();
		assert.equal(socket.destroyed, true, 'cleanup() destroys the socket');
		// Late errors after settle + destroy must never become unhandled 'error' events.
		// A `once` listener would absorb only the first; the second would throw.
		assert.doesNotThrow(() => socket.emit('error', new Error('late ECONNRESET')));
		assert.doesNotThrow(() => socket.emit('error', new Error('second late error')));
		assert.ok(socket.listenerCount('error') >= 1, 'the error guard persists after errors');

		// A successful send must not mask an unexpected close on the next operation.
		const secondSend = delivery.send(Buffer.from([0x0a]), { settled: () => false });
		const secondSocket = FakeSocket.instances[1];
		secondSocket.emit('close');
		await assert.rejects(secondSend, /closed unexpectedly/);
		delivery.cleanup();
		assert.equal(secondSocket.destroyed, true, 'cleanup() destroys the latest socket');

		// If a timeout settles while the handshake is pending, no bytes are written afterward.
		let settled = false;
		const timedOutDelivery = createTlsDelivery('printer.local', 9143);
		const timedOutSend = timedOutDelivery.send(Buffer.from([0x1b]), {
			settled: () => settled,
		});
		settled = true;
		await timedOutSend;
		const timedOutSocket = FakeSocket.instances[2];
		assert.deepEqual(timedOutSocket.written, []);

		// A zero-length payload is a reachability probe: connect and end without writing.
		const probe = createTlsDelivery('printer.local', 9143);
		await probe.send(Buffer.alloc(0), { settled: () => false });
		const probeSocket = FakeSocket.instances[3];
		assert.deepEqual(probeSocket.written, []);
		assert.equal(probeSocket.ended, true);

		// cleanup() before any send() is a no-op rather than a crash.
		assert.doesNotThrow(() => createTlsDelivery('h', 1).cleanup());

		// Invalid payloads are rejected before a socket exists, so nothing leaks.
		const handler = handlers.get('print-raw-tls');
		assert.ok(handler, 'print-raw-tls handler should be registered');
		const before = FakeSocket.instances.length;
		await assert.rejects(
			Promise.resolve(handler(null, { host: '192.168.1.50', port: 9143, data: 'not-bytes' })),
			/Invalid data/
		);
		assert.equal(
			FakeSocket.instances.length,
			before,
			'no socket is created for an invalid payload'
		);

		console.log('print-raw-tls tests passed');
	} finally {
		mutableModule._load = originalLoad;
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

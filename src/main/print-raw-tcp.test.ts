import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

class FakeSocket extends EventEmitter {
	static instances: FakeSocket[] = [];
	connected: { port: number; host: string } | null = null;
	written: Buffer[] = [];
	ended = false;
	destroyed = false;
	constructor() {
		super();
		FakeSocket.instances.push(this);
	}
	connect(port: number, host: string, callback: () => void): this {
		this.connected = { port, host };
		queueMicrotask(callback);
		return this;
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
	if (request === 'net') return { Socket: FakeSocket };
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
		const { createTcpDelivery } = require('./print-raw-tcp') as {
			createTcpDelivery: (
				host: string,
				port: number
			) => {
				send(bytes: Buffer, ctx: { settled: () => boolean }): Promise<void>;
				cleanup(): void;
			};
		};

		// The factory must not open a socket; only send() does.
		const delivery = createTcpDelivery('192.168.1.50', 9100);
		assert.equal(FakeSocket.instances.length, 0, 'no socket is created at factory time');

		await delivery.send(Buffer.from([0x1b, 0x40]), { settled: () => false });
		assert.equal(FakeSocket.instances.length, 1, 'send() creates the socket');
		const socket = FakeSocket.instances[0];
		assert.deepEqual(socket.connected, { port: 9100, host: '192.168.1.50' });
		assert.deepEqual(socket.written, [Buffer.from([0x1b, 0x40])]);
		assert.equal(socket.ended, true);

		delivery.cleanup();
		assert.equal(socket.destroyed, true, 'cleanup() destroys the socket');
		// Late errors after settle + destroy must never become unhandled 'error' events.
		// A `once` listener would absorb only the first; the second would throw.
		assert.doesNotThrow(() => socket.emit('error', new Error('late ECONNRESET')));
		assert.doesNotThrow(() => socket.emit('error', new Error('second late error')));
		assert.ok(socket.listenerCount('error') >= 1, 'the error guard persists after errors');

		// cleanup() before any send() is a no-op rather than a crash.
		assert.doesNotThrow(() => createTcpDelivery('h', 1).cleanup());

		// Invalid payloads are rejected before a socket exists, so nothing leaks.
		const handler = handlers.get('print-raw-tcp');
		assert.ok(handler, 'print-raw-tcp handler should be registered');
		const before = FakeSocket.instances.length;
		await assert.rejects(
			Promise.resolve(handler(null, { host: '192.168.1.50', port: 9100, data: 'not-bytes' })),
			/Invalid data/
		);
		assert.equal(
			FakeSocket.instances.length,
			before,
			'no socket is created for an invalid payload'
		);

		console.log('print-raw-tcp tests passed');
	} finally {
		mutableModule._load = originalLoad;
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

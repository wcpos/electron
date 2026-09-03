import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

const handledChannels: string[] = [];
const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>();
const infoLogs: unknown[][] = [];
const warnLogs: unknown[][] = [];

class FakeBrowser extends EventEmitter {
	stop() {}
}

class FakeBonjour {
	static latest: FakeBonjour;
	readonly browsers: FakeBrowser[] = [];
	constructor(
		_options: Record<string, unknown> = {},
		private readonly onError?: (error: Error) => void
	) {
		FakeBonjour.latest = this;
	}
	find() {
		const browser = new FakeBrowser();
		this.browsers.push(browser);
		return browser;
	}
	triggerError(error: Error) {
		this.onError?.(error);
	}
	destroy() {}
}

const electronMock = {
	ipcMain: {
		handle(channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) {
			handledChannels.push(channel);
			handlers.set(channel, handler);
		},
	},
};

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return electronMock;
	if (request === 'bonjour-service') return FakeBonjour;
	if (request === './log') {
		return {
			logger: {
				error() {},
				info(...args: unknown[]) {
					infoLogs.push(args);
				},
				warn(...args: unknown[]) {
					warnLogs.push(args);
				},
				debug() {},
			},
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	const { mapMdnsServiceToPrinter } =
		require('./printer-discovery') as typeof import('./printer-discovery');

	assert.ok(
		handledChannels.includes('printer-discovery'),
		'printer discovery should register the printer-discovery IPC channel'
	);

	assert.deepEqual(
		mapMdnsServiceToPrinter({
			name: 'Epson TM-T88',
			type: 'pdl-datastream',
			port: 9100,
			host: 'epson.local',
			addresses: ['169.254.1.10', '192.168.1.44'],
		}),
		{
			id: 'mdns-192.168.1.44-9100',
			name: 'Epson TM-T88',
			connectionType: 'network',
			address: '192.168.1.44',
			port: 9100,
			vendor: 'epson',
		}
	);

	assert.deepEqual(
		mapMdnsServiceToPrinter({
			name: 'Star printer',
			type: 'printer',
			host: 'star-printer.local',
			addresses: [],
		}),
		{
			id: 'mdns-star-printer.local-9100',
			name: 'Star printer',
			connectionType: 'network',
			address: 'star-printer.local',
			port: 9100,
			vendor: 'star',
		}
	);

	assert.deepEqual(
		mapMdnsServiceToPrinter({
			name: 'Invalid port printer',
			type: 'printer',
			port: 70000,
			host: 'invalid-port.local',
			addresses: ['192.168.1.45'],
		}),
		{
			id: 'mdns-192.168.1.45-9100',
			name: 'Invalid port printer',
			connectionType: 'network',
			address: '192.168.1.45',
			port: 9100,
			vendor: 'generic',
		}
	);

	// Regression: the Epson TM-m30III advertises _ipp on 631. Raw ESC/POS bytes sent to
	// the IPP port are accepted and silently discarded, so ipp/ipps/lpd results must map
	// to jetdirect 9100 rather than carrying the advertised protocol port.
	assert.deepEqual(
		mapMdnsServiceToPrinter({
			name: 'EPSON TM-m30III',
			type: 'ipp',
			port: 631,
			host: 'epson-m30.local',
			addresses: ['192.168.1.131'],
		}),
		{
			id: 'mdns-192.168.1.131-9100',
			name: 'EPSON TM-m30III',
			connectionType: 'network',
			address: '192.168.1.131',
			port: 9100,
			vendor: 'epson',
		}
	);

	assert.equal(
		mapMdnsServiceToPrinter({
			name: 'Custom raw port',
			type: 'pdl-datastream',
			port: 9101,
			host: 'custom.local',
			addresses: ['192.168.1.46'],
		})?.port,
		9101,
		'pdl-datastream advertises a raw socket, so its advertised port is trusted'
	);

	assert.equal(
		mapMdnsServiceToPrinter({ name: 'No address', type: 'printer' }),
		null,
		'services without host/address should be ignored'
	);

	const handler = handlers.get('printer-discovery');
	assert.ok(handler);
	const scan = handler(null, { action: 'start', timeoutMs: 250 });
	FakeBonjour.latest.triggerError(new Error('socket failed'));
	assert.deepEqual(
		warnLogs,
		[['[printer-discovery] mDNS error', { message: 'socket failed' }]],
		'a shared mDNS error should be logged once through the Bonjour error callback'
	);
	FakeBonjour.latest.browsers[0].emit('up', {
		name: 'Logged printer',
		type: 'ipp',
		port: 631,
		addresses: ['192.168.1.80'],
	});
	scan
		.then(() => {
			assert.ok(
				infoLogs.some(
					([message, fields]) =>
						message === '[printer-discovery] scan ended' &&
						(fields as { upEvents?: number }).upEvents === 1 &&
						(fields as { printersMapped?: number }).printersMapped === 1 &&
						typeof (fields as { elapsedMs?: number }).elapsedMs === 'number'
				),
				'scan outcome should be logged'
			);
			console.log('printer discovery assertions passed');
		})
		.catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
} finally {
	mutableModule._load = originalLoad;
}

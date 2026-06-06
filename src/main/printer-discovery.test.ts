import assert from 'node:assert/strict';
import Module from 'node:module';

const handledChannels: string[] = [];

const electronMock = {
	ipcMain: {
		handle(channel: string) {
			handledChannels.push(channel);
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
	if (request === './log') {
		return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
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

	assert.equal(
		mapMdnsServiceToPrinter({ name: 'No address', type: 'printer' }),
		null,
		'services without host/address should be ignored'
	);
} finally {
	mutableModule._load = originalLoad;
}

console.log('printer discovery assertions passed');

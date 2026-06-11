import assert from 'node:assert/strict';
import Module from 'node:module';

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
	if (request === 'electron') return {};
	if (request === './log') {
		return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	const { WINSPOOL_PREFIX, RAW_PRINT_PS_SCRIPT, encodePsCommand, filterSpoolerPrinters } =
		require('./winspool-printer') as typeof import('./winspool-printer');

	// Virtual queues present on every Windows install are excluded; real queues map to
	// `winspool:<queue name>` ids carrying the OpenPrinterW-compatible name.
	assert.deepEqual(
		filterSpoolerPrinters([
			{ name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF' },
			{ name: 'Microsoft XPS Document Writer' },
			{ name: 'OneNote (Desktop)' },
			{ name: 'OneNote for Windows 10' },
			{ name: 'Fax' },
			{ name: 'EPSON TM-T20III Receipt', displayName: 'Front counter printer' },
			{ name: 'Generic / Text Only' },
		]),
		[
			{ id: 'winspool:EPSON TM-T20III Receipt', name: 'Front counter printer' },
			{ id: 'winspool:Generic / Text Only', name: 'Generic / Text Only' },
		]
	);

	assert.equal(WINSPOOL_PREFIX, 'winspool:');

	// -EncodedCommand is base64 over UTF-16LE; a round-trip must reproduce the script.
	const encoded = encodePsCommand(RAW_PRINT_PS_SCRIPT);
	assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
	assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), RAW_PRINT_PS_SCRIPT);

	// The script must use the spooler RAW datatype via winspool.drv wide entry points and
	// take its inputs from the environment (nothing user-controlled is interpolated).
	assert.ok(RAW_PRINT_PS_SCRIPT.includes('winspool.drv'));
	assert.ok(RAW_PRINT_PS_SCRIPT.includes('OpenPrinterW'));
	assert.ok(RAW_PRINT_PS_SCRIPT.includes('StartDocPrinterW'));
	assert.ok(RAW_PRINT_PS_SCRIPT.includes('pDataType = "RAW"'));
	assert.ok(RAW_PRINT_PS_SCRIPT.includes('$env:WCPOS_RAW_PRINT_PRINTER'));
	assert.ok(RAW_PRINT_PS_SCRIPT.includes('$env:WCPOS_RAW_PRINT_FILE'));

	console.log('winspool-printer tests passed');
} finally {
	mutableModule._load = originalLoad;
}

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import path from 'node:path';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
const spawned: { command: string; args: readonly string[] }[] = [];
function fakeSpawn(command: string, args: readonly string[]) {
	spawned.push({ command, args });
	const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() {} });
	process.nextTick(() => child.emit('close', 0));
	return child;
}
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return {};
	if (request === 'node:child_process') {
		const real = originalLoad.call(this, request, parent, isMain) as object;
		return { ...real, spawn: fakeSpawn };
	}
	if (request === './log') {
		return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	const {
		WINSPOOL_PREFIX,
		RAW_PRINT_PS_SCRIPT,
		encodePsCommand,
		filterSpoolerPrinters,
		powershellPath,
		printRawToSpooler,
	} = require('./winspool-printer') as typeof import('./winspool-printer');

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

	const savedSystemRoot = process.env.SystemRoot;
	const savedWindir = process.env.windir;
	try {
		process.env.SystemRoot = 'D:\\Win';
		assert.equal(
			powershellPath(),
			'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			'powershellPath resolves under the Windows directory'
		);
		delete process.env.SystemRoot;
		delete process.env.windir;
		assert.equal(
			powershellPath(),
			'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			'powershellPath resolves under the Windows directory'
		);
	} finally {
		if (savedSystemRoot === undefined) delete process.env.SystemRoot;
		else process.env.SystemRoot = savedSystemRoot;
		if (savedWindir === undefined) delete process.env.windir;
		else process.env.windir = savedWindir;
	}

	void printRawToSpooler('Test Printer', Buffer.from('x'))
		.then(() => {
			const message =
				'printRawToSpooler spawns the absolute System32\\WindowsPowerShell\\v1.0\\powershell.exe path';
			assert.equal(spawned.length, 1, message);
			assert.equal(spawned[0].command, powershellPath(), message);
			assert.ok(path.win32.isAbsolute(spawned[0].command), message);
			console.log('winspool-printer tests passed');
		})
		.catch((err: unknown) => {
			console.error(err);
			process.exitCode = 1;
		});
} finally {
	mutableModule._load = originalLoad;
}

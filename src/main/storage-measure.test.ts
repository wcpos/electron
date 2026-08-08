import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
	if (request === 'electron') return { ipcMain: { handle() {} } };
	if (request === './log') return { logger: { error() {} } };
	if (request === './rxdb-storage') {
		return {
			getFilesystemNodeBasePath() {},
			getLegacySqliteBasePath() {},
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

async function main() {
	let measureStorage: typeof import('./storage-measure').measureStorage;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		({ measureStorage } = require('./storage-measure'));
	} finally {
		mutableModule._load = originalLoad;
	}

	const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'storage-measure-test-'));
	const filesystemPath = path.join(fixture, 'fsdbs');
	const legacyPath = path.join(fixture, 'legacy-sqlite');

	try {
		await fs.promises.mkdir(path.join(filesystemPath, 'orders', 'nested'), { recursive: true });
		await fs.promises.mkdir(path.join(legacyPath, 'ignored-directory'), { recursive: true });
		await fs.promises.writeFile(path.join(filesystemPath, 'orders', 'one.bin'), '1234');
		await fs.promises.writeFile(path.join(filesystemPath, 'orders', 'nested', 'two.bin'), '123456');
		await fs.promises.writeFile(path.join(filesystemPath, 'plain.bin'), '123');
		await fs.promises.writeFile(path.join(legacyPath, 'store_v3.sqlite3'), '12345');
		await fs.promises.symlink(
			path.join(filesystemPath, 'orders'),
			path.join(filesystemPath, 'orders-link')
		);
		await fs.promises.symlink(
			path.join(legacyPath, 'store_v3.sqlite3'),
			path.join(legacyPath, 'store-link.sqlite3')
		);

		const result = await measureStorage(filesystemPath, legacyPath);
		assert.deepEqual(
			result.entries.sort((a, b) => a.name.localeCompare(b.name)),
			[
				{ name: 'orders', bytes: 10, root: 'fsdbs' },
				{ name: 'plain.bin', bytes: 3, root: 'fsdbs' },
				{ name: 'store_v3.sqlite3', bytes: 5, root: 'legacy-sqlite' },
			]
		);

		assert.deepEqual(
			await measureStorage(path.join(fixture, 'missing-fsdbs'), path.join(fixture, 'missing-legacy')),
			{ entries: [] }
		);
	} finally {
		await fs.promises.rm(fixture, { recursive: true, force: true });
	}

	console.log('storage measurement assertions passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

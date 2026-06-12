import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import forgeConfig from '../forge.config';

async function main() {
	const buildPath = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'wcpos-package-runtime-'))
	);
	const webpackMainPath = path.join(buildPath, '.webpack', 'main');
	const sqliteBuildPath = path.join(buildPath, 'node_modules', 'better-sqlite3', 'build');

	fs.mkdirSync(webpackMainPath, { recursive: true });
	fs.mkdirSync(sqliteBuildPath, { recursive: true });
	fs.writeFileSync(path.join(webpackMainPath, 'index.js'), '// packaged main entry');
	fs.writeFileSync(path.join(sqliteBuildPath, 'placeholder.txt'), 'remove me');

	try {
		assert.ok(
			forgeConfig.hooks?.packageAfterPrune,
			'forge config should define a packageAfterPrune hook'
		);

		await forgeConfig.hooks.packageAfterPrune(
			forgeConfig as any,
			buildPath,
			'41.7.1',
			'darwin',
			'arm64'
		);

		assert.equal(
			fs.existsSync(sqliteBuildPath),
			false,
			'packageAfterPrune should still remove better-sqlite3 build artifacts before signing'
		);

		const packagedRequire = createRequire(path.join(webpackMainPath, 'index.js'));
		const nodeGypBuildPath = path.join(buildPath, 'node_modules', 'node-gyp-build');
		const usbEntry = packagedRequire.resolve('usb');
		const usbModule = packagedRequire('usb') as typeof import('usb');

		assert.ok(
			fs.existsSync(nodeGypBuildPath),
			'packageAfterPrune should copy node-gyp-build for usb native binding resolution'
		);
		assert.ok(
			usbEntry.startsWith(path.join(buildPath, 'node_modules', 'usb')),
			`packaged main process should resolve usb from packaged node_modules, got ${usbEntry}`
		);
		assert.equal(
			typeof usbModule.getDeviceList,
			'function',
			'packaged main process should load usb and its native binding dependencies'
		);

		// serialport — OS-paired Bluetooth Classic serial path
		const serialportEntry = packagedRequire.resolve('serialport');
		assert.ok(
			serialportEntry.startsWith(path.join(buildPath, 'node_modules', 'serialport')),
			`packaged main process should resolve serialport from packaged node_modules, got ${serialportEntry}`
		);
		// Verify @serialport/* namespace was copied alongside serialport
		const serialportNamespacePath = path.join(buildPath, 'node_modules', '@serialport');
		assert.ok(
			fs.existsSync(serialportNamespacePath),
			'packageAfterPrune should copy @serialport namespace for serialport dependencies'
		);
		// Verify the module loads correctly from the packaged copy, including the transitive dep chain
		const { SerialPort } = packagedRequire('serialport') as typeof import('serialport');
		assert.equal(
			typeof SerialPort.list,
			'function',
			'serialport should load with SerialPort.list available'
		);
	} finally {
		fs.rmSync(buildPath, { recursive: true, force: true });
	}
}

main()
	.then(() => {
		console.log('package runtime external assertions passed');
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});

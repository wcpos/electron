import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import webpack from 'webpack';

import forgeConfig, { removeCompiledUsbBuildOnLinux } from '../forge.config';
import pkg from '../package.json';
import { mainConfig } from '../webpack.main.config';

async function main() {
	const buildPath = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'wcpos-package-runtime-'))
	);
	const webpackMainPath = path.join(buildPath, '.webpack', 'main');

	fs.mkdirSync(webpackMainPath, { recursive: true });
	fs.writeFileSync(path.join(webpackMainPath, 'index.js'), '// packaged main entry');

	try {
		assert.equal(
			'node:sqlite' in pkg.dependencies,
			false,
			'SQLite is a Node built-in, not a dependency'
		);
		const probe = path.join(buildPath, 'sqlite-probe.js');
		fs.writeFileSync(probe, "module.exports = require('node:sqlite');");
		const stats = await new Promise<webpack.Stats>((resolve, reject) => {
			const compiler = webpack({
				mode: 'development',
				target: mainConfig.target,
				externals: mainConfig.externals,
				entry: probe,
				output: { path: path.join(buildPath, 'probe-output'), filename: 'main.js' },
			});
			compiler.run((error, result) =>
				compiler.close((closeError) => {
					if (error || closeError) reject(error || closeError);
					else resolve(result);
				})
			);
		});
		assert.equal(stats.hasErrors(), false, stats.toString());
		assert.ok(
			stats
				.toJson({ modules: true })
				.modules.some((module) => module.name === 'external "node:sqlite"'),
			'electron-main leaves node:sqlite external'
		);
		assert.ok('DatabaseSync' in createRequire(probe)('node:sqlite'));

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

		// The allow-list in .github/workflows/dependency-review.yml forgives 15
		// advisories in tar, extract-zip, image-size, zod and webpack-dev-middleware, purely because they are
		// build-time tooling that never reaches the packaged app. Nothing in that
		// workflow can enforce it: it runs only when a manifest or lockfile
		// changes, so a PR that pulls one of them into the runtime via
		// runtimeExternalDependencies would not re-trigger it, and GitHub reports
		// these as runtime scope for pnpm-lock.yaml regardless (see #469).
		//
		// This assertion is where that invariant actually holds — this suite runs
		// on forge.config.ts and src/ changes too.
		for (const buildTimeOnly of ['tar', 'extract-zip', 'image-size', 'zod', 'webpack-dev-middleware']) {
			assert.ok(
				!fs.existsSync(path.join(buildPath, 'node_modules', buildTimeOnly)),
				`${buildTimeOnly} carries allow-listed security advisories and must not ship in the ` +
					'packaged app. If it is genuinely needed at runtime now, remove its advisory ids ' +
					'from allow-ghsas in .github/workflows/dependency-review.yml and fix them instead ' +
					'of shipping known-vulnerable code.'
			);
		}
	} finally {
		fs.rmSync(buildPath, { recursive: true, force: true });
	}

	// Unit, seeded: a plain install has no usb/build, only CI's rebuild:all creates it, so seed one.
	const seededPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wcpos-usb-build-')));
	try {
		const seededUsb = path.join(seededPath, 'node_modules', 'usb');
		const compiledBinding = path.join(seededUsb, 'build', 'Release', 'usb_bindings.node');
		const prebuild = path.join(seededUsb, 'prebuilds', 'linux-x64', 'node.napi.glibc.node');
		fs.mkdirSync(path.dirname(compiledBinding), { recursive: true });
		fs.mkdirSync(path.dirname(prebuild), { recursive: true });
		fs.writeFileSync(compiledBinding, 'compiled');
		fs.writeFileSync(prebuild, 'prebuild');

		for (const otherPlatform of ['darwin', 'win32']) {
			await removeCompiledUsbBuildOnLinux(seededPath, otherPlatform);
			assert.ok(
				fs.existsSync(compiledBinding),
				`the compiled usb binding must be kept on ${otherPlatform}; only Linux drops it`
			);
		}

		await removeCompiledUsbBuildOnLinux(seededPath, 'linux');
		assert.ok(
			!fs.existsSync(path.join(seededUsb, 'build')),
			'Linux package must not ship the CI-compiled usb binding (needs GLIBC_2.38; Debian 12 has 2.36)'
		);
		assert.ok(
			fs.existsSync(prebuild),
			"Linux package must keep usb's N-API prebuild (GLIBC_2.17), which Debian 12 loads instead"
		);
	} finally {
		fs.rmSync(seededPath, { recursive: true, force: true });
	}

	// Hook, linux: the packaged usb must resolve to its prebuild, not build/Release.
	const linuxBuildPath = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'wcpos-package-runtime-linux-'))
	);
	try {
		const linuxWebpackMainPath = path.join(linuxBuildPath, '.webpack', 'main');
		fs.mkdirSync(linuxWebpackMainPath, { recursive: true });
		fs.writeFileSync(path.join(linuxWebpackMainPath, 'index.js'), '// packaged main entry');

		await forgeConfig.hooks.packageAfterPrune(
			forgeConfig as any,
			linuxBuildPath,
			'45.2.3',
			'linux',
			'x64'
		);

		const linuxUsb = path.join(linuxBuildPath, 'node_modules', 'usb');
		assert.ok(
			!fs.existsSync(path.join(linuxUsb, 'build')),
			'Linux package must not ship the CI-compiled usb binding (needs GLIBC_2.38; Debian 12 has 2.36)'
		);
		assert.ok(
			fs.existsSync(path.join(linuxUsb, 'prebuilds', 'linux-x64', 'node.napi.glibc.node')),
			"Linux package must ship usb's linux-x64 N-API prebuild; without it Debian 12 cannot load usb"
		);

		if (process.platform === 'linux' && process.arch === 'x64') {
			const nodeGypBuild = createRequire(path.join(linuxWebpackMainPath, 'index.js'))(
				path.join(linuxBuildPath, 'node_modules', 'node-gyp-build')
			) as { resolve: (dir: string) => string };
			const resolved = nodeGypBuild.resolve(linuxUsb);
			assert.ok(
				resolved.endsWith(path.join('prebuilds', 'linux-x64', 'node.napi.glibc.node')),
				`packaged usb must load its N-API prebuild on Linux so Debian 12 (glibc 2.36) starts, got ${resolved}`
			);
		} else {
			console.log(
				`skipped node-gyp-build resolve check for the Linux package (host is ${process.platform}-${process.arch}, needs linux-x64)`
			);
		}
	} finally {
		fs.rmSync(linuxBuildPath, { recursive: true, force: true });
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

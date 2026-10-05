import assert from 'node:assert/strict';

import {
	detectLinuxPackageFormat,
	LINUX_PACKAGE_NAME,
	PackageFormatProbe,
} from './linux-package-format';

async function main() {
	const existsCalls: string[] = [];
	const rpmCalls: string[] = [];
	const probe: PackageFormatProbe = {
		platform: 'linux',
		env: {},
		exists: (filePath) => {
			existsCalls.push(filePath);
			return false;
		},
		rpmHasPackage: async (name) => {
			rpmCalls.push(name);
			return true;
		},
	};

	assert.equal(LINUX_PACKAGE_NAME, 'woocommerce-pos');
	for (const platform of ['darwin', 'win32'] as const) {
		assert.equal(await detectLinuxPackageFormat({ ...probe, platform }), undefined);
	}
	assert.deepEqual(existsCalls, []);
	assert.deepEqual(rpmCalls, []);

	for (const env of [{ APPIMAGE: '/app.AppImage' }, { FLATPAK_ID: 'com.wcpos.app' }]) {
		assert.equal(await detectLinuxPackageFormat({ ...probe, env }), undefined);
	}
	assert.deepEqual(existsCalls, []);
	assert.deepEqual(rpmCalls, []);

	for (const dpkgFile of [
		'/var/lib/dpkg/info/woocommerce-pos.list',
		'/var/lib/dpkg/info/woocommerce-pos:amd64.list',
	]) {
		assert.equal(
			await detectLinuxPackageFormat({
				...probe,
				exists: (filePath) => filePath === dpkgFile,
			}),
			'deb'
		);
		assert.deepEqual(rpmCalls, []);
	}

	assert.equal(await detectLinuxPackageFormat(probe), 'rpm');
	assert.deepEqual(existsCalls, [
		'/var/lib/dpkg/info/woocommerce-pos.list',
		'/var/lib/dpkg/info/woocommerce-pos:amd64.list',
	]);
	assert.deepEqual(rpmCalls, ['woocommerce-pos']);
	assert.equal(
		await detectLinuxPackageFormat({ ...probe, rpmHasPackage: async () => false }),
		undefined
	);
	assert.equal(
		await detectLinuxPackageFormat({
			...probe,
			rpmHasPackage: async () => {
				throw new Error('rpm failed');
			},
		}),
		undefined
	);
	assert.equal(
		await detectLinuxPackageFormat({
			...probe,
			exists: () => {
				throw new Error('exists failed');
			},
		}),
		undefined
	);
	assert.deepEqual(rpmCalls, ['woocommerce-pos']);

	console.log('linux-package-format.test.ts passed');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

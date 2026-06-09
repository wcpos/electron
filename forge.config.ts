import { rmSync } from 'fs';
import path from 'path';

import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerFlatpak } from '@electron-forge/maker-flatpak';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
// import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { copy, move, pathExists, remove } from 'fs-extra';
// import PublisherGithubLatestYml from 'publisher-github-latest-yml';

import pkg from './package.json';
import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

import type { ForgeConfig } from '@electron-forge/shared-types';

const isOnGithubActions = process.env.CI === 'true';

// Reverse-DNS application id used by the Linux desktop integration (Flatpak / .desktop file).
// Must match the id of the Flathub manifest in `flathub/`. Matches the convention used by the
// other wcpos apps. Keep this in sync if the Flathub app id changes.
const LINUX_APP_ID = 'com.wcpos.main';

const runtimeExternalDependencies = ['usb', 'node-gyp-build'];

async function copyRuntimeExternalDependency(packageName: string, buildPath: string) {
	const sourcePackageJsonPath = require.resolve(`${packageName}/package.json`);
	const sourcePath = path.dirname(sourcePackageJsonPath);
	const destinationPath = path.join(buildPath, 'node_modules', packageName);

	await remove(destinationPath);
	await copy(sourcePath, destinationPath, { dereference: true });
}

const config: ForgeConfig = {
	packagerConfig: {
		name: 'WCPOS',
		executableName: 'WooCommercePOS',
		// Pin the macOS bundle id to the value @electron/packager derived from the previous
		// app name ("WooCommerce POS"). macOS auto-update keys on the bundle id, so this MUST
		// stay fixed across the rename — do not let it follow the new `name`.
		appBundleId: 'com.electron.woocommerce-pos',
		buildVersion: `${pkg.version}`,
		icon: path.resolve(__dirname, 'icons', 'icon'),
		extraResource: [path.resolve(__dirname, 'dist')],
		osxSign: {},
		osxNotarize: isOnGithubActions
			? {
					// tool: 'notarytool',
					appleId: process.env.APPLE_ID || '',
					appleIdPassword: process.env.APPLE_ID_PASSWORD || '',
					teamId: process.env.APPLE_TEAM_ID || '',
				}
			: undefined,
		protocols: [
			{
				name: 'WCPOS',
				schemes: ['wcpos'],
			},
		],
	},
	rebuildConfig: {},
	hooks: {
		packageAfterPrune: async (forgeConfig, buildPath, electronVersion, platform, arch) => {
			const sqliteBuildPath = path.join(buildPath, 'node_modules', 'better-sqlite3', 'build');
			// console.log("Sqlite BuildPath: ", sqliteBuildPath);
			// needs to be deleted otherwise macos codesign will fail
			rmSync(sqliteBuildPath, {
				recursive: true,
				force: true,
			});

			for (const packageName of runtimeExternalDependencies) {
				await copyRuntimeExternalDependency(packageName, buildPath);
			}
		},
		postMake: async (forgeConfig, makeResults) => {
			// Having a space in the name is not allowed on GitHub releases
			for (const result of makeResults) {
				for (const artifactPath of result.artifacts) {
					const parsedPath = path.parse(artifactPath);
					const newBaseName = parsedPath.base.replace(/ /g, '-');
					const newArtifactPath = path.join(parsedPath.dir, newBaseName);

					if (artifactPath !== newArtifactPath) {
						if (await pathExists(newArtifactPath)) {
							console.log(`File already exists at ${newArtifactPath}, removing...`);
							await remove(newArtifactPath);
						}
						await move(artifactPath, newArtifactPath);
					}

					// Update the artifact path in the result object
					result.artifacts = result.artifacts.map((artifact) =>
						artifact === artifactPath ? newArtifactPath : artifact
					);
				}
			}

			return makeResults;
		},
	},
	makers: [
		new MakerSquirrel({
			name: 'WooCommercePOS',
			setupIcon: path.resolve(__dirname, 'icons/icon.ico'),
			loadingGif: path.resolve(__dirname, 'icons/installing.gif'),
		}),
		new MakerZIP({}, ['darwin']),
		new MakerDMG(
			{
				format: 'ULFO',
				icon: path.resolve(__dirname, 'icons/icon.icns'),
			},
			['darwin']
		),
		// .deb for Debian/Ubuntu — https://js.electronforge.io/interfaces/_electron_forge_maker_deb.InternalOptions.MakerDebConfigOptions.html
		new MakerDeb(
			{
				options: {
					// `name` is the package + output-file name (kept as woocommerce-pos);
					// `productName` is the user-facing display name.
					name: 'woocommerce-pos',
					bin: 'WooCommercePOS',
					productName: 'WCPOS',
					genericName: 'Point of Sale',
					maintainer: 'Paul Kilmurray <paul@wcpos.com>',
					homepage: 'https://wcpos.com',
					icon: path.resolve(__dirname, 'icons/icon.png'),
					categories: ['Office', 'Finance'],
					mimeType: ['x-scheme-handler/wcpos'],
				},
			},
			['linux']
		),
		// .rpm for Fedora/RHEL/openSUSE — https://js.electronforge.io/interfaces/_electron_forge_maker_rpm.InternalOptions.MakerRpmConfigOptions.html
		new MakerRpm(
			{
				options: {
					name: 'woocommerce-pos',
					bin: 'WooCommercePOS',
					productName: 'WCPOS',
					genericName: 'Point of Sale',
					homepage: 'https://wcpos.com',
					license: 'MIT',
					icon: path.resolve(__dirname, 'icons/icon.png'),
					categories: ['Office', 'Finance'],
					mimeType: ['x-scheme-handler/wcpos'],
				},
			},
			['linux']
		),
		// Sandboxed Flatpak bundle (also the format published to Flathub) —
		// https://js.electronforge.io/interfaces/_electron_forge_maker_flatpak.MakerFlatpakConfig.html
		new MakerFlatpak(
			{
				options: {
					id: LINUX_APP_ID,
					productName: 'WCPOS',
					genericName: 'Point of Sale',
					// Electron BaseApp + Freedesktop runtime is the recommended pairing for Electron.
					// NOTE: confirm these are still the latest non-EOL branches at release time.
					base: 'org.electronjs.Electron2.BaseApp',
					baseVersion: '24.08',
					runtime: 'org.freedesktop.Platform',
					runtimeVersion: '24.08',
					sdk: 'org.freedesktop.Sdk',
					icon: path.resolve(__dirname, 'icons/icon.png'),
					categories: ['Office', 'Finance'],
					mimeType: ['x-scheme-handler/wcpos'],
					// Sandbox permissions. --device=all is required for raw USB receipt printers /
					// cash drawers (the `usb` native module); --share=network covers TCP/ESC-POS
					// network printers and sync. Keep this in sync with the Flathub manifest.
					finishArgs: [
						'--share=ipc',
						'--share=network',
						'--socket=x11',
						'--socket=fallback-x11',
						'--socket=wayland',
						'--socket=pulseaudio',
						'--device=dri',
						'--device=all',
						'--talk-name=org.freedesktop.Notifications',
						'--env=ELECTRON_TRASH=gio',
					],
				},
			},
			['linux']
		),
	],
	publishers: [
		new PublisherGithub({
			// https://js.electronforge.io/modules/_electron_forge_publisher_github.html
			repository: {
				owner: 'wcpos',
				name: 'electron',
			},
		}),
		// new PublisherGithubLatestYml({
		// 	repository: {
		// 		owner: 'wcpos',
		// 		name: 'electron',
		// 	},
		// }),
	],
	plugins: [
		// new AutoUnpackNativesPlugin({}),
		new WebpackPlugin({
			mainConfig,
			// devContentSecurityPolicy: "connect-src 'self' * 'unsafe-eval'",
			renderer: {
				config: rendererConfig,
				entryPoints: [
					{
						html: './src/index.html',
						js: './src/renderer.ts',
						name: 'main_window',
						preload: {
							js: './src/preload.ts',
						},
					},
				],
			},
		}),
	],
};

export default config;

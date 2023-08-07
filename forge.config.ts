import fs from 'fs';
import path from 'path';

import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
// import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { PublisherGithub } from '@electron-forge/publisher-github';
import MakerAppImage from 'electron-forge-maker-appimage';

import pkg from './package.json';
import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

import type { ForgeConfig } from '@electron-forge/shared-types';

const isOnGithubActions = process.env.CI === 'true';

const config: ForgeConfig = {
	packagerConfig: {
		name: 'WooCommerce POS',
		executableName: 'WooCommercePOS',
		buildVersion: `${pkg.version}`,
		icon: path.resolve(__dirname, 'icons', 'icon'),
		extraResource: [path.resolve(__dirname, 'dist')],
		osxSign: {},
		osxNotarize: isOnGithubActions
			? {
					tool: 'notarytool',
					appleId: process.env.APPLE_ID,
					appleIdPassword: process.env.APPLE_ID_PASSWORD,
					teamId: process.env.APPLE_TEAM_ID,
			  }
			: undefined,
		protocols: [
			{
				name: 'WooCommerce POS',
				schemes: ['wcpos'],
			},
		],
	},
	rebuildConfig: {},
	hooks: {
		packageAfterPrune: async (forgeConfig, buildPath) => {
			const sqliteBuildPath = path.join(buildPath, 'node_modules', 'better-sqlite3', 'build');
			// console.log("Sqlite BuildPath: ", sqliteBuildPath);
			// needs to be deleted otherwise macos codesign will fail
			fs.rmSync(sqliteBuildPath, {
				recursive: true,
				force: true,
			});
		},
	},
	makers: [
		new MakerSquirrel({
			name: 'WooCommercePOS',
			setupIcon: path.resolve(__dirname, 'icons/icon.ico'),
			loadingGif: path.resolve(__dirname, 'icons/installing.gif'),
		}),
		new MakerZIP({}, ['darwin', 'linux']),
		new MakerDMG(
			{
				format: 'ULFO',
				icon: path.resolve(__dirname, 'icons/icon.icns'),
			},
			['darwin']
		),
		new MakerRpm({
			// https://js.electronforge.io/interfaces/_electron_forge_maker_rpm.InternalOptions.MakerRpmConfigOptions.html
			options: { bin: 'WooCommercePOS' },
		}),
		new MakerDeb({
			// https://js.electronforge.io/interfaces/_electron_forge_maker_deb.InternalOptions.MakerDebConfigOptions.html
			options: { bin: 'WooCommercePOS' },
		}),
		new MakerAppImage({}, ['linux']),
	],
	publishers: [
		new PublisherGithub({
			// https://js.electronforge.io/modules/_electron_forge_publisher_github.html
			repository: {
				owner: 'wcpos',
				name: 'electron',
			},
			draft: true,
		}),
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

import fs from 'fs';
import path from 'path';

import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

import type { ForgeConfig } from '@electron-forge/shared-types';

const config: ForgeConfig = {
	packagerConfig: {
		asar: true,
		executableName: 'woocommerce-pos',
		icon: path.resolve(__dirname, 'icons', 'icon'),
		osxSign: {
			// "hardened-runtime": true,
			// "gatekeeper-assess": false,
		},
		osxNotarize: {
			tool: 'notarytool',
			appleId: process.env.APPLE_ID,
			appleIdPassword: process.env.APPLE_ID_PASSWORD,
			teamId: process.env.APPLE_TEAM_ID,
		},
	},
	rebuildConfig: {},
	hooks: {
		packageAfterPrune: async (forgeConfig, buildPath) => {
			const sqliteBuildPath = path.join(buildPath, 'node_modules', 'sqlite3', 'build');
			// console.log("Sqlite BuildPath: ", sqliteBuildPath);
			// needs to be deleted otherwise macos codesign will fail
			fs.rmSync(sqliteBuildPath, {
				recursive: true,
				force: true,
			});
		},
	},
	makers: [new MakerSquirrel({}), new MakerZIP({}, ['darwin']), new MakerRpm({}), new MakerDeb({})],
	publishers: [
		{
			name: '@wcpos/app-electron',
			config: {
				repository: {
					owner: 'wcpos',
					name: 'electron',
				},
				draft: true,
			},
		},
	],
	plugins: [
		new AutoUnpackNativesPlugin({}),
		new WebpackPlugin({
			mainConfig,
			devContentSecurityPolicy: "connect-src 'self' * 'unsafe-eval'",
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

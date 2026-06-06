import { rules } from './webpack.rules';

import type { WebpackConfiguration } from '@electron-forge/plugin-webpack/dist/Config';

export const mainConfig: WebpackConfiguration = {
	stats: 'errors-only',
	/**
	 * This is the main entry point for your application, it's the first file
	 * that runs in the main process.
	 */
	entry: './src/index.ts',
	// Put your normal webpack config below here
	module: {
		rules,
	},
	resolve: {
		extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
	},
	target: 'electron-main',
	// `usb` loads its native binding via `node-gyp-build(join(__dirname, '..', '..'))`.
	// When webpack bundles it, `__dirname` becomes `.webpack/main`, so node-gyp-build
	// resolves to `apps/electron/` (no `prebuilds`/`build/Release`) and throws
	// "No native build was found ... webpack=true". The @vercel asset-relocator can't
	// statically follow the `NODE_USB_PATH ||` dynamic path, so it emits nothing for it.
	// Externalizing `usb` keeps it a runtime `require('usb')` resolved from node_modules,
	// where node-gyp-build finds the electron-rebuilt build/Release/usb_bindings.node.
	externals: ['aws-sdk', 'mock-aws-s3', 'nock', 'usb'],
};

import { sentryWebpackPlugin } from '@sentry/webpack-plugin';

import pkg from './package.json';
import { rules } from './webpack.rules';

import type { WebpackConfiguration } from '@electron-forge/plugin-webpack/dist/Config';

// Main-process source maps for Sentry. Without a token every production stack
// frame is `index.js:2:1953030` (what all 1.10.x reports look like). The publish
// steps of .github/workflows/tag-and-release.yml supply SENTRY_AUTH_TOKEN; then
// the maps are generated hidden (no sourceMappingURL comment), uploaded under
// the same release name src/main/log.ts pins, and deleted before packaging so
// they never ship. Any other build — dev, the CI smoke package — is unchanged.
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN;

export const mainConfig: WebpackConfiguration = {
	stats: 'errors-only',
	...(SENTRY_AUTH_TOKEN ? { devtool: 'hidden-source-map' } : {}),
	plugins: SENTRY_AUTH_TOKEN
		? [
				sentryWebpackPlugin({
					authToken: SENTRY_AUTH_TOKEN,
					org: 'wcpos',
					project: 'woocommerce-pos',
					release: { name: `WCPOS@${pkg.version}` },
					sourcemaps: { filesToDeleteAfterUpload: ['.webpack/main/**/*.map'] },
					telemetry: false,
				}),
			]
		: [],
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
	externals: ['aws-sdk', 'mock-aws-s3', 'nock', 'serialport', 'usb'],
};

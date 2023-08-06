import nodeExternals from 'webpack-node-externals';

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
	// externals: [
	// 	nodeExternals({
	// 		allowlist: ['@sentry/electron', 'aws-sdk', 'mock-aws-s3', 'nock'],
	// 	}),
	// ],
};

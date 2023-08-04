import nodeExternals from 'webpack-node-externals';

import { rules } from './webpack.rules';

import type { WebpackConfiguration } from '@electron-forge/plugin-webpack/dist/Config';

export const rendererConfig: WebpackConfiguration = {
	module: {
		rules,
	},
	resolve: {
		extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
	},
	target: 'electron-renderer',
	externals: [nodeExternals(), 'aws-sdk', 'mock-aws-s3', 'nock'],
};

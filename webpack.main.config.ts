import { rules } from './webpack.rules';

import type { Configuration } from 'webpack';

export const mainConfig: Configuration = {
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
};

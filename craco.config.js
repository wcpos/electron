const webpack = require('webpack');

module.exports = {
	webpack: {
		configure: (webpackConfig) => {

			return webpackConfig;
		},
		plugins: [
			// Inject the "__DEV__" global variable.
			new webpack.DefinePlugin({
				__DEV__: process.env.NODE_ENV !== 'production',
			}),
			// Inject the "__SUBPLATFORM__" global variable.
			// It can be used to determine whether we're running within Electron or not.
			new webpack.DefinePlugin({
				__SUBPLATFORM__: JSON.stringify('electron'),
			}),
		],
	},
};
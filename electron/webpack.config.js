const { withExpoWebpack } = require('@expo/electron-adapter');

module.exports = (_config) => {
	const config = withExpoWebpack(_config);

	console.log(config);

	const WatchFilterPlugin = config.plugins[5];
	const originalFilter = WatchFilterPlugin.filter;
	WatchFilterPlugin.filter = (file) => {
		return true;
	};

	return config;
};

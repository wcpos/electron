const { withExpoWebpack } = require('@expo/electron-adapter');

module.exports = (_config) => {
	const config = withExpoWebpack(_config);
	console.log(config);

	return config;
};

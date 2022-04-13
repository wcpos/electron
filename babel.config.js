module.exports = function (api) {
	api.cache(true);
	return {
		presets: ['@wcpos/babel-preset-expo'],
	};
};

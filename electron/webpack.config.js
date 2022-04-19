const { withExpoWebpack } = require('@expo/electron-adapter');

module.exports = (_config) => {
	const config = withExpoWebpack(_config);


	// Remove existing rules about SVG and inject our own
	// (Inspired by https://github.com/storybookjs/storybook/issues/6758#issuecomment-495598635)
	config.module.rules = config.module.rules.map((rule) => {
		if (rule.test && rule.test.toString().includes('svg')) {
			hasModified = true;

			// const test = rule.test.toString().replace('|svg', '');

			return { ...rule, test: /\.(png|jpe?g|gif)(\\?.*)?$/ };
		}
		return rule;
	});
	
	// Add new rule to use svgr
	// Place at the beginning so that the default loader doesn't catch it
	// https://github.com/facebook/create-react-app/blob/main/packages/react-scripts/config/webpack.config.js#L389
	config.module.rules.unshift({
		test: /\.svg$/,
		use: [
			{
				loader: require.resolve('@svgr/webpack'),
				options: {
					prettier: false,
					svgo: false,
					svgoConfig: {
						plugins: [{ removeViewBox: false }],
					},
					titleProp: true,
					ref: true,
				},
			},
			{
				loader: require.resolve('file-loader'),
				options: {
					name: 'static/media/[name].[hash].[ext]',
				},
			},
		],
		issuer: {
			and: [/\.(ts|tsx|js|jsx|md|mdx)$/],
		},
	});

	console.log(config.module.rules);

	return config;
};

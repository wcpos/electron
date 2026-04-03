import { config } from '@wcpos/eslint-config';
export default [
	...config,
	{
		// rxdb-premium is a private package installed via auth token — not
		// available in standalone CI where the electron repo is checked out alone.
		settings: {
			'import/ignore': ['rxdb-premium'],
		},
		rules: {
			'import/no-unresolved': ['error', { ignore: ['^rxdb-premium'] }],
		},
	},
];
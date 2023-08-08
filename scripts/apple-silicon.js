const { api } = require('@electron-forge/core');

const main = async () => {
	await api.package({
		arch: 'arm64',
		platform: 'darwin',
	});
};

main();

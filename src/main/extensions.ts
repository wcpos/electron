import { installExtension, REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';
const isDebug = process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

// if (isDebug) {
// 	require('electron-debug')();
// }

export const installExtensions = async () => {
	if (!isDebug) {
		return;
	}
	// const forceDownload = !!process.env.UPGRADE_EXTENSIONS;

	return installExtension([REACT_DEVELOPER_TOOLS])
		.then(([react]) => console.log(`Added Extensions: ${react.name}`))
		.catch((err) => console.log('An error occurred: ', err));
};

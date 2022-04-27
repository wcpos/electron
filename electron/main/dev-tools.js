// import installExtension, { REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';
import { app } from 'electron';
import { isDevelopment } from './utils';

app.whenReady().then(() => {
	if (isDevelopment) {
		const installExtension = require('electron-devtools-installer');
		installExtension(installExtension.REACT_DEVELOPER_TOOLS)
			.then((name) => console.log(`Added Extension:  ${name}`))
			.catch((err) => console.log('An error occurred: ', err));
	}
});

// import { showSettings } from '../config/window'
// import { openProject } from '../project/handlers'
import { isWindows } from '../utils';

export const baseFileMenu = {
	label: 'File',
	submenu: [
		// {
		//   label: 'Open…',
		//   accelerator: 'CommandOrControl+o',
		//   click: () => {
		//     openProject().catch((err) => {
		//       console.error('Could not open project\n', err)
		//     })
		//   },
		// },
		// { type: 'separator' },
		{
			role: 'close',
			accelerator: isWindows ? 'Alt+F4' : 'CommandOrControl+w',
		},
		{ type: 'separator' },
		// {
		//   label: 'Preferences…',
		//   accelerator: 'CommandOrControl+,',
		//   click: () => {
		//     showSettings()
		//   },
		// },
		{ type: 'separator' },
		{ role: 'quit' },
	],
};

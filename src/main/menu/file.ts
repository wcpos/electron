// import { showSettings } from '../config/window'
// import { openProject } from '../project/handlers'
import { MenuItemConstructorOptions } from 'electron';

import { t } from '../translations';
import { isWindows } from '../util';

export const baseFileMenu: MenuItemConstructorOptions = {
	label: t('File', { _tags: 'electron' }),
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

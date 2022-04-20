// import { showSettings } from '../config/window';
import { checkForUpdates } from '../update';
import { isMac } from '../utils';

export const baseAppMenu = isMac
	? [
			{
				label: 'WCPOS',
				submenu: [
					{ role: 'about' },
					{ label: 'Check For Updates…', click: checkForUpdates },
					// { type: 'separator' },
					// {
					// 	label: 'Preferences…',
					// 	accelerator: 'CommandOrControl+,',
					// 	click: () => {
					// 		showSettings();
					// 	},
					// },
					{ type: 'separator' },
					{ role: 'services' },
					{ type: 'separator' },
					{ role: 'hide' },
					{ role: 'hideOthers' },
					{ role: 'unhide' },
					{ type: 'separator' },
					{ role: 'quit' },
				],
			},
	  ]
	: [];

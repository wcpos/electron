// import { showSettings } from '../config/window';
import { MenuItemConstructorOptions } from 'electron';
import { checkForUpdates } from '../update';
import { isMac } from '../util';

export const baseAppMenu: MenuItemConstructorOptions[] = isMac
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

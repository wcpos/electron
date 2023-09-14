// import { showSettings } from '../config/window';
import { MenuItemConstructorOptions, MenuItem } from 'electron';

import { t } from '../translations';
import { updater } from '../update';
import { isMac } from '../util';

export const baseAppMenu: MenuItemConstructorOptions[] = isMac
	? [
			{
				label: 'WCPOS',
				submenu: [
					{ role: 'about' },
					{
						label: t('Check for Updates', { _tags: 'electron' }) + '…',
						click: (menuItem: MenuItem) => updater.manualCheckForUpdates(menuItem),
					},
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

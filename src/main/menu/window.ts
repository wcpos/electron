// import { openLauncherWindow } from '../launcher/window'
// import { showLogs } from '../logging/window'
import { MenuItemConstructorOptions } from 'electron';

import { clearAppDataDialog } from '../clear-data';
import { config, setHardwareAcceleration } from '../config';
import { t } from '../translations';
import { isMac } from '../util';

export const baseWindowSubMenu: MenuItemConstructorOptions[] = [
	{ role: 'minimize' },
	{ role: 'zoom' },
	{ type: 'separator' },
	// {
	//   label: 'Launcher',
	//   accelerator: 'Shift+CommandOrControl+1',
	//   click: () => {
	//     openLauncherWindow()
	//   },
	// },
	...(isMac
		? ([
				{ type: 'separator' },
				{ role: 'front' },
				{ type: 'separator' },
				{ role: 'window' },
			] as MenuItemConstructorOptions[])
		: []),
	{ type: 'separator' } as MenuItemConstructorOptions,
	{
		label: t('menu.advanced'),
		submenu: [
			// {
			//   label: 'Debug Logs',
			//   click: () => {
			//     showLogs()
			//   },
			// },
			// { type: 'separator' },
			{ role: 'reload' },
			{ role: 'forceReload' },
			{ role: 'toggleDevTools' },
			{
				label: t('menu.performance'),
				submenu: [
					{
						label: t('menu.enable_hardware_acceleration'),
						type: 'checkbox',
						checked: config.hardwareAcceleration,
						click: (menuItem) => {
							setHardwareAcceleration(!config.hardwareAcceleration);
						},
					},
				],
			},
			{
				label: t('menu.clear_app_data'),
				click: () => clearAppDataDialog(),
			},
		],
	},
];

export const baseWindowMenu: MenuItemConstructorOptions = {
	label: 'Window',
	submenu: baseWindowSubMenu,
};

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
		? [{ type: 'separator' }, { role: 'front' }, { type: 'separator' }, { role: 'window' }]
		: []),
	{ type: 'separator' },
	{
		label: t('Advanced', { _tags: 'electron' }),
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
				label: t('Performance', { _tags: 'electron' }),
				submenu: [
					{
						label: t('Enable Hardware Acceleration', { _tags: 'electron' }),
						type: 'checkbox',
						checked: config.hardwareAcceleration,
						click: (menuItem) => {
							setHardwareAcceleration(!config.hardwareAcceleration);
						},
					},
				],
			},
			{
				label: t('Clear App Data', { _tags: 'electron' }),
				click: () => clearAppDataDialog(),
			},
		],
	},
];

export const baseWindowMenu: MenuItemConstructorOptions = {
	label: 'Window',
	submenu: baseWindowSubMenu,
};

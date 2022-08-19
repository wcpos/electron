// import { openLauncherWindow } from '../launcher/window'
// import { showLogs } from '../logging/window'
import { MenuItemConstructorOptions } from 'electron';
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
		label: 'Advanced',
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
		],
	},
];

export const baseWindowMenu: MenuItemConstructorOptions = {
	label: 'Window',
	submenu: baseWindowSubMenu,
};

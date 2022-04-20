// import { openLauncherWindow } from '../launcher/window'
// import { showLogs } from '../logging/window'
import { isMac } from '../utils';

export const baseWindowSubMenu = [
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

export const baseWindowMenu = {
	label: 'Window',
	submenu: baseWindowSubMenu,
};

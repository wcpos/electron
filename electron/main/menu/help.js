// import { openOnboardingWindow } from '../onboarding/window';
import { checkForUpdates } from '../update';
import { isMac, isWindows } from '../utils';

export const baseHelpMenu = {
	role: 'help',
	submenu: [
		// {
		// 	label: isMac ? 'Stencila Help' : 'Help Center',
		// 	click: async (): Promise<void> => {
		// 		const { shell } = await import('electron');
		// 		await shell.openExternal('http://help.stenci.la');
		// 	},
		// },
		// { type: 'separator' },
		{
			label: 'Report an Issue…',
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://github.com/wcpos/electron/issues/new');
			},
		},
		{
			label: 'Request a Feature…',
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://github.com/wcpos/electron/discussions/new');
			},
		},
		{ type: 'separator' },
		...(isMac || isWindows
			? [
					{
						label: 'Check for Updates…',
						click: () => {
							checkForUpdates();
						},
					},
			  ]
			: []),
		// {
		// 	label: 'Setup…',
		// 	click: openOnboardingWindow,
		// },
		{ type: 'separator' },
		{
			label: 'Documentation',
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://docs.wcpos.com');
			},
		},
		{
			label: 'F.A.Q.',
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://faq.wcpos.com');
			},
		},
	],
};

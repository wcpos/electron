// import { openOnboardingWindow } from '../onboarding/window';
import { MenuItemConstructorOptions } from 'electron';

import { t } from '../translations';
import { manualCheckForUpdates } from '../update';
import { isMac, isWindows } from '../util';

export const baseHelpMenu: MenuItemConstructorOptions = {
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
			label: t('Report an Issue', { _tags: 'electron' }) + '…',
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://github.com/wcpos/electron/issues/new');
			},
		},
		{
			label: t('Request a Feature', { _tags: 'electron' }) + '…',
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://github.com/wcpos/electron/discussions/new');
			},
		},
		{ type: 'separator' },
		...(isMac || isWindows
			? [
					{
						label: t('Check for Updates', { _tags: 'electron' }) + '…',
						click: manualCheckForUpdates,
					},
			  ]
			: []),
		// {
		// 	label: 'Setup…',
		// 	click: openOnboardingWindow,
		// },
		{ type: 'separator' },
		{
			label: t('Documentation', { _tags: 'electron' }),
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://docs.wcpos.com');
			},
		},
		{
			label: t('F.A.Q.', { _tags: 'electron' }),
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://faq.wcpos.com');
			},
		},
	],
};

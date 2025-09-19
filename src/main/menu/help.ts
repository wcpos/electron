// import { openOnboardingWindow } from '../onboarding/window';
import { MenuItem, MenuItemConstructorOptions } from 'electron';

import { t } from '../translations';
import { updater } from '../update';
import { isMac } from '../util';

export const baseHelpMenu: MenuItemConstructorOptions = {
	role: 'help',
	submenu: [
		...(!isMac ? [{ role: 'about' }, { type: 'separator' }] : []),
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
		{
			label: t('Check for Updates', { _tags: 'electron' }) + '…',
			click: (menuItem: MenuItem) => updater.manualCheckForUpdates(menuItem),
		},
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

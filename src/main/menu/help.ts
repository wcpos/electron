// import { openOnboardingWindow } from '../onboarding/window';
import { MenuItem, MenuItemConstructorOptions } from 'electron';

import { t } from '../translations';
import { updater } from '../update';
import { isMac } from '../util';

export const baseHelpMenu: MenuItemConstructorOptions = {
	role: 'help',
	submenu: [
		...(!isMac
			? [
					{ role: 'about' } as MenuItemConstructorOptions,
					{ type: 'separator' } as MenuItemConstructorOptions,
				]
			: []),
		{
			label: t('menu.report_an_issue') + '…',
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://github.com/wcpos/electron/issues/new');
			},
		},
		{
			label: t('menu.request_a_feature') + '…',
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://github.com/wcpos/electron/discussions/new');
			},
		},
		{ type: 'separator' },
		{
			label: t('menu.check_for_updates') + '…',
			click: (menuItem: MenuItem) => updater.manualCheckForUpdates(menuItem),
		},
		// {
		// 	label: 'Setup…',
		// 	click: openOnboardingWindow,
		// },
		{ type: 'separator' },
		{
			label: t('menu.documentation'),
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://docs.wcpos.com');
			},
		},
		{
			label: t('menu.f_a_q'),
			click: async () => {
				const { shell } = await import('electron');
				await shell.openExternal('https://faq.wcpos.com');
			},
		},
	],
};

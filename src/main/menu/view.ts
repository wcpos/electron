import { MenuItemConstructorOptions } from 'electron';

import { t } from '../translations';

export const baseViewMenu: MenuItemConstructorOptions = {
	label: t('menu.view'),
	submenu: [
		{ role: 'resetZoom' },
		{ role: 'zoomIn' },
		{ role: 'zoomOut' },
		{ type: 'separator' },
		{ role: 'togglefullscreen' },
	],
};

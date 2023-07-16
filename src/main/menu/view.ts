import { MenuItemConstructorOptions } from 'electron';

import { t } from '../translations';

export const baseViewMenu: MenuItemConstructorOptions = {
	label: t('View', { _tags: 'electron' }),
	submenu: [
		{ role: 'resetZoom' },
		{ role: 'zoomIn' },
		{ role: 'zoomOut' },
		{ type: 'separator' },
		{ role: 'togglefullscreen' },
	],
};

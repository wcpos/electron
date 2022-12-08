import { tx, t } from '@transifex/native';
import { app } from 'electron';

import log from './log';

tx.init({
	token: '1/53ff5ea9a168aa4e7b8a72157b83537886a51938',
	filterTags: 'electron',
});

/**
 *
 */
app.whenReady().then(() => {
	const systemLocale = app.getSystemLocale();
	log.debug(`System locale: ${systemLocale}`);
	tx.setCurrentLocale('es')
		.then(() => {
			log.silly('es translations loaded');
		})
		.then(() => {
			log.silly(t('Menu'));
		})
		.catch((err) => {
			log.error(err);
		});
});

export { tx, t };

import { tx, t } from '@transifex/native';
import { app } from 'electron';
import Store from 'electron-store';

import log from '../log';
import CustomCache from './cache';
import locales from './locales';

const store = new Store();

tx.init({
	token: '1/53ff5ea9a168aa4e7b8a72157b83537886a51938',
	filterTags: 'electron',
	cache: new CustomCache(store),
});

/**
 * A little map function to convert system locales to Transifex locales
 */
const getLocaleFromCode = (code: string) => {
	let lang = locales[code.toLowerCase()];

	// try the country code only, eg: es-ar -> es
	if (!lang) {
		lang = locales[code.split('-')[0]];
	}

	// default to english
	if (!lang) {
		lang = locales['en'];
	}

	return lang.locale;
};

/**
 *
 */
export const loadTranslations = () => {
	const systemLocales = app.getPreferredSystemLanguages();
	const systemLocale = getLocaleFromCode(systemLocales[0]);
	log.debug(`System locale: ${systemLocale}`);

	const cachedTranslations = store.get(systemLocale);
	if (cachedTranslations) {
		log.debug(`Loading ${systemLocale} translations from cache`);
		tx.cache.update(systemLocale, cachedTranslations, true);
	}

	return tx.setCurrentLocale(systemLocale).catch((err) => {
		log.error(err);
	});
};

export { tx, t };

import { tx, t } from '@transifex/native';
import { app } from 'electron';
import Store from 'electron-store';

import CustomCache from './cache';
import locales from './locales';
import log from '../log';

const store = new Store();

tx.init({
	token: '1/09853773ef9cda3be96c8c451857172f26927c0f',
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

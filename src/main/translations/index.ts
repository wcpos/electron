import { t, tx } from '@transifex/native';
import { app } from 'electron';
import Store from 'electron-store';

import CustomCache from './cache';
import locales from './locales.json';
import log from '../log';

type TranslationRecord = Record<string, string>;
type LocaleInfo = {
	name: string;
	nativeName?: string;
	native?: string;
	code: string;
	locale: string;
};

const store = new Store<Record<string, TranslationRecord>>();
const cache = new CustomCache(store);

tx.init({
	token: '1/09853773ef9cda3be96c8c451857172f26927c0f',
	filterTags: 'electron',
	cache: cache as unknown as typeof tx.cache,
});

/**
 * A little map function to convert system locales to Transifex locales
 */
const getLocaleFromCode = (code: string): string => {
	const localesMap = locales as unknown as Record<string, LocaleInfo>;
	let lang = localesMap[code.toLowerCase()];

	// try the country code only, eg: es-ar -> es
	if (!lang) {
		lang = localesMap[code.split('-')[0]];
	}

	// default to english
	if (!lang) {
		lang = localesMap['en'];
	}

	return lang.locale;
};

/**
 *
 */
export const loadTranslations = async () => {
	const systemLocales = app.getPreferredSystemLanguages();
	const systemLocale = getLocaleFromCode(systemLocales[0]);
	log.debug(`System locale: ${systemLocale}`);

	const cachedTranslations = store.get(systemLocale);
	if (cachedTranslations) {
		log.debug(`Loading ${systemLocale} translations from cache`);
		cache.update(systemLocale, cachedTranslations, true);
	}

	return tx.setCurrentLocale(systemLocale).catch((err) => {
		log.error(err);
	});
};

export { tx, t };

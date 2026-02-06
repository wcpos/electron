import { createInstance } from 'i18next';
import { app } from 'electron';
import Store from 'electron-store';

import locales from './locales.json';
import en from './locales/en/electron.json';
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
const TRANSLATION_VERSION = '2026.2.0';

/**
 * Custom i18next backend that loads translations from jsDelivr CDN
 * and caches them in electron-store.
 */
class ElectronStoreBackend {
	static type = 'backend' as const;
	type = 'backend' as const;

	private store: Store<Record<string, TranslationRecord>>;
	private services: any;

	init(services: any, backendOptions: any) {
		this.services = services;
		this.store = backendOptions.store;
	}

	private buildUrl(language: string, namespace: string): string {
		return `https://cdn.jsdelivr.net/gh/wcpos/translations@${TRANSLATION_VERSION}/translations/js/${language}/monorepo/${namespace}.json`;
	}

	private getBaseLanguage(language: string): string | null {
		const parts = language.split('_');
		return parts.length > 1 ? parts[0].toLowerCase() : null;
	}

	private fetchTranslations(language: string, namespace: string): Promise<TranslationRecord | null> {
		const url = this.buildUrl(language, namespace);
		return fetch(url).then((response) => {
			if (!response.ok) return null;
			return response.json();
		});
	}

	read(language: string, namespace: string, callback: (err: any, data?: any) => void) {
		const cached = this.store.get(language) as TranslationRecord | undefined;
		if (cached) {
			log.debug(`Loading ${language} translations from cache`);
			callback(null, cached);
			return;
		}

		// Try the exact locale first, then fall back to base language (e.g. fr_CA -> fr)
		this.fetchTranslations(language, namespace)
			.then((data) => {
				if (data && Object.keys(data).length > 0) {
					this.store.set(language, data);
					callback(null, data);
					return;
				}

				// Regional locale not found, try base language
				const baseLang = this.getBaseLanguage(language);
				if (!baseLang) {
					callback(null, {});
					return;
				}

				log.debug(`Falling back from ${language} to ${baseLang}`);
				return this.fetchTranslations(baseLang, namespace).then((fallbackData) => {
					if (fallbackData && Object.keys(fallbackData).length > 0) {
						this.store.set(language, fallbackData);
						callback(null, fallbackData);
					} else {
						callback(null, {});
					}
				});
			})
			.catch((err) => {
				log.error(`Failed to fetch translations: ${err.message}`);
				callback(null, {});
			});
	}
}

/**
 * Map system locale codes to Transifex-compatible locale codes.
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

const i18nInstance = createInstance();
i18nInstance.use(ElectronStoreBackend).init({
	lng: 'en',
	fallbackLng: 'en',
	load: 'currentOnly',
	ns: ['electron'],
	defaultNS: 'electron',
	resources: {
		en: { electron: en },
	},
	keySeparator: false,
	nsSeparator: false,
	interpolation: {
		escapeValue: false,
		prefix: '{',
		suffix: '}',
	},
	backend: {
		store,
	},
});

export const loadTranslations = async () => {
	const systemLocales = app.getPreferredSystemLanguages();
	const systemLocale = getLocaleFromCode(systemLocales[0]);
	log.debug(`System locale: ${systemLocale}`);

	await i18nInstance.changeLanguage(systemLocale);
};

export const t = i18nInstance.t.bind(i18nInstance);

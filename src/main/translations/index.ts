import i18next from 'i18next';
import { app } from 'electron';
import Store from 'electron-store';

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
const TRANSLATION_VERSION = '1.7.8';

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

	read(language: string, namespace: string, callback: (err: any, data?: any) => void) {
		const cached = this.store.get(language) as TranslationRecord | undefined;
		if (cached) {
			log.debug(`Loading ${language} translations from cache`);
			callback(null, cached);
		} else {
			callback(null);
		}

		// Fetch fresh translations from jsDelivr in the background
		const url = `https://cdn.jsdelivr.net/gh/wcpos/translations@v${TRANSLATION_VERSION}/translations/js/${language}/${namespace}.json`;
		fetch(url)
			.then((response) => {
				if (!response.ok) return;
				return response.json();
			})
			.then((data) => {
				if (data && Object.keys(data).length > 0) {
					const current = this.store.get(language) as TranslationRecord | undefined;
					if (JSON.stringify(current) !== JSON.stringify(data)) {
						this.store.set(language, data);
					}
					this.services.resourceStore.addResourceBundle(language, namespace, data, true, true);
				}
			})
			.catch((err) => {
				log.error(`Failed to fetch translations: ${err.message}`);
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

const i18nInstance = i18next.createInstance();
i18nInstance.use(ElectronStoreBackend).init({
	lng: 'en',
	fallbackLng: false,
	ns: ['electron'],
	defaultNS: 'electron',
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

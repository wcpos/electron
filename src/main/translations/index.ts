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
const TRANSLATION_VERSION = '2026.2.2';

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
		return `https://cdn.jsdelivr.net/gh/wcpos/translations@${TRANSLATION_VERSION}/translations/js/${language}/electron/${namespace}.json`;
	}

	private getBaseLanguage(language: string): string | null {
		const parts = language.split('_');
		return parts.length > 1 ? parts[0].toLowerCase() : null;
	}

	private fetchTranslations(
		language: string,
		namespace: string
	): Promise<TranslationRecord | null> {
		const url = this.buildUrl(language, namespace);
		return fetch(url).then((response) => {
			if (!response.ok) return null;
			return response.json();
		});
	}

	read(language: string, namespace: string, callback: (err: any, data?: any) => void) {
		log.debug(`[translations] read called: language=${language}, namespace=${namespace}`);
		const cacheKey = `${TRANSLATION_VERSION}:${language}`;
		const cached = this.store.get(cacheKey) as TranslationRecord | undefined;
		if (cached) {
			log.debug(`[translations] Returning cached translations: language=${language}`);
			callback(null, cached);
			return;
		}

		// Try the exact locale first, then fall back to base language (e.g. fr_CA -> fr)
		const url = this.buildUrl(language, namespace);
		log.debug(`[translations] Fetching translations: language=${language}, url=${url}`);

		this.fetchTranslations(language, namespace)
			.then((data) => {
				log.debug(`[translations] Fetch result: language=${language}, keyCount=${data ? Object.keys(data).length : 0}`);
				if (data && Object.keys(data).length > 0) {
					this.store.set(cacheKey, data);
					callback(null, data);
					return;
				}

				// Regional locale not found, try base language
				const baseLang = this.getBaseLanguage(language);
				if (!baseLang) {
					log.debug(`[translations] No base language fallback available: language=${language}`);
					callback(null, {});
					return;
				}

				const fallbackUrl = this.buildUrl(baseLang, namespace);
				log.debug(`[translations] Trying base language fallback: from=${language}, to=${baseLang}, url=${fallbackUrl}`);
				return this.fetchTranslations(baseLang, namespace).then((fallbackData) => {
					log.debug(`[translations] Fallback result: baseLang=${baseLang}, keyCount=${fallbackData ? Object.keys(fallbackData).length : 0}`);
					if (fallbackData && Object.keys(fallbackData).length > 0) {
						this.store.set(cacheKey, fallbackData);
						callback(null, fallbackData);
					} else {
						callback(null, {});
					}
				});
			})
			.catch((err) => {
				log.error(`[translations] Fetch failed: language=${language}, error=${err.message}`);
				callback(null, {});
			});
	}
}

/**
 * Map system locale codes to supported translation locale codes.
 */
const getLocaleFromCode = (code: string): string => {
	log.debug(`[translations] getLocaleFromCode called: code=${code}`);
	const localesMap = locales as unknown as Record<string, LocaleInfo>;
	let lang = localesMap[code.toLowerCase()];
	log.debug(`[translations] Exact match for '${code.toLowerCase()}': ${lang ? lang.locale : 'none'}`);

	// try the country code only, eg: es-ar -> es
	if (!lang) {
		const shortCode = code.split('-')[0];
		lang = localesMap[shortCode];
		log.debug(`[translations] Short code match for '${shortCode}': ${lang ? lang.locale : 'none'}`);
	}

	// default to english
	if (!lang) {
		lang = localesMap['en'];
		log.debug(`[translations] Defaulting to english`);
	}

	log.debug(`[translations] getLocaleFromCode resolved: ${code} -> ${lang.locale}`);
	return lang.locale;
};

const i18nInstance = createInstance();
i18nInstance.use(ElectronStoreBackend).init({
	lng: 'en',
	fallbackLng: 'en',
	load: 'currentOnly',
	partialBundledLanguages: true,
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
	log.debug(`[translations] System preferred languages: ${JSON.stringify(systemLocales)}`);
	const systemLocale = getLocaleFromCode(systemLocales[0] ?? 'en');
	log.debug(`[translations] Changing language to: ${systemLocale}`);

	await i18nInstance.changeLanguage(systemLocale);
	log.debug(`[translations] Language changed, i18n language is now: ${i18nInstance.language}`);
};

export const t = i18nInstance.t.bind(i18nInstance);

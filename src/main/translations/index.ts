import { createInstance } from 'i18next';
import { app } from 'electron';
import Store from 'electron-store';

import locales from './locales.json';
import en from './locales/en/electron.json';
import { logger as log } from '../log';

type TranslationRecord = Record<string, string>;
type LocaleInfo = {
	name: string;
	nativeName?: string;
	native?: string;
	code: string;
	locale: string;
};

const store = new Store<Record<string, TranslationRecord>>();
// On next, this is wcpos/translations' moving jsDelivr branch ref, refreshed by the CDN within about 12 hours.
// On main, the release workflow replaces it with a CalVer tag; resolve this one-line conflict in main's favour when merging next.
const TRANSLATION_VERSION = 'next';
// A rolling ref must be re-fetched because its content changes under the same name.
// (Named REF, not VERSION, so the release bump regex `TRANSLATION_VERSION = '…'` cannot match it.)
const ROLLING_TRANSLATION_REF = 'next';
// Boot awaits the translations phase before creating the window, and a rolling read
// re-fetches even with a warm cache, so bound that request and fall back to the cache.
const ROLLING_FETCH_TIMEOUT_MS = 5000;
const TRANSLATION_CACHE_NAMESPACE = 'translations';
const TRANSLATION_CACHE_KEY_PATTERN = /^translations:(?:\d{4}\.\d+\.\d+|next):[A-Za-z0-9_-]+$/;
const LEGACY_TRANSLATION_CACHE_KEY_PATTERN = /^\d{4}\.\d+\.\d+:[A-Za-z0-9_-]+$/;
const buildTranslationCacheKey = (language: string) =>
	`${TRANSLATION_CACHE_NAMESPACE}:${TRANSLATION_VERSION}:${language}`;

const removeOldTranslationCacheKeys = () => {
	const currentPrefix = `${TRANSLATION_CACHE_NAMESPACE}:${TRANSLATION_VERSION}:`;
	Object.keys(store.store).forEach((key) => {
		if (LEGACY_TRANSLATION_CACHE_KEY_PATTERN.test(key)) {
			store.delete(key);
			return;
		}

		if (TRANSLATION_CACHE_KEY_PATTERN.test(key) && !key.startsWith(currentPrefix)) {
			store.delete(key);
		}
	});
};

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
		const init =
			TRANSLATION_VERSION === ROLLING_TRANSLATION_REF
				? { signal: AbortSignal.timeout(ROLLING_FETCH_TIMEOUT_MS) }
				: undefined;
		return fetch(url, init).then((response) => {
			if (!response.ok) return null;
			return response.json();
		});
	}

	read(language: string, namespace: string, callback: (err: any, data?: any) => void) {
		const cacheKey = buildTranslationCacheKey(language);
		const cached = this.store.get(cacheKey) as TranslationRecord | undefined;
		if (cached && TRANSLATION_VERSION !== ROLLING_TRANSLATION_REF) {
			callback(null, cached);
			return;
		}

		// Try the exact locale first, then fall back to base language (e.g. fr_CA -> fr)
		this.fetchTranslations(language, namespace)
			.then((data) => {
				if (data && Object.keys(data).length > 0) {
					this.store.set(cacheKey, data);
					callback(null, data);
					return;
				}

				// Regional locale not found, try base language
				const baseLang = this.getBaseLanguage(language);
				if (!baseLang) {
					callback(null, cached || {});
					return;
				}

				return this.fetchTranslations(baseLang, namespace).then((fallbackData) => {
					if (fallbackData && Object.keys(fallbackData).length > 0) {
						this.store.set(cacheKey, fallbackData);
						callback(null, fallbackData);
					} else {
						callback(null, cached || {});
					}
				});
			})
			.catch((err) => {
				log.error(`Failed to fetch translations: ${err.message}`);
				callback(null, cached || {});
			});
	}
}

/**
 * Map system locale codes to supported translation locale codes.
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
	try {
		removeOldTranslationCacheKeys();
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		log.warn(`Failed to prune old translation cache keys: ${message}`);
	}

	const systemLocales = app.getPreferredSystemLanguages();
	const systemLocale = getLocaleFromCode(systemLocales[0] ?? 'en');
	log.debug(`System locale: ${systemLocale}`);

	await i18nInstance.changeLanguage(systemLocale);
};

export const t = i18nInstance.t.bind(i18nInstance);

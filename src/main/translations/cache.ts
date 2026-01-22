import log from '../log';

import type ElectronStore from 'electron-store';

type TranslationRecord = Record<string, string>;
type TranslationsByLocale = Record<string, TranslationRecord>;

export default class CustomCache {
	translationsByLocale: TranslationsByLocale;
	store: ElectronStore<Record<string, TranslationRecord>>;

	constructor(store: ElectronStore<Record<string, TranslationRecord>>) {
		this.store = store;
		this.translationsByLocale = {};
	}

	/**
	 * Store locale translations in cache
	 */
	update(localeCode: string, translations: TranslationRecord, fromLocalStorage?: boolean): void {
		if (!fromLocalStorage) {
			log.debug(`Storing ${localeCode} translations in cache`);
			this.store.set(localeCode, translations);
		}

		const prevTranslations = this.translationsByLocale[localeCode] || {};
		this.translationsByLocale[localeCode] = {
			...prevTranslations,
			...translations,
		};
	}

	/**
	 * Get translations by locale from cache
	 */
	getTranslations(localeCode: string): TranslationRecord {
		return this.translationsByLocale[localeCode] || {};
	}

	/**
	 * Check if locale has translations in cache
	 */
	hasTranslations(localeCode: string): boolean {
		return !!this.translationsByLocale[localeCode];
	}

	/**
	 * Check if translations are stale and need refreshing
	 */
	isStale(localeCode: string): boolean {
		return !this.hasTranslations(localeCode);
	}

	/**
	 * Get translation by key. If key does not exist in cache,
	 * return empty string
	 */
	get(key: string, localeCode: string): string {
		return this.getTranslations(localeCode)[key] || '';
	}
}

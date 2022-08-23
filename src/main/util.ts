/* eslint import/prefer-default-export: off, import/no-mutable-exports: off */
import { URL } from 'url';
import path from 'path';

export function resolveHtmlPath(htmlFileName: string) {
	if (process.env.NODE_ENV === 'development') {
		const port = process.env.PORT || 1212;
		const url = new URL(`http://localhost:${port}`);
		url.pathname = htmlFileName;
		return url.href;
	}
	return `file://${path.resolve(__dirname, '../renderer/', htmlFileName)}`;
}

export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';
export const isDevelopment = process.env.NODE_ENV !== 'production';

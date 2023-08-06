/* eslint import/prefer-default-export: off, import/no-mutable-exports: off */
import path from 'path';
import { URL } from 'url';

import { SCHEME, ROOT } from './constants';

export const isDevelopment = process.env.NODE_ENV === 'development';

/**
 *
 */
export function resolveHtmlPath(htmlFileName: string) {
	if (isDevelopment) {
		// const port = process.env.PORT || 8088;
		// const url = new URL(`http://localhost:${port}`);
		// url.pathname = htmlFileName;
		// return url.href;
		return 'http://localhost:8088';
	}
	// In a packaged app, the resources will be relative to the app's root
	return `file://${path.join(process.resourcesPath, 'dist', htmlFileName)}`;
}

export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

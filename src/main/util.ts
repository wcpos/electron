/* eslint import/prefer-default-export: off, import/no-mutable-exports: off */
import fs from 'fs';

import { SCHEME, ROOT } from './constants';

export const isDevelopment = process.env.NODE_ENV === 'development';

export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

/**
 *
 */
export const createDir = (path: string): void => {
	if (fs.existsSync(path)) {
		return;
	}

	fs.mkdirSync(path);
};

/**
 *
 */
export const getFileExtension = (name: string): string | null => {
	if (!name.includes('.')) {
		return null;
	}

	const nameParts = name.split('.');
	return nameParts[nameParts.length - 1];
};

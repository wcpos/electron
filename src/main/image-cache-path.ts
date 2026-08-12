import path from 'path';

import { app } from 'electron';

import { isDevelopment } from './util';

/**
 * Path-only module: image-cache.ts registers the wcpos-image:// protocol at
 * import time, so consumers that need the cache LOCATION without the protocol
 * side effects (storage measurement) import from here instead.
 */
export function getImageCachePath(): string {
	return isDevelopment
		? path.resolve('databases', 'image-cache')
		: path.resolve(app.getPath('userData'), 'wcpos_dbs', 'image-cache');
}

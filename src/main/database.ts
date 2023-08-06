import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { app, ipcMain } from 'electron';

import logger from './log';

const isDevelopment = process.env.NODE_ENV === 'development';
// const sqlite = isDevelopment ? sqlite3.verbose() : sqlite3;
const registry = new Map();

/**
 * The app.getPath() method is only available once the app is 'ready'.
 * Use app.on('ready' () => { ... }); to detect the 'ready' event.
 * See Electron's Event: 'ready' event for more information.
 *
 * https://github.com/electron/electron/blob/main/docs/api/app.md#appgetpathname
 */
const openDatabase = (name: string) => {
	/**
	 * Check registry
	 */
	if (registry.has(name)) {
		return { name };
	}

	/**
	 *
	 */
	const dbFolder =
		process.env.NODE_ENV === 'development'
			? path.resolve('databases')
			: path.resolve(app.getPath('userData'), 'databases');

	if (!fs.existsSync(dbFolder)) {
		fs.mkdirSync(dbFolder);
		logger.info(`Folder '${dbFolder}' created`);
	}

	/**
	 *
	 */
	const db = new Database(
		path.resolve(dbFolder, `${name}.sqlite3`)
		// sqlite.OPEN_READWRITE | sqlite.OPEN_CREATE,
		// (err) => {
		// 	if (err) {
		// 		logger.error('Could not connect to database', err);
		// 	} else {
		// 		logger.info('Connected to database!');
		// 	}
		// }
	);

	logger.info('Opening SQLite database', db);
	registry.set(name, db);
	return { name };
};

export const closeAll = () => {
	registry.forEach((db) => {
		db.close();
	});
};

ipcMain.handle('sqlite', (event, obj) => {
	logger.debug('sql request', JSON.stringify(obj, null, 2));
	try {
		switch (obj.type) {
			case 'open':
				return openDatabase(obj.name);
			case 'all':
				const dbForAll = registry.get(obj.name);
				const results = dbForAll.prepare(obj.sql.query).all(obj.sql.params);
				return results;
			case 'run':
				const dbForRun = registry.get(obj.name);
				dbForRun.prepare(obj.sql.query).run(obj.sql.params);
				return { name: obj.name }; // or whatever you need to return
			case 'close':
				const dbForClose = registry.get(obj.name);
				dbForClose.close();
				return;
			case 'quit':
				closeAll();
				return;
			default:
				throw new Error('Unknown type');
		}
	} catch (err) {
		logger.error('SQLite error', err);
		throw err;
	}
});

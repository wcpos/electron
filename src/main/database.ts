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

	try {
		/**
		 * Determine database folder
		 */
		const dbFolder = isDevelopment
			? path.resolve('databases')
			: path.resolve(app.getPath('userData'), 'databases');

		/**
		 * Create folder if it doesn't exist
		 */
		if (!fs.existsSync(dbFolder)) {
			fs.mkdirSync(dbFolder);
			logger.info(`Folder '${dbFolder}' created`);
		}

		/**
		 * Open database
		 */
		logger.info('Opening SQLite database', name);
		const db = new Database(path.resolve(dbFolder, `${name}.sqlite3`), { verbose: logger.debug });
		logger.info('Opened SQLite database', db);

		registry.set(name, db);
		return { name };
	} catch (error) {
		logger.error('Failed to open database', error);
		throw error; // Re-throw the error after logging it to allow further handling upstream
	}
};

export const closeAll = () => {
	registry.forEach((db) => {
		db.close();
	});
};

/**
 * RxDB sends query params as booleans, but SQLite doesn't support booleans.
 */
function convertBooleansToNumbers(params: (string | number | boolean)[]): (string | number)[] {
	return params.map((param) => (typeof param === 'boolean' ? (param ? 1 : 0) : param));
}

ipcMain.handle('sqlite', (event, obj) => {
	logger.debug('sql request', JSON.stringify(obj, null, 2));
	try {
		let db;
		switch (obj.type) {
			case 'open':
				return openDatabase(obj.name);
			case 'all':
				db = registry.get(obj.name);
				if (!db) throw new Error(`Database connection "${obj.name}" not found`);

				const results = db.prepare(obj.sql.query).all(convertBooleansToNumbers(obj.sql.params));
				return results;
			case 'run':
				db = registry.get(obj.name);
				if (!db) throw new Error(`Database connection "${obj.name}" not found`);

				db.prepare(obj.sql.query).run(convertBooleansToNumbers(obj.sql.params));
				return { name: obj.name }; // or whatever you need to return
			case 'close':
				db = registry.get(obj.name);
				if (!db) throw new Error(`Database connection "${obj.name}" not found`);

				db.close();
				registry.delete(obj.name); // Remove the db from the registry after closing it
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

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
	registry.forEach((db, name) => {
		db.close();
		registry.delete(name);
		logger.info(`Closed and removed ${name} from registry.`);
	});
};

/**
 * RxDB sends query params as booleans, but SQLite doesn't support booleans.
 */
function convertBooleansToNumbers(params: (string | number | boolean)[]): (string | number)[] {
	return params.map((param) => (typeof param === 'boolean' ? (param ? 1 : 0) : param));
}

/**
 *
 */
function executeSql(db, sql, params) {
	if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
		return db.prepare(sql).all(params); // For SELECT or PRAGMA queries
	} else {
		return db.prepare(sql).run(params); // For INSERT, UPDATE, DELETE
	}
}

/**
 *
 */
ipcMain.handle('sqlite', (event, obj) => {
	logger.silly('SQL request', JSON.stringify(obj, null, 2));
	try {
		let db;
		switch (obj.type) {
			case 'open':
				return openDatabase(obj.name);
			case 'close':
				db = registry.get(obj.name);
				if (!db) throw new Error(`Database connection "${obj.name}" not found`);
				db.close();
				registry.delete(obj.name);
				logger.info(`Closed and removed ${obj.name} from registry.`);
				return;
			case 'quit':
				closeAll();
				return;
			case 'all':
			case 'run': // These cases are now dynamically handled together
				db = registry.get(obj.name);
				if (!db) throw new Error(`Database connection "${obj.name}" not found`);
				const params = convertBooleansToNumbers(obj.sql.params);
				return executeSql(db, obj.sql.query, params);
			default:
				throw new Error('Unknown type');
		}
	} catch (err) {
		logger.error('SQLite error', err, obj);
		throw err;
	}
});

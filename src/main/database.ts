import fs from 'fs';
import path from 'path';

import { app, ipcMain } from 'electron';
import sqlite3 from 'sqlite3';

import logger from './log';

const isDevelopment = process.env.NODE_ENV === 'development';
const sqlite = isDevelopment ? sqlite3.verbose() : sqlite3;
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
	const db = new sqlite.Database(
		path.resolve(dbFolder, `${name}.sqlite3`),
		// sqlite.OPEN_READWRITE | sqlite.OPEN_CREATE,
		(err) => {
			if (err) {
				logger.error('Could not connect to database', err);
			} else {
				logger.info('Connected to database!');
			}
		}
	);

	logger.info('Opening SQLite database', db);
	registry.set(name, db);
	return { name };
};

/**
 *
 */
export const closeAll = () => {
	return new Promise((resolve, reject) => {
		registry.forEach((db) => {
			db.close((err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	});
};

/**
 *
 */
ipcMain.handle('sqlite', (event, obj) => {
	logger.debug('sql request', JSON.stringify(obj, null, 2));
	switch (obj.type) {
		case 'open':
			return openDatabase(obj.name);
		case 'all':
			return new Promise((resolve, reject) => {
				const db = registry.get(obj.name);
				db.all(obj.sql.query, obj.sql.params, (err, res) => {
					logger.debug('sql response: ', JSON.stringify(err, null, 2));
					if (err) {
						return reject(err);
					}

					logger.debug('sql response: ', JSON.stringify(res, null, 2));
					if (Array.isArray(res)) {
						return resolve(res);
						// const queryResult = res[0]; // there is only one query
						// if (Object.prototype.hasOwnProperty.call(queryResult, 'rows')) {
						// 	return resolve(queryResult.rows);
						// }
						// return reject(queryResult.error);
					}

					return reject(new Error(`Unexpected response from SQLite: ${res}`));
				});
			});
		case 'run':
			return new Promise((resolve, reject) => {
				const db = registry.get(obj.name);
				db.run(obj.sql.query, obj.sql.params, (err) => {
					logger.debug('sql response: ', JSON.stringify(err, null, 2));
					if (err) {
						reject(err);
					} else {
						// NOTE: not sure if I should return db or null here?
						resolve({ name: obj.name });
					}
				});
			});
		case 'close':
			return new Promise((resolve, reject) => {
				const db = registry.get(obj.name);
				db.close((err) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			});
		case 'quit':
			return closeAll();
		default:
			return new Error('Unknown type');
	}
});

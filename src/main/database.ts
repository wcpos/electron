import { app, ipcMain } from 'electron';
import sqlite from 'sqlite3';
import path from 'path';

const sqlite3 = sqlite.verbose();

/**
 *
 */
const db = new sqlite3.Database(
	':memory:',
	// sqlite.OPEN_READWRITE | sqlite.OPEN_CREATE,
	(err) => {
		if (err) {
			console.log('Could not connect to database', err);
		} else {
			console.log('Connected to database!');
		}
	}
);

/**
 * The app.getPath() method is only available once the app is 'ready'.
 * Use app.on('ready' () => { ... }); to detect the 'ready' event.
 * See Electron's Event: 'ready' event for more information.
 *
 * https://github.com/electron/electron/blob/main/docs/api/app.md#appgetpathname
 */
const openDatabase = (name: string) => {
	// const dbPath =
	// 	process.env.NODE_ENV === 'development'
	// 		? `${name}.sqlite3`
	// 		: path.resolve(app.getPath('appData'), `${name}.sqlite3`);

	/**
	 *
	 */
	const db = new sqlite3.Database(
		':memory:',
		// sqlite.OPEN_READWRITE | sqlite.OPEN_CREATE,
		(err) => {
			if (err) {
				console.log('Could not connect to database', err);
			} else {
				console.log('Connected to database!');
			}
		}
	);

	test = db;

	console.log(db);
	return db;
};

// const Hello = {
// 	db: null,
// 	openDatabase: (name: string) => {
// 		return name;
// 	},
// };

/**
 *
 */
ipcMain.handle('sqlite', (event, obj) => {
	switch (obj.type) {
		case 'open':
			return 'hi';
		case 'all':
			return new Promise((resolve, reject) => {
				db.all(obj.sql.query, obj.sql.params, (err, res) => {
					console.log('sql response: ', res);

					if (err) {
						return reject(err);
					}

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
				db.run(obj.sql.query, obj.sql.params, (err) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			});
		default:
			return new Error('Unknown type');
	}
});

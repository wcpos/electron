import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getSQLiteBasicsNodeNative } from 'rxdb-premium/plugins/storage-sqlite';

export const SQLITE_FILE_EXTENSION = '.sqlite';

export function createNodeSqliteBasics(root: string) {
	const basics = getSQLiteBasicsNodeNative(DatabaseSync);
	return {
		...basics,
		async open(databaseName: string): Promise<DatabaseSync> {
			if (/[\\/]|\.\./.test(databaseName)) {
				throw new Error(`Invalid SQLite database name: ${databaseName}`);
			}
			await fs.promises.mkdir(root, { recursive: true });
			const db: DatabaseSync = await basics.open(
				path.join(root, `${databaseName}${SQLITE_FILE_EXTENSION}`)
			);
			try {
				// WAL + NORMAL preserves committed writes across process death; power loss is out of scope.
				db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
				const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
				if (mode !== 'wal') {
					throw new Error(`SQLite requires WAL journal mode; received ${mode}`);
				}
				return db;
			} catch (error) {
				db.close();
				throw error;
			}
		},
	};
}

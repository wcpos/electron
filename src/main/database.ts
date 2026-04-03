import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { ipcMain } from 'electron';

import { logger } from './log';
import { getLegacySqliteBasePath } from './rxdb-storage';

const isDevelopment = process.env.NODE_ENV === 'development';
const registry = new Map<string, Database.Database>();

const openDatabase = (name: string) => {
	if (registry.has(name)) {
		return { name };
	}

	try {
		const dbFolder = getLegacySqliteBasePath();

		if (!fs.existsSync(dbFolder)) {
			try {
				fs.mkdirSync(dbFolder, { recursive: true });
				logger.info(`Created database folder: ${dbFolder}`);
			} catch (err) {
				logger.error(`Failed to create database folder: ${dbFolder}`, err);
			}
		}

		logger.info('Opening SQLite database', name);
		const db = new Database(path.resolve(dbFolder, `${name}.sqlite3`), {
			verbose: isDevelopment ? logger.silly : undefined,
		});
		logger.info('Opened SQLite database', db);

		registry.set(name, db);
		return { name };
	} catch (error) {
		logger.error('Failed to open database', error);
		throw error;
	}
};

async function deleteDatabaseFiles(name: string) {
	if (/[/\\]|\.\./.test(name)) {
		throw new Error(`Invalid database name: ${name}`);
	}

	const db = registry.get(name);
	if (db) {
		db.close();
		registry.delete(name);
		logger.info(`Closed and removed ${name} from registry before deletion.`);
	}

	const dbFilePath = path.resolve(getLegacySqliteBasePath(), `${name}.sqlite3`);
	const siblingPaths = [
		dbFilePath,
		`${dbFilePath}-wal`,
		`${dbFilePath}-shm`,
		`${dbFilePath}-journal`,
	];

	await Promise.all(
		siblingPaths.map(async (filePath) => {
			try {
				await fs.promises.rm(filePath, { force: true });
			} catch (error) {
				logger.error(`Failed to delete SQLite file: ${filePath}`, error);
				throw error;
			}
		})
	);
}

export const closeAll = () => {
	registry.forEach((db, name) => {
		db.close();
		registry.delete(name);
		logger.info(`Closed and removed ${name} from registry.`);
	});
};

function convertBooleansToNumbers(params: (string | number | boolean)[]): (string | number)[] {
	return params.map((param) => (typeof param === 'boolean' ? (param ? 1 : 0) : param));
}

function executeSql(db: Database.Database, sql: string, params: (string | number)[]) {
	if (/^\s*SELECT/i.test(sql)) {
		return db.prepare(sql).all(params);
	}
	if (/^\s*PRAGMA\s+\w+\s*=\s*/i.test(sql)) {
		return db.prepare(sql).run(params);
	}
	if (/^\s*PRAGMA/i.test(sql)) {
		return db.prepare(sql).all(params);
	}
	return db.prepare(sql).run(params);
}

function safeStringify(obj: any, maxLength = 5000): string {
	const seen = new WeakSet();
	try {
		const result = JSON.stringify(
			obj,
			(key, value) => {
				if (typeof value === 'object' && value !== null) {
					if (seen.has(value)) {
						return '[Circular]';
					}
					seen.add(value);
				}
				if (typeof value === 'string' && value.length > 500) {
					return value.substring(0, 500) + `... [${value.length} chars total]`;
				}
				return value;
			},
			2
		);
		if (result && result.length > maxLength) {
			return result.substring(0, maxLength) + `... [${result.length} chars total]`;
		}
		return result;
	} catch {
		return '[Unable to stringify]';
	}
}

const summarizeObj = (obj: any) => {
	try {
		const paramsInfo = Array.isArray(obj.sql?.params)
			? `[Array(${obj.sql.params.length})]`
			: obj.sql?.params;

		let paramsSize = 0;
		if (Array.isArray(obj.sql?.params)) {
			for (const param of obj.sql.params) {
				if (typeof param === 'string') {
					paramsSize += param.length;
				}
			}
		}

		return {
			type: obj.type,
			name: obj.name,
			sql: obj.sql
				? {
						query: obj.sql.query,
						params: paramsInfo,
						paramsSize: paramsSize > 0 ? `~${Math.round(paramsSize / 1024)}KB` : undefined,
					}
				: undefined,
		};
	} catch {
		return 'Failed to summarize object';
	}
};

ipcMain.handle('sqlite', async (_event, obj) => {
	const summary = summarizeObj(obj);
	logger.silly('SQL request', safeStringify(summary));

	if (
		typeof summary !== 'string' &&
		summary.sql?.paramsSize &&
		parseInt(summary.sql.paramsSize, 10) > 100
	) {
		logger.warn(
			'Large SQL params detected',
			summary.sql.paramsSize,
			summary.sql.query?.substring(0, 100)
		);
	}

	try {
		let db;
		switch (obj.type) {
			case 'open':
				return openDatabase(obj.name);
			case 'close':
				db = registry.get(obj.name);
				if (!db) {
					throw new Error(`Database connection "${obj.name}" not found`);
				}
				db.close();
				registry.delete(obj.name);
				logger.info(`Closed and removed ${obj.name} from registry.`);
				return;
			case 'delete':
				await deleteDatabaseFiles(obj.name);
				return;
			case 'quit':
				closeAll();
				return;
			case 'all':
			case 'run': {
				db = registry.get(obj.name);
				if (!db) {
					throw new Error(`Database connection "${obj.name}" not found`);
				}
				const convertedParams = convertBooleansToNumbers(obj.sql.params);
				return executeSql(db, obj.sql.query, convertedParams);
			}
			default:
				throw new Error('Unknown type');
		}
	} catch (err) {
		logger.error('SQLite error', err, summarizeObj(obj));
		throw err;
	}
});

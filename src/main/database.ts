import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { app, ipcMain } from 'electron';
import logger from './log';

const isDevelopment = process.env.NODE_ENV === 'development';
const registry = new Map();

/**
 * Open or retrieve an existing SQLite database.
 */
const openDatabase = (name: string) => {
  // Check registry first
  if (registry.has(name)) {
    return { name };
  }

  try {
    const dbFolder = isDevelopment
      ? path.resolve('databases')
      : path.resolve(app.getPath('userData'), 'wcpos_dbs');

    // Create folder if it doesn't exist
    if (!fs.existsSync(dbFolder)) {
      try {
        fs.mkdirSync(dbFolder, { recursive: true });
        logger.info(`Created database folder: ${dbFolder}`);
      } catch (err) {
        logger.error(`Failed to create database folder: ${dbFolder}`, err);
      }
    }

    logger.info('Opening SQLite database', name);
    const db = new Database(path.resolve(dbFolder, `${name}.sqlite3`), { verbose: logger.debug });
    logger.info('Opened SQLite database', db);

    registry.set(name, db);
    return { name };
  } catch (error) {
    logger.error('Failed to open database', error);
    throw error;
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
 * Convert boolean values in parameters to numbers (SQLite doesn't support booleans).
 */
function convertBooleansToNumbers(params: (string | number | boolean)[]): (string | number)[] {
  return params.map(param => (typeof param === 'boolean' ? (param ? 1 : 0) : param));
}

/**
 * Execute an SQL statement.
 *
 * - SELECT queries: use .all()
 * - PRAGMA assignments (e.g. PRAGMA synchronous = normal): use .run()
 * - Other PRAGMA queries: use .all()
 * - All others: use .run()
 */
function executeSql(db, sql, params) {
  if (/^\s*SELECT/i.test(sql)) {
    return db.prepare(sql).all(params);
  }
  // PRAGMA assignments like "PRAGMA synchronous = normal" do not return data.
  if (/^\s*PRAGMA\s+\w+\s*=\s*/i.test(sql)) {
    return db.prepare(sql).run(params);
  }
  if (/^\s*PRAGMA/i.test(sql)) {
    return db.prepare(sql).all(params);
  }
  return db.prepare(sql).run(params);
}

/**
 * Handle SQLite IPC requests.
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
      case 'run': {
        db = registry.get(obj.name);
        if (!db) throw new Error(`Database connection "${obj.name}" not found`);
        const convertedParams = convertBooleansToNumbers(obj.sql.params);
        return executeSql(db, obj.sql.query, convertedParams);
      }
      default:
        throw new Error('Unknown type');
    }
  } catch (err) {
    logger.error('SQLite error', err, obj);
    throw err;
  }
});
export { openDatabase, migrate, type Db } from './db.js';
export { MIGRATIONS, type Migration } from './migrations.js';
export { SqliteUnitOfWork } from './repositories.js';

import { openDatabase } from './db.js';
import { SqliteUnitOfWork } from './repositories.js';
import type { UnitOfWork } from '@agents-hub/core';

/** Atalho: abre o banco, migra e devolve a unidade de trabalho pronta. */
export function createStore(file: string): UnitOfWork {
  return new SqliteUnitOfWork(openDatabase(file));
}

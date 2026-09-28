export { openDatabase, migrate, type Db } from './db.js';
export { MIGRATIONS, type Migration } from './migrations.js';
export {
  SqliteUnitOfWork,
  SqliteEspacoDoBanco,
  type EstadoDoEspaco,
  type ModoAutoVacuum,
} from './repositories.js';
export {
  backupDatabase,
  restoreDatabase,
  conferirBanco,
  backupFileName,
  type BackupResult,
  type RestoreResult,
} from './backup.js';

import { openDatabase } from './db.js';
import { SqliteUnitOfWork } from './repositories.js';
/**
 * Atalho: abre o banco, migra e devolve a unidade de trabalho pronta. O tipo
 * concreto (e não só `UnitOfWork`) expõe `espaco`, a manutenção do arquivo que
 * o daemon usa para devolver espaço ao SO.
 */
export function createStore(file: string): SqliteUnitOfWork {
  return new SqliteUnitOfWork(openDatabase(file));
}

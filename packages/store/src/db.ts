import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Db = DatabaseSync;

/**
 * Abre (e migra) o banco do Hub.
 *
 * `node:sqlite` é embutido no runtime — zero dependência nativa para compilar,
 * o que importa quando o Hub precisa rodar em qualquer máquina sua sem
 * toolchain de C++ instalada.
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);

  // WAL: o daemon escreve eventos enquanto CLI/TUI/Web leem — sem isso, leitor
  // e escritor se bloqueiam mutuamente o tempo todo.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');

  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    (db.prepare('SELECT version FROM migrations').all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(
        `Falha na migração ${migration.version} (${migration.name}): ${(err as Error).message}`,
      );
    }
  }
}

/** `node:sqlite` só aceita null/number/bigint/string/Uint8Array como parâmetro. */
export type SqlValue = string | number | bigint | null | Uint8Array;

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function nullableJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

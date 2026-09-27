import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { isHubError } from '@agents-hub/core';
import { backupDatabase, conferirBanco, restoreDatabase } from './backup.js';
import { openDatabase } from './db.js';
import { MIGRATIONS } from './migrations.js';

const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-store-backup-'));
after(() => {
  try {
    rmSync(raiz, { recursive: true, force: true });
  } catch {
    /* oportunista */
  }
});

function inserirProjetos(db: DatabaseSync, n: number, prefixo: string): void {
  const stmt = db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < n; i += 1) {
    stmt.run(`prj_${prefixo}${i}`, `${prefixo}-${i}`, path.join(raiz, `${prefixo}-${i}`), new Date().toISOString());
  }
}

function contarProjetos(file: string): number {
  const db = new DatabaseSync(file);
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n);
  } catch {
    // Cópia crua de um banco novo: até o schema ainda está no WAL.
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Achado MÉDIO da vistoria 09: não havia backup, e copiar só o `hub.db` com o
 * daemon no ar perdia o que estava no WAL (0 de 50 projetos na reprodução).
 */
describe('backupDatabase — consistente com WAL', () => {
  test('com a conexão do "daemon" aberta, o backup tem tudo; a cópia crua do .db não', () => {
    const dbFile = path.join(raiz, 'wal', 'hub.db');
    const daemon = openDatabase(dbFile); // WAL ligado, conexão segue aberta
    try {
      inserirProjetos(daemon, 50, 'a');
      assert.ok(statSync(`${dbFile}-wal`).size > 0, 'pré-condição: dados recentes estão no WAL');

      // O que a pessoa fazia antes: copiar só o arquivo principal.
      const cru = path.join(raiz, 'wal', 'copia-crua.db');
      copyFileSync(dbFile, cru);
      assert.ok(contarProjetos(cru) < 50, 'a cópia crua perde o que está no WAL (é o bug)');

      const out = path.join(raiz, 'wal', 'backups', 'hub-1.db');
      const r = backupDatabase(dbFile, out);
      assert.equal(r.path, out);
      assert.ok(r.bytes > 0);
      assert.equal(r.schemaVersion, Math.max(...MIGRATIONS.map((m) => m.version)));
      assert.equal(contarProjetos(out), 50, 'VACUUM INTO enxerga o WAL');
    } finally {
      daemon.close();
    }
  });

  test('nunca sobrescreve um arquivo existente', () => {
    const dbFile = path.join(raiz, 'sobre', 'hub.db');
    openDatabase(dbFile).close();
    const out = path.join(raiz, 'sobre', 'ja-existe.db');
    writeFileSync(out, 'conteúdo que não pode sumir');
    assert.throws(() => backupDatabase(dbFile, out), /já existe/);
    assert.equal(statSync(out).size, Buffer.byteLength('conteúdo que não pode sumir'));
  });

  test('banco inexistente é erro claro', () => {
    assert.throws(() => backupDatabase(path.join(raiz, 'nada', 'hub.db'), path.join(raiz, 'nada', 'b.db')), /não encontrado/);
  });
});

describe('restoreDatabase', () => {
  test('troca o banco, guarda o anterior (com o que estava no WAL) e descarta -wal/-shm velhos', () => {
    const dir = path.join(raiz, 'restore');
    const dbFile = path.join(dir, 'hub.db');
    const origem = openDatabase(dbFile);
    inserirProjetos(origem, 3, 'velho');
    const backup = path.join(dir, 'backup.db');
    backupDatabase(dbFile, backup);
    inserirProjetos(origem, 7, 'depois');
    origem.close();
    assert.equal(contarProjetos(dbFile), 10);

    // Simula um WAL velho deixado para trás: não pode ser reaplicado.
    writeFileSync(`${dbFile}-wal`, '');

    const r = restoreDatabase(backup, dbFile, new Date(2026, 8, 26, 10, 0, 0));
    assert.equal(r.restored, dbFile);
    assert.ok(r.safetyCopy && existsSync(r.safetyCopy), 'cópia de segurança do atual');
    assert.match(path.basename(r.safetyCopy), /^hub\.db\.pre-restore-20260926-100000/);
    assert.equal(contarProjetos(r.safetyCopy), 10, 'a cópia de segurança tem o estado de antes');
    assert.equal(existsSync(`${dbFile}-wal`), false, 'o -wal velho foi descartado');
    assert.equal(contarProjetos(dbFile), 3, 'o banco agora é o do backup');
    // E abre normalmente pelo caminho do Hub (migra sem erro).
    openDatabase(dbFile).close();
  });

  test('recusa arquivo que não é banco do Hub, sem tocar no atual', () => {
    const dir = path.join(raiz, 'lixo');
    const dbFile = path.join(dir, 'hub.db');
    const db = openDatabase(dbFile);
    inserirProjetos(db, 2, 'x');
    db.close();
    const lixo = path.join(dir, 'lixo.db');
    writeFileSync(lixo, 'isto não é sqlite'.repeat(100));
    assert.throws(() => restoreDatabase(lixo, dbFile), (err: unknown) => isHubError(err));
    const outro = path.join(dir, 'outro.db');
    const o = new DatabaseSync(outro);
    o.exec('CREATE TABLE qualquer (x INTEGER)');
    o.close();
    assert.throws(() => restoreDatabase(outro, dbFile), /não parece um banco do Agents-Hub/);
    assert.equal(contarProjetos(dbFile), 2);
  });

  test('recusa backup de um Hub mais novo (schema à frente)', () => {
    const dir = path.join(raiz, 'futuro');
    const futuro = path.join(dir, 'futuro.db');
    const db = openDatabase(futuro);
    db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(9999, 'x', 'y');
    db.close();
    assert.throws(() => conferirBanco(futuro), /só conhece até/);
  });
});

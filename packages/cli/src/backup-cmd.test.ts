import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { describe, test } from 'node:test';
import { backupCommand, restoreCommand } from './backup-cmd.js';
import { capturar, limpar, montarHub } from './test-kit.js';

function projetos(dbFile: string): string[] {
  const db = new DatabaseSync(dbFile);
  try {
    return (db.prepare('SELECT name FROM projects ORDER BY name').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
  } finally {
    db.close();
  }
}

/**
 * Não havia backup/restauração do banco, e copiar só o `hub.db` perdia o WAL
 * (vistoria 09). Daemon isolado de verdade; restauração só com ele parado.
 */
describe('hub backup / hub restore', () => {
  test('ciclo completo: backup pelo daemon, restore recusado com ele no ar, restore depois de parar', async () => {
    const t = await montarHub('backup');
    const onde = { home: t.hub.config.home, dbFile: t.hub.config.dbFile };
    try {
      t.hub.sessions.registerProject(path.join(t.raiz, 'p1'), 'p1');
      t.hub.sessions.registerProject(path.join(t.raiz, 'p2'), 'p2');

      // 1. backup com o daemon no ar: vai pela rota autenticada e fica na auditoria.
      const out = path.join(t.raiz, 'meu-backup.db');
      const b = await capturar(() =>
        backupCommand(t.client, onde, { command: 'backup', positional: [], flags: { out, json: true } }),
      );
      const lido = JSON.parse(b.out.join('\n')) as { path: string; via: string };
      assert.equal(lido.via, 'daemon');
      assert.equal(lido.path, out);
      assert.deepEqual(projetos(out), ['p1', 'p2'], 'o backup tem o que ainda estava no WAL');
      assert.equal(t.hub.audit.list({ kind: 'maintenance.backup' }).length, 1);

      // 2. restore com o daemon no ar é recusado.
      await assert.rejects(
        () =>
          restoreCommand(t.client, onde, {
            command: 'restore',
            positional: [out],
            flags: { write: true },
          }),
        /daemon está rodando/,
      );

      // 3. para o daemon; o banco ganha um projeto que o backup não tem.
      await t.fechar();
      const db = new DatabaseSync(onde.dbFile);
      db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
        'prj_depoisdobackup',
        'p3',
        path.join(t.raiz, 'p3'),
        new Date().toISOString(),
      );
      db.close();
      assert.deepEqual(projetos(onde.dbFile), ['p1', 'p2', 'p3']);

      // 4. sem --write: só confere e mostra o plano.
      const previa = await capturar(() =>
        restoreCommand(t.client, onde, { command: 'restore', positional: [out], flags: {} }),
      );
      assert.ok(previa.out.some((l) => l.includes('prévia')));
      assert.deepEqual(projetos(onde.dbFile), ['p1', 'p2', 'p3']);

      // 5. --write: troca, e o banco anterior fica guardado.
      const r = await capturar(() =>
        restoreCommand(t.client, onde, {
          command: 'restore',
          positional: [out],
          flags: { write: true },
        }),
      );
      assert.ok(r.out.some((l) => l.includes('banco restaurado')));
      assert.deepEqual(projetos(onde.dbFile), ['p1', 'p2']);
      const guardada = readdirSync(path.dirname(onde.dbFile)).find((f) =>
        f.startsWith('hub.db.pre-restore-'),
      );
      assert.ok(guardada, 'cópia de segurança do banco anterior');
      assert.deepEqual(projetos(path.join(path.dirname(onde.dbFile), guardada)), ['p1', 'p2', 'p3']);

      // 6. daemon parado: backup é feito localmente, no lugar padrão.
      const local = await capturar(() =>
        backupCommand(t.client, onde, { command: 'backup', positional: [], flags: { json: true } }),
      );
      const l = JSON.parse(local.out.join('\n')) as { path: string; via: string };
      assert.equal(l.via, 'local');
      assert.equal(path.dirname(l.path), path.join(onde.home, 'backups'));
      assert.ok(existsSync(l.path));
    } finally {
      await t.fechar();
      limpar(t.raiz);
    }
  });

  test('restore de arquivo que não é banco do Hub é recusado antes de qualquer plano', async () => {
    const t = await montarHub('restore-lixo');
    const onde = { home: t.hub.config.home, dbFile: t.hub.config.dbFile };
    await t.fechar();
    try {
      await assert.rejects(
        () =>
          restoreCommand(t.client, onde, {
            command: 'restore',
            positional: [path.join(t.raiz, 'nao-existe.db')],
            flags: {},
          }),
        /não encontrado/,
      );
      const outro = path.join(t.raiz, 'outro.db');
      const db = new DatabaseSync(outro);
      db.exec('CREATE TABLE x (y INTEGER)');
      db.close();
      await assert.rejects(
        () =>
          restoreCommand(t.client, onde, {
            command: 'restore',
            positional: [outro],
            flags: { write: true },
          }),
        /não parece um banco do Agents-Hub/,
      );
    } finally {
      limpar(t.raiz);
    }
  });
});

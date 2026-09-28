import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { isHubError } from '@agents-hub/core';
import { openDatabase, migrate } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { SqliteEspacoDoBanco } from './repositories.js';

/**
 * Achado (MÉDIO): `migrate()` só olhava para o que estava PENDENTE em
 * `MIGRATIONS` — nunca para o que já estava aplicado além do que o código
 * conhece. Um Hub mais antigo aberto contra um banco escrito por um Hub mais
 * novo (schema à frente) não achava nada pendente e retornava em silêncio,
 * sem erro, sem aviso. Hoje as migrações são só aditivas (ADD COLUMN /
 * CREATE INDEX), então isso não corrompe nada de forma comprovável — mas no
 * dia em que uma migração futura mudar semântica em vez de só adicionar, o
 * código antigo processaria dados mal-interpretados silenciosamente.
 *
 * Este teste simula o cenário: grava manualmente uma linha de migração com
 * versão maior que qualquer uma em `MIGRATIONS` e confirma que abrir o banco
 * recusa em vez de seguir quieto.
 */
describe('migrate() recusa banco com versão de schema mais nova que o código', () => {
  test('linha de migração com versão futura na tabela migrations lança erro', () => {
    const db = openDatabase(':memory:');

    const maxKnown = Math.max(...MIGRATIONS.map((m) => m.version));
    const futureVersion = maxKnown + 995; // ex.: 999 quando maxKnown = 4

    db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      futureVersion,
      'migração hipotética de um Hub mais novo',
      new Date().toISOString(),
    );

    assert.throws(
      () => migrate(db),
      (err: unknown) => {
        assert.ok(isHubError(err), 'esperava um HubError, não um erro genérico');
        assert.equal((err as { code: string }).code, 'HUB_CONFIG_INVALID');
        assert.match((err as Error).message, new RegExp(String(futureVersion)));
        assert.match((err as Error).message, new RegExp(String(maxKnown)));
        return true;
      },
    );
  });

  test('banco só com versões conhecidas migra normalmente, sem lançar', () => {
    const db = openDatabase(':memory:');
    assert.doesNotThrow(() => migrate(db));
  });
});

describe('auto_vacuum (R09-07)', () => {
  test('banco novo nasce com auto_vacuum = INCREMENTAL', () => {
    const db = openDatabase(':memory:');
    try {
      assert.equal(new SqliteEspacoDoBanco(db).estado().autoVacuum, 'incremental');
    } finally {
      db.close();
    }
  });

  test('abrir banco antigo não o converte sozinho: o daemon o reconhece e decide', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hub-store-av-'));
    const file = path.join(dir, 'hub.db');
    try {
      const legado = new DatabaseSync(file);
      legado.exec('CREATE TABLE legado_marcador (x INTEGER);');
      legado.close();

      const db = openDatabase(file);
      const espaco = new SqliteEspacoDoBanco(db);
      try {
        // O pragma de `openDatabase` fica pendente num banco com tabelas; o
        // disco segue `none` até o `VACUUM` da conversão.
        assert.equal(espaco.estado().autoVacuum, 'none');
        assert.equal(espaco.devolverPaginasLivres(128), 0, 'sem auto_vacuum o pragma é inócuo');
        espaco.converterParaIncremental();
        assert.equal(espaco.estado().autoVacuum, 'incremental');
        // Em WAL o VACUUM reescreve o banco inteiro no `-wal`; a conversão
        // não pode deixar o disco dobrado.
        assert.equal(statSync(`${file}-wal`).size, 0, 'conversão termina com o -wal zerado');
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

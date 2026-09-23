import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isHubError } from '@agents-hub/core';
import { openDatabase, migrate } from './db.js';
import { MIGRATIONS } from './migrations.js';

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

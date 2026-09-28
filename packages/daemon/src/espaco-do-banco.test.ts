import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type { Session } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * R09-07 (vistoria 2026-09-25), pendência D(5) do fechamento do MVP: zerar
 * `raw_json` liberava páginas que o arquivo nunca devolvia ao SO — o
 * compactador rodava, o disco não mudava. Aqui o arquivo de verdade (home
 * temporário, sem porta, sem agente): o que importa é o tamanho no disco.
 */

const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-espaco-'));
after(() => {
  try {
    rmSync(raiz, { recursive: true, force: true });
  } catch {
    /* limpeza de temp é oportunista */
  }
});

function montar(nome: string): { hub: Hub; dbFile: string; home: string } {
  const home = path.join(raiz, nome);
  const manifestos = path.join(home, 'manifests');
  mkdirSync(manifestos, { recursive: true });
  const hub = createHub({ home, manifestsDir: manifestos, webRoot: path.join(home, 'sem-web') });
  return { hub, dbFile: hub.config.dbFile, home };
}

/** O que o banco ocupa no disco: o `.db` e o `-wal` (onde a escrita recente mora). */
function bytesNoDisco(dbFile: string): number {
  return [dbFile, `${dbFile}-wal`]
    .filter((f) => existsSync(f))
    .reduce((total, f) => total + statSync(f).size, 0);
}

function autoVacuumNoDisco(dbFile: string): number {
  const db = new DatabaseSync(dbFile);
  try {
    return Number(Object.values(db.prepare('PRAGMA auto_vacuum').get() ?? {})[0]);
  } finally {
    db.close();
  }
}

/** Sessões encerradas em 2020 com eventos de `raw` grande: tudo expira. */
function semear(hub: Hub, sessoes: number, eventosPorSessao: number, bytesDeRaw: number): void {
  const projeto = hub.store.projects.create({
    name: `p-${Math.random()}`,
    path: path.join(raiz, `proj-${Math.random()}`),
    defaultBranch: 'main',
  });
  hub.store.transaction(() => {
    for (let s = 0; s < sessoes; s += 1) {
      const id = `ses_esp${s}${Math.random().toString(36).slice(2, 8)}`;
      const sessao: Session = {
        id,
        projectId: projeto.id,
        agentId: 'claude',
        nativeSessionId: null,
        rootId: id,
        parentId: null,
        depth: 0,
        path: [],
        state: 'completed',
        mode: 'semi',
        isolation: 'none',
        workdir: raiz,
        title: null,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        endedAt: '2020-01-02T00:00:00.000Z',
        pid: null,
      };
      hub.store.sessions.create(sessao);
      for (let e = 0; e < eventosPorSessao; e += 1) {
        hub.store.events.append({
          id: `evt_${id}_${e}`,
          seq: e + 1,
          ts: '2020-01-01T00:00:00.000Z',
          sessionId: id,
          taskId: null,
          agentId: 'claude',
          type: 'message',
          payload: { text: 'ok' },
          cost: null,
          raw: { linha: 'r'.repeat(bytesDeRaw) },
        });
      }
    }
  });
}

describe('retenção devolve espaço ao sistema de arquivos (R09-07)', () => {
  test('banco novo: a passada de compactação encolhe o arquivo no disco', async () => {
    const { hub, dbFile } = montar('novo');
    try {
      semear(hub, 20, 50, 6000);
      const antes = bytesNoDisco(dbFile);
      const resultado = await hub.eventRetention.compact(new Date('2100-01-01T00:00:00.000Z'));
      const depois = bytesNoDisco(dbFile);

      assert.equal(resultado.rowsCompacted, 1000);
      // Sem devolução, o `.db` fica do mesmo tamanho e o `-wal` ainda cresce
      // com os UPDATEs: `depois` passava de `antes`.
      assert.ok(
        depois < antes / 2,
        `esperava o disco abaixo da metade: antes ${antes} B, depois ${depois} B`,
      );
    } finally {
      await hub.shutdown();
    }
  });

  test('banco antigo (sem auto_vacuum): a subida do daemon converte, e a retenção passa a devolver', async () => {
    const home = path.join(raiz, 'antigo');
    mkdirSync(home, { recursive: true });
    // Banco de antes da correção: nasce com uma tabela e SEM `auto_vacuum`,
    // exatamente o que um Hub antigo deixou no disco.
    const legado = new DatabaseSync(path.join(home, 'hub.db'));
    legado.exec('PRAGMA journal_mode = WAL; CREATE TABLE legado_marcador (x INTEGER);');
    legado.close();
    assert.equal(autoVacuumNoDisco(path.join(home, 'hub.db')), 0);

    const manifestos = path.join(home, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    const hub = createHub({ home, manifestsDir: manifestos, port: 0 });
    try {
      await hub.start();
      // `start()` dispara a passada da largada; espera por ela (`compact`
      // devolve a passada em curso) para a próxima enxergar os eventos abaixo.
      await hub.eventRetention.compact();
      semear(hub, 10, 50, 6000);
      const antes = bytesNoDisco(hub.config.dbFile);
      await hub.eventRetention.compact(new Date('2100-01-01T00:00:00.000Z'));
      assert.ok(
        bytesNoDisco(hub.config.dbFile) < antes / 2,
        'depois de convertido, a retenção devolve espaço também no banco antigo',
      );
    } finally {
      await hub.shutdown();
    }
    assert.equal(autoVacuumNoDisco(path.join(home, 'hub.db')), 2, 'auto_vacuum = INCREMENTAL');
  });
});

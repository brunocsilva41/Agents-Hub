import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { UnitOfWork } from '@agents-hub/core';
import type { RetentionPolicy } from './config.js';
import { WorktreeReaper } from './reaper.js';
import type { WorktreeManager } from './worktree.js';

/**
 * Regras de decisão do `WorktreeReaper` (item 7.1 do GOAL). O caminho com git
 * de verdade — remover sem atravessar o `node_modules` ligado — já está em
 * `worktree-links.test.ts`; aqui o `WorktreeManager` é falso e o que se mede é
 * QUEM o reaper manda remover: só sessão encerrada, isolada em worktree, com
 * checkout ainda no disco e fora da janela de retenção. Remover cedo demais é
 * apagar o estado que o usuário ainda queria inspecionar.
 */

interface SessaoFalsa {
  id: string;
  projectId: string;
  isolation: 'worktree' | 'none';
  workdir: string;
  endedAt: string | null;
}

const AGORA = new Date('2026-01-10T00:00:00.000Z');
const DIA = 24 * 60 * 60 * 1000;
const RETENCAO = { worktreeDays: 3, sweepIntervalMinutes: 60 } as RetentionPolicy;

function atras(dias: number): string {
  return new Date(AGORA.getTime() - dias * DIA).toISOString();
}

function montar(
  sessoes: SessaoFalsa[],
  opts: { falhaEm?: string; projetos?: Record<string, string> } = {},
) {
  const liberados: string[] = [];
  const podados: string[] = [];
  const projetos = opts.projetos ?? { prj_1: '/repo' };
  const store = {
    sessions: { list: () => sessoes },
    projects: { get: (id: string) => (projetos[id] ? { id, path: projetos[id] } : null) },
  } as unknown as UnitOfWork;
  const manager = {
    release: async ({ worktreePath }: { projectPath: string; worktreePath: string }) => {
      liberados.push(worktreePath);
      if (worktreePath === opts.falhaEm) return { removed: false, reason: 'arquivo em uso' };
      return { removed: true };
    },
    prune: async (projectPath: string) => {
      podados.push(projectPath);
    },
  } as unknown as WorktreeManager;
  return { reaper: new WorktreeReaper(store, manager, RETENCAO), liberados, podados };
}

describe('WorktreeReaper.sweep — quem é recolhido', () => {
  let raiz: string;
  const dirs: Record<string, string> = {};

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-reaper-'));
    for (const nome of ['expirado', 'recente', 'viva', 'semiso', 'orfa', 'falha']) {
      dirs[nome] = path.join(raiz, nome);
      mkdirSync(dirs[nome]!);
    }
  });

  after(() => {
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  test('só remove sessão encerrada, isolada, no disco e fora da retenção', async () => {
    const sessao = (id: string, extra: Partial<SessaoFalsa>): SessaoFalsa => ({
      id,
      projectId: 'prj_1',
      isolation: 'worktree',
      workdir: dirs[id] ?? path.join(raiz, id),
      endedAt: atras(10),
      ...extra,
    });
    const { reaper, liberados, podados } = montar([
      sessao('expirado', {}),
      sessao('recente', { endedAt: atras(1) }),
      sessao('viva', { endedAt: null }),
      sessao('semiso', { isolation: 'none' }),
      sessao('sumiu', {}), // checkout já não existe no disco
      sessao('orfa', { projectId: 'prj_apagado' }),
    ]);

    const r = await reaper.sweep(AGORA);

    assert.deepEqual(liberados, [dirs['expirado']], 'nada além do expirado vai para o release');
    assert.deepEqual(r.removed, [dirs['expirado']]);
    assert.equal(r.retained, 1, 'o recente fica pela janela de retenção');
    // viva e sem isolamento nem entram na conta; sumiu e órfã são examinadas.
    assert.equal(r.examined, 4);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(podados, ['/repo'], 'prune roda para o projeto do que foi tentado');
  });

  test('o limite é inclusivo do lado de quem expirou: exatamente na borda ainda remove', async () => {
    const { reaper } = montar([
      { id: 'b', projectId: 'prj_1', isolation: 'worktree', workdir: dirs['expirado']!, endedAt: atras(3) },
    ]);
    const r = await reaper.sweep(AGORA);
    assert.deepEqual(r.removed, [dirs['expirado']]);
  });

  test('remoção que falha vira `failed` com o motivo (não `retained`) e o prune roda mesmo assim', async () => {
    const erros: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void erros.push(a.join(' '));
    try {
      const { reaper, podados } = montar(
        [{ id: 'f', projectId: 'prj_1', isolation: 'worktree', workdir: dirs['falha']!, endedAt: atras(9) }],
        { falhaEm: dirs['falha']! },
      );
      const r = await reaper.sweep(AGORA);
      assert.deepEqual(r.failed, [{ path: dirs['falha'], reason: 'arquivo em uso' }]);
      assert.deepEqual(r.removed, []);
      assert.equal(r.retained, 0);
      assert.deepEqual(podados, ['/repo']);
      assert.ok(erros.some((e) => String(e).includes('arquivo em uso')), 'falha real é logada');
    } finally {
      console.error = original;
    }
  });
});

describe('WorktreeReaper.start/stop', () => {
  test('start varre na largada, é idempotente, e stop desliga o timer', async () => {
    let varreduras = 0;
    const store = {
      sessions: {
        list: () => {
          varreduras += 1;
          return [];
        },
      },
      projects: { get: () => null },
    } as unknown as UnitOfWork;
    const reaper = new WorktreeReaper(store, {} as WorktreeManager, RETENCAO);
    reaper.start();
    reaper.start(); // segunda chamada não cria outro timer nem outra varredura
    await new Promise((r) => setImmediate(r));
    assert.equal(varreduras, 1);
    reaper.stop();
    reaper.stop(); // parar duas vezes não lança
  });
});

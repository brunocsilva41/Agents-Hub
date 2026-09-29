import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { newId, nowIso, type Session } from '@agents-hub/core';
import { HubApiError } from './client.js';
import { capturar, comTeto, esperar, montarHubDeTeste, type HubDeTeste } from './hub-de-teste.js';
import { budgetCommand, graphCommand, sendCommand, watchCommand } from './session-follow.js';

/**
 * Item 5.2 do GOAL (vistoria 2026-09-25, 07 e 14): `watch`/`budget`/`graph`
 * com id inexistente, `watch --root` de fluxo terminado e `send` após
 * `pause` — contra um daemon REAL isolado, com agentes falsos.
 */

const args = (command: string, positional: string[], flags: Record<string, string | boolean> = {}) => ({
  command,
  positional,
  flags,
});

describe('hub watch/budget/graph/send (CLI)', () => {
  let h: HubDeTeste;
  let projectId: string;

  before(async () => {
    h = await montarHubDeTeste([
      { id: 'ok', modo: 'ok' },
      { id: 'dorminhoco', modo: 'dorme-uma-vez' },
    ]);
    projectId = h.hub.sessions.registerProject(h.projeto, 'projeto-follow').id;
  });

  after(async () => {
    await h.encerrar();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  test('watch de id inexistente: erro SESSION_NOT_FOUND na hora, com dica — não pendura', async () => {
    const c = capturar();
    await assert.rejects(
      comTeto(
        watchCommand(h.client, args('watch', ['ses_naoexiste']), { log: c.log, pollMs: 50 }),
        5000,
        'hub watch',
      ),
      (err: unknown) =>
        err instanceof HubApiError &&
        err.code === 'SESSION_NOT_FOUND' &&
        /hub sessions/.test(err.message),
    );
    // id malformado cai no mesmo erro claro (antes: stream mudo para sempre)
    await assert.rejects(
      comTeto(
        watchCommand(h.client, args('watch', ['zzz']), { log: c.log, pollMs: 50 }),
        5000,
        'hub watch zzz',
      ),
      /não encontrada/,
    );
    await assert.rejects(
      comTeto(
        watchCommand(h.client, args('watch', [], { root: 'ses_naoexiste' }), { log: c.log, pollMs: 50 }),
        5000,
        'watch --root',
      ),
      /não encontrada/,
    );
  });

  test('budget/graph de id inexistente: erro 404 claro (antes: zeros e "nenhuma sessão")', async () => {
    const c = capturar();
    await assert.rejects(
      budgetCommand(h.client, args('budget', ['ses_naoexiste']), { log: c.log }),
      /não encontrada/,
    );
    await assert.rejects(
      graphCommand(h.client, args('graph', ['ses_naoexiste']), { log: c.log }),
      /não encontrada/,
    );
    assert.equal(c.linhas.length, 0, 'nada de barra 0% nem "nenhuma sessão"');
    // E o daemon responde 404 direto (MCP e Web usam a mesma rota).
    await assert.rejects(
      h.client.budget('ses_naoexiste'),
      (e: unknown) => e instanceof HubApiError && e.status === 404,
    );
    await assert.rejects(
      h.client.graph('ses_naoexiste'),
      (e: unknown) => e instanceof HubApiError && e.status === 404,
    );
  });

  test('budget/graph de sessão FILHA usam a raiz do fluxo e avisam', async () => {
    const raiz = semear('completed', null);
    const filho = semear('completed', raiz);
    const c = capturar();
    await graphCommand(h.client, args('graph', [filho.id]), { log: c.log });
    assert.match(c.texto(), new RegExp(`sessão filha; usando o fluxo da raiz ${raiz.id}`));
    assert.match(c.texto(), /total do fluxo/);
  });

  test('watch --root de fluxo JÁ terminado devolve o terminal (antes: pendurava sem saída)', async () => {
    const { session, task } = await h.client.startSession({
      projectId,
      brief: { agent: 'ok', objective: 'responda com a palavra OK', isolation: 'none' },
    });
    await esperar(() => h.hub.store.tasks.get(task.id)?.state === 'completed', 'task concluir');

    const c = capturar();
    const d = await comTeto(
      watchCommand(h.client, args('watch', [], { root: session.id }), {
        log: c.log,
        logErro: c.logErro,
        pollMs: 50,
      }),
      8000,
      'hub watch --root',
    );
    assert.equal(d.estado, 'completed');
    assert.match(c.texto(), /o fluxo já terminou/);
    assert.equal(process.exitCode, undefined);
  });

  test('send após pause mostra a resposta NOVA (antes: parava no evento terminal antigo)', async () => {
    const { session } = await h.client.startSession({
      projectId,
      brief: { agent: 'dorminhoco', objective: 'faça algo demorado aqui', isolation: 'none' },
    });
    await esperar(() => h.hub.sessions.isLive(session.id), 'processo subir');
    // "Processo vivo" não basta: no Linux o spawn volta antes de o Node do
    // agente falso rodar a 1ª linha. Pausado aí, a execução morta não conta,
    // e a do `send` vira a "1ª" — que dorme, e o send pendura. Espera o
    // agente registrar a execução (o contador do `dorme-uma-vez`).
    const contador = path.join(h.raiz, 'dorminhoco.count');
    await esperar(() => existsSync(contador), 'agente falso começar a 1ª execução');
    await h.client.pause(session.id);
    // O pause é real (item 2.2): o turno termina, a sessão fica `paused` e a
    // task aberta — e o histórico ganha o `turn.completed` do turno
    // interrompido, que é o "terminal antigo" que confundia o send.
    await esperar(() => h.hub.store.sessions.get(session.id)?.state === 'paused', 'sessão pausar');
    const antigos = h.hub.store.events.list({ sessionId: session.id, limit: 500 });
    assert.ok(
      antigos.some(
        (e) => e.type === 'error' || e.type === 'session.ended' || e.type === 'turn.completed',
      ),
      'o histórico precisa ter o evento terminal antigo que confundia o send',
    );

    const c = capturar();
    const d = await comTeto(
      sendCommand(h.client, args('send', [session.id, 'continue', 'por', 'favor']), {
        log: c.log,
        logErro: c.logErro,
        pollMs: 50,
      }),
      15_000,
      'hub send',
    );
    assert.match(c.texto(), /RESPOSTA-NOVA/, `a resposta nova precisa aparecer:\n${c.texto()}`);
    assert.equal(d?.estado, 'completed');
  });

  function semear(state: Session['state'], pai: Session | null): Session {
    const id = newId('ses');
    const session: Session = {
      id,
      projectId,
      agentId: 'ok',
      parentId: pai?.id ?? null,
      rootId: pai?.rootId ?? id,
      depth: pai ? pai.depth + 1 : 0,
      path: [`ok:${id}`],
      state,
      mode: 'semi',
      isolation: 'none',
      workdir: h.projeto,
      nativeSessionId: null,
      title: 'semeada',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: nowIso(),
      pid: null,
    };
    h.hub.store.sessions.create(session);
    return session;
  }
});

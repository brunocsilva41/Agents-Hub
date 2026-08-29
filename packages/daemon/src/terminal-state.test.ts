import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newId, nowIso, type Session, type SessionState } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * Estado terminal é imutável.
 *
 * Medido contra o daemon real, numa sessão que havia concluído com sucesso:
 *
 *   POST /sessions/:id/pause    -> {ok:true}, estado vira `paused`
 *   POST /sessions/:id/cancel   -> {ok:true}, estado vira `killed`
 *
 * Uma sessão bem-sucedida podia ser reescrita como morta na auditoria. E a
 * ressurreição encadeava: `paused` aceita resume, o resume rodou, falhou, o
 * pipeline de resiliência concluiu "falha permanente" e trocou o agente — tudo
 * sobre uma conversa que já tinha terminado bem.
 *
 * A causa era simples e típica: o invariante estava escrito à mão em `send` e
 * `handoff`, e esquecido em `pause`, `cancel` e `delegate`.
 */
describe('estado terminal de sessão', () => {
  let hub: Hub;
  let raiz: string;
  let projectId: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-terminal-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    hub = createHub({ home: raiz, manifestsDir: manifestos, webRoot: path.join(raiz, 'sem-web') });
    projectId = hub.sessions.registerProject(raiz, 'projeto-terminal').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function semear(state: SessionState): Session {
    const id = newId('ses');
    const session: Session = {
      id,
      projectId,
      agentId: 'claude',
      parentId: null,
      rootId: id,
      depth: 0,
      path: [`claude:${id}`],
      state,
      mode: 'semi',
      isolation: 'none',
      workdir: raiz,
      nativeSessionId: null,
      title: 'sessão de teste',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: state === 'running' ? null : nowIso(),
    };
    hub.store.sessions.create(session);
    return session;
  }

  for (const estado of ['completed', 'failed', 'killed'] as const) {
    test(`pause é recusado em sessão ${estado}`, async () => {
      const s = semear(estado);
      await assert.rejects(() => hub.sessions.pause(s.id), /já terminou/i);
      // E o estado NÃO pode ter mudado: era isto que resgatava a sessão.
      assert.equal(hub.store.sessions.get(s.id)?.state, estado);
    });

    test(`cancel é recusado em sessão ${estado}`, async () => {
      const s = semear(estado);
      await assert.rejects(() => hub.sessions.cancel(s.id), /já terminou/i);
      assert.equal(hub.store.sessions.get(s.id)?.state, estado);
    });

    test(`delegar a partir de sessão ${estado} é recusado`, async () => {
      const pai = semear(estado);
      await assert.rejects(
        () =>
          hub.sessions.start({
            projectId,
            agentId: '',
            brief: { agent: 'claude', objective: 'tarefa qualquer para o teste de borda' },
            requesterSessionId: pai.id,
          }),
        /já terminou/i,
      );
    });
  }

  test('cancelar sessão VIVA continua funcionando', async () => {
    // A correção não pode fechar o caminho legítimo.
    const s = semear('running');
    await hub.sessions.cancel(s.id);
    assert.equal(hub.store.sessions.get(s.id)?.state, 'killed');
  });

  test('cancelar pai não quebra por causa de filho já terminado', async () => {
    // O cancelamento desce pela subárvore, e é normal encontrar filho já
    // encerrado. Tratar isso como erro impediria o usuário de cancelar um
    // fluxo onde um ramo já acabou.
    const pai = semear('running');
    const filhoId = newId('ses');
    hub.store.sessions.create({
      ...semear('completed'),
      id: filhoId,
      parentId: pai.id,
      rootId: pai.rootId,
      depth: 1,
    });
    await hub.sessions.cancel(pai.id);
    assert.equal(hub.store.sessions.get(pai.id)?.state, 'killed');
    assert.equal(hub.store.sessions.get(filhoId)?.state, 'completed');
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newId, nowIso, type Session } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * `interrupt` sobre sessão que não existe, ou que existe sem turno rodando.
 *
 * A versão anterior consultava o mapa de runs vivas ANTES de validar a sessão e
 * saía calada quando não achava nada. `POST /sessions/ses_naoexiste/interrupt`
 * respondia `{ok:true}` com 200 — sucesso relatado sobre coisa nenhuma, e
 * divergente de `cancel` e `pause`, que devolviam 404 para o mesmo id.
 *
 * É a classe de defeito mais perigosa deste sistema: não quebra nada visível,
 * apenas ensina o usuário a confiar num botão que não fez nada.
 */
describe('interromper turno', () => {
  let hub: Hub;
  let raiz: string;
  let projectId: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-interrupt-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    hub = createHub({ home: raiz, manifestsDir: manifestos, webRoot: path.join(raiz, 'sem-web') });
    projectId = hub.sessions.registerProject(raiz, 'projeto-interrupt').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function semearSessao(): Session {
    const id = newId('ses');
    const session: Session = {
      id,
      projectId,
      agentId: 'claude',
      parentId: null,
      rootId: id,
      depth: 0,
      state: 'running',
      mode: 'semi',
      isolation: 'none',
      workdir: raiz,
      nativeSessionId: null,
      path: [`claude:${id}`],
      title: 'sessão de teste',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      pid: null,
    };
    hub.store.sessions.create(session);
    return session;
  }

  test('sessão inexistente é ERRO, não sucesso silencioso', async () => {
    await assert.rejects(
      () => hub.sessions.interrupt('ses_naoexiste'),
      (erro: Error) => {
        // Mesmo tratamento que `cancel` e `pause` já davam.
        assert.match(String(erro.message), /não encontrada/i);
        return true;
      },
    );
  });

  test('sessão real sem turno rodando devolve false, não true', async () => {
    const session = semearSessao();
    const interrompeu = await hub.sessions.interrupt(session.id);
    // Não é erro — a sessão existe. Mas nada foi interrompido, e quem clicou
    // precisa saber disso, senão o botão parece ter funcionado.
    assert.equal(interrompeu, false);
  });
});

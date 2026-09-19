import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, newId, nowIso, type Approval, type Session } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

const SCRIPT_AGENTE = `
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
process.stdout.write('AGENTE OK\\n');
process.exit(0);
`;

/**
 * Regressão dos dois achados críticos de uma auditoria de segurança sobre
 * `session-manager.ts` (ambos confirmados por leitura de código):
 *
 * 1. TOCTOU no teto de concorrência: `#assertConcurrency` só lia `#runs`, e a
 *    escrita real só acontecia dentro de `#launch`, depois de vários `await`.
 *    Um fan-out (`Promise.all`) para o mesmo agente furava o teto de verdade.
 *
 * 2. `resolveApproval` ressuscitava sessão terminal: escrevia
 *    `state: 'running'` incondicionalmente e só DEPOIS relia o banco para
 *    checar terminalidade — checagem morta por construção, porque sempre lia
 *    de volta o que acabara de escrever.
 */
describe('auditoria: concorrência e resolveApproval (achados críticos)', () => {
  let raiz: string;
  let hub: Hub;
  let manifestos: string;
  let projetoPath: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-auditoria-'));
    manifestos = path.join(raiz, 'manifests');
    projetoPath = path.join(raiz, 'projeto');
    const script = path.join(raiz, 'agente.cjs');

    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });
    writeFileSync(script, SCRIPT_AGENTE, 'utf8');

    writeFileSync(
      path.join(manifestos, 'agente-x.yaml'),
      `
id: agente-x
name: agente-x
vendor: Test
description: Agente de teste para auditoria
bin: node
invoke:
  oneShot: ["${script.replace(/\\/g, '\\\\')}"]
  interactive: false
detect:
  args: ["${script.replace(/\\/g, '\\\\')}", "--version"]
capabilities:
  - code-edit
session:
  strategy: replay
stream:
  format: text
  mapper: generic-text
defaults:
  isolation: none
  timeoutSeconds: 30
`,
      'utf8',
    );

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      policy: {
        ...DEFAULT_POLICY,
        watch: { pauseOn: [], flagOn: [] },
        maxConcurrency: 10,
        maxConcurrencyPerAgent: 1,
      },
    });
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  test('achado 1: fan-out concorrente para o mesmo agente não fura o teto', async () => {
    const proj = hub.sessions.registerProject(projetoPath, 'Teste Concorrência');

    const brief = {
      agent: 'agente-x',
      objective: 'tarefa concorrente de teste',
      acceptanceCriteria: [],
      constraints: [],
      budget: {},
      isolation: 'none' as const,
      supervision: 'semi' as const,
    };

    // Cinco chamadas disparadas SEM esperar uma pela outra — o padrão de
    // fan-out (`Promise.all`) que a auditoria encontrou furando o teto.
    // Como as cinco rodam sincronamente até o primeiro `await` de cada uma
    // (dentro de `start()`, isso é depois da checagem-e-reserva), a corrida
    // é exercitada de forma determinística, sem precisar de um agente lento.
    const resultados = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        hub.sessions.start({ projectId: proj.id, agentId: 'agente-x', brief }),
      ),
    );

    const sucesso = resultados.filter((r) => r.status === 'fulfilled');
    const recusados = resultados.filter((r) => r.status === 'rejected');

    // Com o teto por agente em 1, no máximo uma das cinco pode ter conseguido
    // a vaga — antes da correção, era rotineiro ver as cinco passarem, todas
    // lendo `#runs.size === 0` antes de qualquer uma escrever nele.
    assert.equal(sucesso.length, 1, 'apenas uma tentativa deveria conseguir a vaga de concorrência');
    assert.equal(recusados.length, 4);
    for (const r of recusados) {
      if (r.status === 'rejected') {
        assert.match(String((r.reason as Error)?.message ?? r.reason), /Limite de 1 sess(õ|ã)es? simultâneas/);
      }
    }
  });

  test('achado 2a: aprovar uma sessão já terminal não a ressuscita', async () => {
    const proj = hub.sessions.registerProject(
      path.join(raiz, 'projeto-2a'),
      'Teste Aprovação Terminal',
    );
    mkdirSync(proj.path, { recursive: true });

    const sessionId = newId('ses');
    const session: Session = {
      id: sessionId,
      projectId: proj.id,
      agentId: 'agente-x',
      nativeSessionId: null,
      rootId: sessionId,
      parentId: null,
      depth: 0,
      path: [`agente-x:${sessionId}`],
      state: 'waiting_approval',
      mode: 'semi',
      isolation: 'none',
      workdir: proj.path,
      title: 'sessão de teste',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      pid: null,
    };
    hub.store.sessions.create(session);

    const approval: Approval = {
      id: newId('apv'),
      sessionId,
      taskId: null,
      risk: 'write',
      action: 'ação de teste em espera de aprovação',
      detail: { kind: 'watch', reason: 'teste', eventType: 'command.executed', alreadyExecuted: true },
      state: 'pending',
      requestedAt: nowIso(),
      resolvedAt: null,
      resolvedBy: null,
    };
    hub.store.approvals.create(approval);

    // Simula o cenário do achado: a sessão morreu por um caminho que não
    // passou por `resolveApproval` (aqui, forçado diretamente no banco, para
    // isolar a checagem de terminalidade da correção da causa-raiz do
    // achado 2b, testada abaixo) enquanto a aprovação ainda ficou `pending`.
    hub.store.sessions.update(sessionId, { state: 'killed', endedAt: nowIso() });

    const resolved = await hub.sessions.resolveApproval(approval.id, 'approved', 'teste');

    // A decisão é registrada — só não há para onde retomar.
    assert.equal(resolved.state, 'approved');

    // O ponto central do achado: a sessão NÃO pode voltar para `running`.
    const depois = hub.store.sessions.get(sessionId);
    assert.equal(depois?.state, 'killed', 'sessão terminal não pode ser ressuscitada para running');
    assert.equal(hub.sessions.isLive(sessionId), false, 'nenhuma run nova pode ter sido lançada');
  });

  test('achado 2b: cancelar a sessão nega a aprovação pendente (fecha a causa-raiz)', async () => {
    const proj = hub.sessions.registerProject(
      path.join(raiz, 'projeto-2b'),
      'Teste Aprovação Órfã',
    );
    mkdirSync(proj.path, { recursive: true });

    const sessionId = newId('ses');
    const session: Session = {
      id: sessionId,
      projectId: proj.id,
      agentId: 'agente-x',
      nativeSessionId: null,
      rootId: sessionId,
      parentId: null,
      depth: 0,
      path: [`agente-x:${sessionId}`],
      state: 'waiting_approval',
      mode: 'semi',
      isolation: 'none',
      workdir: proj.path,
      title: 'sessão de teste',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      pid: null,
    };
    hub.store.sessions.create(session);

    const approval: Approval = {
      id: newId('apv'),
      sessionId,
      taskId: null,
      risk: 'write',
      action: 'ação de teste em espera de aprovação',
      detail: { kind: 'watch', reason: 'teste', eventType: 'command.executed', alreadyExecuted: true },
      state: 'pending',
      requestedAt: nowIso(),
      resolvedAt: null,
      resolvedBy: null,
    };
    hub.store.approvals.create(approval);

    // Cenário concreto do achado: a sessão-filha está em `waiting_approval` e
    // alguém cancela ANTES de a aprovação ser resolvida — `cancel()` mata
    // sessões `running` OU `waiting_approval`, mas `#finish` antes não tocava
    // a tabela de aprovações, deixando esta `pending` e órfã.
    await hub.sessions.cancel(sessionId, 'cancelado pelo teste');

    const approvalDepois = hub.store.approvals.get(approval.id);
    assert.equal(
      approvalDepois?.state,
      'denied',
      '#finish deve negar/expirar aprovações pendentes da sessão que está sendo encerrada',
    );

    // E, por consequência, resolvê-la de novo agora é recusado de cara —
    // `resolveApproval` nem chega perto de tentar relançar um processo.
    await assert.rejects(
      () => hub.sessions.resolveApproval(approval.id, 'approved', 'teste tardio'),
      /já foi denied/i,
    );
    assert.equal(hub.store.sessions.get(sessionId)?.state, 'killed');
    assert.equal(hub.sessions.isLive(sessionId), false);
  });
});

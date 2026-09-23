import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  DEFAULT_POLICY,
  isHubError,
  newId,
  nowIso,
  type Approval,
  type HubError,
  type Session,
  type Task,
} from '@agents-hub/core';
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

/**
 * Regressão de dívida conhecida (não um bug): `BudgetLedger.reserve`/`settle`
 * não tinham teste de concorrência, embora a invariante que os protege já
 * exista em código — `session-manager.ts#start` faz a leitura do saldo
 * (`ledger.snapshot()`) e a reserva (`ledger.reserve()`) como uma única
 * operação síncrona, sem `await` entre elas (comentário explícito por volta
 * da linha 482-486). Uma auditoria de carga anterior já confirmou isso por
 * HTTP real contra o daemon (20 `POST /sessions` verdadeiramente
 * concorrentes via `Promise.all`, orçamento US$10, pedido total US$20:
 * exatamente 10/20 aceitas, sem corrida). Este teste fixa essa invariante
 * como regressão automatizada, no mesmo estilo do achado 1 acima
 * (`Promise.allSettled` sem esperar uma chamada pela outra) — mas roda num
 * único processo Node, então exercita a reserva síncrona simulada, não
 * múltiplos processos batendo no daemon real como a auditoria por HTTP fez.
 * Se um `await` for inserido no futuro entre a leitura e a reserva, este
 * teste passa a falhar (mais de uma reserva furando o teto).
 */
describe('auditoria: concorrência do BudgetLedger (dívida conhecida, agora com regressão)', () => {
  let raiz: string;
  let hub: Hub;
  let manifestos: string;
  let projetoPath: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-auditoria-budget-'));
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
description: Agente de teste para auditoria de orçamento
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
        // Altos o bastante para NÃO serem o gargalo deste teste — quem tem
        // que decidir aceitar/recusar aqui é o orçamento, não o teto de
        // concorrência (esse já tem regressão própria no achado 1 acima).
        maxConcurrency: 50,
        maxConcurrencyPerAgent: 50,
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

  test('N chamadas concorrentes de delegação contra orçamento insuficiente: soma aceita nunca excede a raiz, sobra recusada com BUDGET_EXCEEDED', async () => {
    const proj = hub.sessions.registerProject(projetoPath, 'Teste Orçamento Concorrente');

    // Sessão-raiz "viva" (running), criada direto no store — não precisamos
    // de um processo real rodando para exercitar a reserva de orçamento dos
    // filhos, só que o pai não esteja em estado terminal.
    const rootId = newId('ses');
    const root: Session = {
      id: rootId,
      projectId: proj.id,
      agentId: 'agente-x',
      nativeSessionId: null,
      rootId,
      parentId: null,
      depth: 0,
      path: [`agente-x:${rootId}`],
      state: 'running',
      mode: 'semi',
      isolation: 'none',
      workdir: proj.path,
      title: 'sessão-raiz de teste',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      pid: null,
    };
    hub.store.sessions.create(root);

    const LIMITE_USD = 10;
    hub.store.budgets.ensure(rootId, { usd: LIMITE_USD, tokens: 1_000_000, seconds: 3600 });

    const TOTAL_CHAMADAS = 20;
    const PEDIDO_USD_CADA = 1;
    // 10 cabem exatamente no teto de 10; as outras 10 têm que ser recusadas.
    const ESPERADO_ACEITAS = LIMITE_USD / PEDIDO_USD_CADA;

    const brief = {
      agent: 'agente-x',
      objective: 'delegação concorrente de teste de orçamento',
      acceptanceCriteria: [],
      constraints: [],
      budget: { usd: PEDIDO_USD_CADA },
      isolation: 'none' as const,
      supervision: 'semi' as const,
    };

    // Disparadas SEM esperar uma pela outra — mesmo padrão do achado 1: como
    // cada `start()` roda sincronamente até seu primeiro `await` (que vem
    // DEPOIS da checagem-e-reserva de orçamento), a corrida é exercitada de
    // forma determinística.
    const resultados = await Promise.allSettled(
      Array.from({ length: TOTAL_CHAMADAS }, () =>
        hub.sessions.start({
          projectId: proj.id,
          agentId: 'agente-x',
          requesterSessionId: rootId,
          brief,
        }),
      ),
    );

    const aceitas = resultados.filter((r) => r.status === 'fulfilled');
    const recusadas = resultados.filter((r) => r.status === 'rejected');

    assert.equal(
      aceitas.length,
      ESPERADO_ACEITAS,
      `esperava exatamente ${ESPERADO_ACEITAS} aceitas (US$${LIMITE_USD} / US$${PEDIDO_USD_CADA} cada), veio ${aceitas.length}`,
    );
    assert.equal(recusadas.length, TOTAL_CHAMADAS - ESPERADO_ACEITAS);

    for (const r of recusadas) {
      if (r.status === 'rejected') {
        const err = r.reason;
        assert.ok(isHubError(err), 'recusa por orçamento tem que ser um HubError');
        assert.equal((err as HubError).code, 'BUDGET_EXCEEDED');
      }
    }

    // Invariante central do achado: o que foi de fato aceito nunca pode
    // exceder o orçamento da raiz — nem em `reserved`, nem depois de somado
    // a `consumed`. Isto é o que a reserva síncrona (achado real) garante, e
    // é robusto independente de quando cada processo termina.
    const snapshot = hub.store.budgets.get(rootId);
    assert.ok(snapshot, 'orçamento da raiz precisa existir depois das chamadas');
    const usadoTotal = (snapshot?.consumed.usd ?? 0) + (snapshot?.reserved.usd ?? 0);
    assert.ok(
      usadoTotal <= LIMITE_USD,
      `consumed+reserved (${usadoTotal}) não pode exceder o limite da raiz (${LIMITE_USD})`,
    );
    // NENHUMA asserção de igualdade exata sobre `usadoTotal` daqui em diante:
    // `SCRIPT_AGENTE` sai quase instantaneamente com "AGENTE OK" e nenhum
    // evento de custo. `#launch` só espera o processo SUBIR
    // (`adapter.start`), não terminar; o `#pump` que drena o resto roda
    // solto (fire-and-forget) e pode `settle()` — devolvendo a reserva não
    // usada, já que o custo real ficou em US$0 — em qualquer momento entre o
    // spawn e esta leitura, para qualquer subconjunto das 10 tarefas
    // aceitas. Medido rodando a suíte localmente 10 vezes seguidas: o valor
    // observado variou entre US$8 e US$10, sem padrão fixo — é uma corrida
    // real e inofensiva entre o teste e o próprio agente-de-mentira
    // terminando rápido demais, não a reserva síncrona que este achado
    // prova (essa already está provada por `aceitas.length` acima, que
    // permaneceu em exatamente 10 em todas as 10 rodadas). Uma versão
    // anterior deste teste exigia igualdade exata e depois uma faixa
    // estreita (10 ou 9) — as duas derrubaram o CI de forma intermitente
    // sem relação com nenhuma mudança de código real.
  });
});

/**
 * Regressão do achado 2 (ALTO) de uma auditoria posterior sobre
 * `session-manager.ts`: dentro de `#fallback`, a criação da sessão
 * substituta (`this.store.sessions.create(replacement)`) e a reatribuição da
 * task a ela (`this.store.tasks.update(task.id, { sessionId, attempts })`)
 * eram duas escritas separadas, fora de `this.store.transaction(...)`. Um
 * crash exatamente entre as duas deixava a task com `sessionId` apontando
 * para a sessão ANTIGA (já terminal) e criava uma sessão substituta órfã,
 * que nunca é revisitada por `reconcileOnStartup` (só olha sessões
 * `running`/`waiting_approval`) — vazamento silencioso permanente.
 *
 * Simula o "crash no meio" sem precisar matar o processo de verdade:
 * monkeypatch em `store.tasks.update` faz a PRIMEIRA chamada que carrega
 * `sessionId` no patch (a exata reatribuição de `#fallback`; a atualização de
 * `attempts` antes da troca de agente não carrega essa chave) lançar. Isso
 * exercita o mesmo `catch`/`ROLLBACK` de `UnitOfWork.transaction` que uma
 * queda real do processo forçaria.
 */
describe('auditoria: #fallback cria sessão substituta e reatribui task atomicamente (achado 2)', () => {
  let raiz: string;
  let hub: Hub;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-auditoria-fallback-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      policy: { ...DEFAULT_POLICY, watch: { pauseOn: [], flagOn: [] } },
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

  /**
   * `#fallback` é um método privado de verdade (campo `#`, privacidade
   * imposta pelo runtime) — não há como chamá-lo diretamente de fora para
   * testar via a "porta da frente". Disparar o cenário pelo pipeline
   * completo (processo real falhando → retry → fallback) tampouco funciona
   * aqui: `#pump` roda solto (`void this.#pump(...)`, só com `.finally`, sem
   * `.catch` — ver `packages/daemon/src/safety-net.ts`), então o crash
   * simulado vira uma `unhandledRejection` que o test runner do Node atribui
   * ao teste em execução e reprova, independente de qualquer listener
   * próprio.
   *
   * Por isso este teste replica, de forma síncrona e determinística, a
   * MESMA sequência de escritas que `#fallback` faz (linhas ~1943-1958 de
   * `session-manager.ts`): `sessions.create(replacement)` seguido de
   * `tasks.update(task.id, { sessionId, attempts })`, através do MESMO
   * `hub.store.transaction(...)` — o mesmo repositório, o mesmo primitivo de
   * transação, só sem a burocracia de spawnar processos de verdade.
   */
  test('crash simulado entre criar a sessão substituta e reatribuir a task não deixa sessão órfã', () => {
    const proj = hub.sessions.registerProject(path.join(raiz, 'projeto'), 'Teste Fallback Atômico');
    mkdirSync(proj.path, { recursive: true });

    const originalSessionId = newId('ses');
    const originalSession: Session = {
      id: originalSessionId,
      projectId: proj.id,
      agentId: 'flaky',
      nativeSessionId: null,
      rootId: originalSessionId,
      parentId: null,
      depth: 0,
      path: [`flaky:${originalSessionId}`],
      // Já concluída como `failed` — exatamente o estado em que `#fallback`
      // deixa a sessão original ANTES de tentar criar a substituta
      // (`#concludeSession` roda primeiro, fora da transação).
      state: 'failed',
      mode: 'semi',
      isolation: 'none',
      workdir: proj.path,
      title: 'sessão original (já falhou)',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: nowIso(),
      pid: null,
    };
    hub.store.sessions.create(originalSession);

    const taskId = newId('tsk');
    const task: Task = {
      id: taskId,
      sessionId: originalSessionId,
      requesterSessionId: null,
      brief: {
        agent: 'flaky',
        objective: 'tarefa que precisa de fallback',
        acceptanceCriteria: [],
        constraints: [],
        artifacts: [],
        contextRefs: [],
        upstream: [],
        budget: {},
        isolation: 'none',
        mode: 'async',
        supervision: 'semi',
        labels: {},
      },
      state: 'working',
      attempts: [{ n: 1, agentId: 'flaky', startedAt: nowIso(), endedAt: nowIso(), outcome: 'error', error: 'falha simulada' }],
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    hub.store.tasks.create(task);

    const replacementId = newId('ses');
    const replacement: Session = {
      ...originalSession,
      id: replacementId,
      agentId: 'backup',
      state: 'running',
      title: 'sessão substituta',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
    };

    const originalUpdate = hub.store.tasks.update.bind(hub.store.tasks);
    hub.store.tasks.update = ((id: string, patch: Partial<Task>) => {
      if (Object.prototype.hasOwnProperty.call(patch, 'sessionId')) {
        throw new Error('crash simulado: escrita interrompida no meio da transação de #fallback (achado 2)');
      }
      return originalUpdate(id, patch);
    }) as typeof hub.store.tasks.update;

    try {
      assert.throws(() => {
        hub.store.transaction(() => {
          hub.store.sessions.create(replacement);
          hub.store.tasks.update(taskId, {
            sessionId: replacementId,
            attempts: [...task.attempts, { n: 2, agentId: 'backup', startedAt: nowIso(), endedAt: null, outcome: null, error: null }],
          });
        });
      }, /crash simulado/);

      // O ponto central do achado: a transação precisa ter desfeito a
      // criação da sessão substituta junto com a reatribuição da task. Sem
      // `this.store.transaction(...)` envolvendo as duas escritas (o bug
      // original), `sessions.create(replacement)` já teria COMMITADO como
      // statement independente antes de `tasks.update` lançar, deixando uma
      // sessão "backup" órfã no banco.
      assert.equal(
        hub.store.sessions.get(replacementId),
        null,
        'a sessão substituta não pode sobreviver ao rollback da transação',
      );

      // A task continua apontando para a sessão original — nunca foi
      // reatribuída, porque a escrita que faria isso fez parte da mesma
      // transação revertida.
      const taskDepois = hub.store.tasks.get(taskId);
      assert.equal(taskDepois?.sessionId, originalSessionId, 'sessionId da task não pode ter mudado sem a reatribuição completa');
    } finally {
      hub.store.tasks.update = originalUpdate;
    }
  });
});

/**
 * Regressão do achado 3 (ALTO) da mesma auditoria: dentro de
 * `reconcileOnStartup`, marcar a sessão como `killed` e fechar as tasks
 * não-terminais dela eram escritas separadas, fora de transação. Um crash NO
 * MEIO da própria rotina de recuperação (ex.: dois crashes seguidos) deixava
 * a sessão `killed` com tasks ainda não-terminais — e como o laço externo só
 * revisita sessões `running`/`waiting_approval`, essas tasks nunca seriam
 * revisitadas de novo.
 *
 * Simula o crash monkeypatchando `store.tasks.update` para lançar na
 * primeira chamada que fecha uma task (`{ state: 'failed' }`) — o mesmo
 * `catch`/`ROLLBACK` de `UnitOfWork.transaction` que um crash real forçaria.
 */
describe('auditoria: reconcileOnStartup fecha sessão + tasks atomicamente (achado 3)', () => {
  let raiz: string;
  let hub: Hub;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-auditoria-reconcile-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      policy: { ...DEFAULT_POLICY, watch: { pauseOn: [], flagOn: [] } },
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

  test('crash simulado entre marcar a sessão killed e fechar as tasks desfaz os dois (não deixa sessão killed com task viva)', async () => {
    const proj = hub.sessions.registerProject(path.join(raiz, 'projeto-reconcile'), 'Teste Reconcile Atômico');
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
      // "running" sem processo de verdade por trás: simula o registro deixado
      // por um daemon anterior que morreu — exatamente o que
      // `reconcileOnStartup` existe para varrer.
      state: 'running',
      mode: 'semi',
      isolation: 'none',
      workdir: proj.path,
      title: 'sessão presa de um crash anterior',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      pid: null,
    };
    hub.store.sessions.create(session);

    const taskId = newId('tsk');
    const task: Task = {
      id: taskId,
      sessionId,
      requesterSessionId: null,
      brief: {
        agent: 'agente-x',
        objective: 'tarefa presa',
        acceptanceCriteria: [],
        constraints: [],
        artifacts: [],
        contextRefs: [],
        upstream: [],
        budget: {},
        isolation: 'none',
        mode: 'async',
        supervision: 'semi',
        labels: {},
      },
      state: 'working',
      attempts: [{ n: 1, agentId: 'agente-x', startedAt: nowIso(), endedAt: null, outcome: null, error: null }],
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    hub.store.tasks.create(task);

    const originalUpdate = hub.store.tasks.update.bind(hub.store.tasks);
    let armado = true;
    hub.store.tasks.update = ((id: string, patch: Partial<Task>) => {
      if (armado && id === taskId && patch.state === 'failed') {
        armado = false;
        throw new Error('crash simulado: escrita interrompida no meio de reconcileOnStartup (achado 3)');
      }
      return originalUpdate(id, patch);
    }) as typeof hub.store.tasks.update;

    try {
      await assert.rejects(
        () => hub.sessions.reconcileOnStartup(),
        /crash simulado/,
        'a exceção no meio da rotina precisa propagar, não ser engolida — senão a rotina de recuperação mentiria sobre ter terminado',
      );

      // O ponto central do achado: SEM a transação, a sessão já teria virado
      // "killed" antes do loop de tasks explodir — aqui, com a correção, o
      // ROLLBACK desfaz também a atualização da sessão.
      const sessaoDepois = hub.store.sessions.get(sessionId);
      assert.equal(
        sessaoDepois?.state,
        'running',
        'sem transação, a sessão ficaria "killed" mesmo com a task ainda não-terminal — a correção desfaz os dois juntos',
      );

      const taskDepois = hub.store.tasks.get(taskId);
      assert.equal(taskDepois?.state, 'working', 'a task não pode ter sido fechada sem a sessão também ter sido');
    } finally {
      hub.store.tasks.update = originalUpdate;
    }
  });
});

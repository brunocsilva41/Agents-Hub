import path from 'node:path';
import {
  BudgetLedger,
  HubError,
  validarNovaPasta,
  PolicyEngine,
  SequenceCounter,
  ZERO_USAGE,
  buildGraph,
  checkDelegation,
  classifyOutcome,
  failureContext,
  nextStep,
  validationPassed,
  inheritMode,
  isTerminalTaskState,
  makeEvent,
  newId,
  nowIso,
  parseBrief,
  pathKey,
  rebuildConversation,
  renderBriefAsPrompt,
  resolveEventCost,
  watchForMode,
  type Approval,
  type Artifact,
  type Brief,
  type BudgetLimits,
  type BudgetProjection,
  type Decision,
  type BudgetSnapshot,
  type EventEnvelope,
  type GraphNode,
  type GuardedAction,
  type IsolationMode,
  type Project,
  type ProjectFolder,
  type Session,
  type SessionMode,
  type OutcomeClass,
  type PolicyDocument,
  type RiskLevel,
  type Task,
  type TaskAttempt,
  type ValidationOutcome,
  type UnitOfWork,
} from '@agents-hub/core';
import type {
  AgentRegistry,
  MappedEvent,
  RunContext,
  RunHandle,
  RunOutcome,
} from '@agents-hub/adapters';
import type { InMemoryEventBus } from './bus.js';
import type { HubConfig } from './config.js';
import { loadProjectOverrides, mergeProjectPolicy } from './project-config.js';
import { captureDiff, persistDiff } from './diff-capture.js';
import { interpretarRevisao } from './review-verdict.js';
import { actionsOfToolCall, combineVerdicts } from './pretool-gate.js';
import { runValidation } from './validation.js';
import type { WorktreeManager } from './worktree.js';

/**
 * Traduz um evento do agente nas ações que a política sabe classificar.
 *
 * Só existem duas fontes reais de risco observável: comando executado e
 * arquivo alterado. Caminho relativo é resolvido contra o worktree da sessão —
 * sem isso, todo arquivo do agente pareceria estar fora do diretório dele.
 */
function guardedActionsOf(mapped: MappedEvent, workdir: string): GuardedAction[] {
  if (mapped.type === 'command.executed') {
    const command = mapped.payload['command'];
    return typeof command === 'string' && command.trim().length > 0
      ? [{ kind: 'command', command }]
      : [];
  }

  if (mapped.type === 'file.changed') {
    const files = mapped.payload['files'];
    const paths =
      Array.isArray(files) && files.length > 0
        ? files.map((f) => (f as Record<string, unknown>)['path'])
        : [mapped.payload['path']];

    return paths
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => ({ kind: 'file.write', path: path.resolve(workdir, p) }));
  }

  return [];
}

/** Fecha a última tentativa registrada com o desfecho observado. */
function closeLastAttempt(
  attempts: TaskAttempt[],
  outcome: OutcomeClass | 'invalid',
  error: string | null,
): TaskAttempt[] {
  if (attempts.length === 0) return attempts;

  const mapped: TaskAttempt['outcome'] =
    outcome === 'success'
      ? 'success'
      : outcome === 'invalid'
        ? 'invalid'
        : outcome === 'canceled'
          ? null
          : 'error';

  return attempts.map((a, i, arr) =>
    i === arr.length - 1 ? { ...a, endedAt: nowIso(), outcome: mapped, error } : a,
  );
}

/** Quebra de linha literal para montar prompt sem brigar com escapes. */
const NEWLINE_PROMPT = String.fromCharCode(10);

function novaTentativa(n: number, agentId: string): TaskAttempt {
  return { n, agentId, startedAt: nowIso(), endedAt: null, outcome: null, error: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeAction(action: GuardedAction): string {
  switch (action.kind) {
    case 'command':
      return `executou: ${action.command}`;
    case 'file.write':
      return `escreveu em: ${action.path}`;
    case 'file.read':
      return `leu: ${action.path}`;
    case 'network':
      return `acessou: ${action.url}`;
    case 'delegation':
      return `delegou para: ${action.agent}`;
    case 'budget.overrun':
      return action.detail;
  }
}

export interface StartSessionInput {
  projectId: string;
  agentId: string;
  brief: unknown;
  /** Sessão que pediu. `null` = você, pela CLI/UI (sessão-raiz). */
  requesterSessionId?: string | null;
  title?: string;
}

export interface StartSessionResult {
  session: Session;
  task: Task;
  budget: BudgetSnapshot;
  /** Presente quando a delegação ficou retida esperando sua decisão. */
  approval?: Approval;
}

interface LiveRun {
  handle: RunHandle;
  sessionId: string;
  taskId: string;
  ctx: RunContext;
  startedAt: number;
}

/**
 * Gerenciador de sessões: a peça que transforma "rodar um CLI" em
 * "uma sessão do Hub, com política, orçamento, eventos e grafo".
 *
 * Tudo que é específico de um agente já foi resolvido pelo adapter antes de
 * chegar aqui — este arquivo trata os oito exatamente do mesmo jeito.
 */
export class SessionManager {
  readonly #seq: SequenceCounter;
  readonly #ledgers = new Map<string, BudgetLedger>();
  readonly #runs = new Map<string, LiveRun>();
  /** Sessões cujo `seq` já foi reconciliado com o banco nesta instância. */
  readonly #seeded = new Set<string>();
  /** Modelo declarado por sessão, para precificar os eventos que não o repetem. */
  readonly #models = new Map<string, string>();

  constructor(
    private readonly config: HubConfig,
    private readonly store: UnitOfWork,
    private readonly registry: AgentRegistry,
    private readonly bus: InMemoryEventBus,
    private readonly worktrees: WorktreeManager,
  ) {
    this.#seq = new SequenceCounter();
  }

  // ---------------------------------------------------------------- projetos

  registerProject(dir: string, name?: string): Project {
    const absolute = path.resolve(dir);
    const existing = this.store.projects.getByPath(absolute);
    if (existing) return existing;

    // A pasta pode já pertencer a OUTRO projeto, ou estar dentro de uma que
    // pertence. Criar o projeto assim mesmo deixaria dois donos para a mesma
    // árvore de arquivos, e nenhuma resposta para qual política vale ali.
    const veredito = validarNovaPasta(absolute, this.store.projects.allFolders());
    if (!veredito.ok) {
      throw new HubError('PROJECT_FOLDER_CONFLICT', veredito.motivo, { path: absolute });
    }

    const project = this.store.projects.create({
      name: name ?? path.basename(absolute),
      path: absolute,
      defaultBranch: 'main',
    });

    // Todo projeto nasce com uma pasta: a dele. Sem isto, um projeto recém
    // criado não teria onde rodar sessão nenhuma.
    this.store.projects.addFolder({
      projectId: project.id,
      path: absolute,
      label: project.name,
      isPrimary: true,
    });

    return project;
  }

  listProjects(): Project[] {
    return this.store.projects.list();
  }

  /** Projeto por id, ou erro — nunca `null` seguindo adiante em silêncio. */
  #project(projectId: string): Project {
    const project = this.store.projects.get(projectId);
    if (!project) {
      throw new HubError('PROJECT_NOT_FOUND', `Projeto ${projectId} não encontrado`, {
        projectId,
      });
    }
    return project;
  }

  listProjectFolders(projectId: string): ProjectFolder[] {
    // Valida a existência para não devolver lista vazia de projeto inexistente,
    // que o chamador leria como "projeto sem pastas".
    this.#project(projectId);
    return this.store.projects.listFolders(projectId);
  }

  /**
   * Acrescenta uma pasta ao projeto.
   *
   * É o que torna um "projeto" capaz de cobrir frontend e backend em
   * repositórios separados sem perder a unificação de custo, política e
   * histórico — e sem unir o acesso, porque a sessão continua rodando em uma
   * pasta só.
   */
  addProjectFolder(projectId: string, dir: string, label?: string): ProjectFolder {
    const project = this.#project(projectId);
    const absolute = path.resolve(dir);

    const veredito = validarNovaPasta(absolute, this.store.projects.allFolders());
    if (!veredito.ok) {
      throw new HubError('PROJECT_FOLDER_CONFLICT', veredito.motivo, { path: absolute });
    }

    return this.store.projects.addFolder({
      projectId: project.id,
      path: absolute,
      label: label ?? path.basename(absolute),
      isPrimary: false,
    });
  }

  /**
   * Remove uma pasta do projeto.
   *
   * A principal não sai: ela é a raiz padrão das sessões, e um projeto sem raiz
   * padrão só descobriria o problema na próxima vez que alguém tentasse abrir
   * uma sessão nele.
   */
  removeProjectFolder(projectId: string, folderId: string): void {
    const pastas = this.listProjectFolders(projectId);
    const alvo = pastas.find((f) => f.id === folderId);
    if (!alvo) {
      throw new HubError('FOLDER_NOT_FOUND', `pasta ${folderId} não pertence a este projeto`, {
        projectId,
        folderId,
      });
    }
    if (alvo.isPrimary) {
      throw new HubError(
        'FOLDER_IS_PRIMARY',
        'a pasta principal não pode ser removida; ela é a raiz padrão das sessões deste projeto',
        { projectId, folderId },
      );
    }
    this.store.projects.removeFolder(folderId);
  }

  // ---------------------------------------------------------------- sessões

  /**
   * Inicia uma sessão. É o mesmo caminho para você abrindo uma sessão-raiz e
   * para um agente delegando — o que muda é `requesterSessionId`. Manter um
   * caminho só é o que garante que delegação não escape das mesmas checagens.
   */
  async start(input: StartSessionInput): Promise<StartSessionResult> {
    const brief = parseBrief(input.brief);
    const project = this.store.projects.get(input.projectId);
    if (!project) {
      throw new HubError('PROJECT_NOT_FOUND', `Projeto ${input.projectId} não encontrado`, {
        projectId: input.projectId,
      });
    }

    const parent = input.requesterSessionId
      ? this.store.sessions.get(input.requesterSessionId)
      : null;
    if (input.requesterSessionId && !parent) {
      throw new HubError('SESSION_NOT_FOUND', `Sessão ${input.requesterSessionId} não encontrada`, {
        sessionId: input.requesterSessionId,
      });
    }

    const agentId = this.registry.resolveTarget(brief.agent, this.config.policy.fallback);
    const manifest = this.registry.get(agentId).manifest;

    this.#assertConcurrency(agentId);

    // --- grafo: profundidade e ciclo (ADR 03) -------------------------------
    const graph = parent
      ? checkDelegation({
          parentPath: parent.path,
          parentDepth: parent.depth,
          maxDepth: this.config.policy.maxDepth,
          target: { agentId, objective: brief.objective },
        })
      : { depth: 0, path: [pathKey(agentId, brief.objective)], key: '' };

    // --- modo: nunca escala em relação ao pai -------------------------------
    const parentMode: SessionMode = parent?.mode ?? manifest.defaults.supervision;
    const mode = inheritMode(parentMode, brief.supervision);

    const sessionId = newId('ses');
    const rootId = parent ? parent.rootId : sessionId;

    // --- orçamento ----------------------------------------------------------
    // Na raiz, o budget do Brief DEFINE o teto do fluxo inteiro.
    // Num filho, ele RESERVA uma fatia do que a raiz ainda tem.
    const taskId = newId('tsk');
    const ledger = parent
      ? this.#ledger(rootId)
      : this.#ledger(rootId, {
          usd: brief.budget.usd ?? this.config.policy.defaultBudget.usd,
          tokens: brief.budget.tokens ?? this.config.policy.defaultBudget.tokens,
          seconds: brief.budget.seconds ?? this.config.policy.defaultBudget.seconds,
        });

    if (parent) {
      ledger.reserve(taskId, {
        usd: brief.budget.usd ?? undefined,
        tokens: brief.budget.tokens ?? undefined,
        seconds: brief.budget.seconds ?? undefined,
      });
    }
    this.#persistLedger(ledger);

    // --- isolamento ---------------------------------------------------------
    const isolation: IsolationMode = brief.isolation ?? manifest.defaults.isolation;
    const worktree = await this.worktrees.create({
      projectPath: project.path,
      projectName: project.name,
      sessionId,
      isolation,
    });

    const session: Session = {
      id: sessionId,
      projectId: project.id,
      agentId,
      nativeSessionId: null,
      rootId,
      parentId: parent?.id ?? null,
      depth: graph.depth,
      path: graph.path,
      state: 'running',
      mode,
      isolation: worktree.isolated ? isolation : 'none',
      workdir: worktree.path,
      title: input.title ?? brief.objective.slice(0, 120),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
    };

    const task: Task = {
      id: taskId,
      sessionId,
      requesterSessionId: parent?.id ?? null,
      brief,
      state: 'working',
      attempts: [
        { n: 1, agentId, startedAt: nowIso(), endedAt: null, outcome: null, error: null },
      ],
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.store.transaction(() => {
      this.store.sessions.create(session);
      this.store.tasks.create(task);
    });
    this.bus.registerSession(sessionId, rootId);

    if (parent) {
      this.#emit({
        sessionId: parent.id,
        taskId,
        agentId: parent.agentId,
        type: 'delegation.requested',
        payload: {
          childSessionId: sessionId,
          targetAgent: agentId,
          objective: brief.objective,
          depth: graph.depth,
        },
      });
    }

    // --- portão de delegação: o único gate REALMENTE preventivo ------------
    // A chamada agente→agente passa por dentro do Hub, então dá para segurá-la
    // antes de qualquer processo subir. Comando de shell e escrita em arquivo
    // não têm esse luxo: chegam como evento, depois de acontecer.
    if (parent) {
      const verdict = this.policyFor(parent).decide(
        { kind: 'delegation', agent: agentId },
        { workdir: parent.workdir, mode: parent.mode },
      );

      if (verdict.decision === 'deny') {
        this.store.tasks.update(task.id, { state: 'rejected' });
        this.store.sessions.update(session.id, { state: 'failed', endedAt: nowIso() });
        ledger.release(task.id);
        throw new HubError('POLICY_DENIED', `Delegação negada pela política: ${verdict.reason}`, {
          agentId,
          risk: verdict.risk,
        });
      }

      if (verdict.decision === 'approve') {
        const approval = this.#requestApproval({
          session,
          taskId: task.id,
          risk: verdict.risk,
          action: `${parent.agentId} quer delegar para ${agentId}`,
          detail: {
            kind: 'delegation',
            objective: brief.objective,
            requester: parent.id,
            reason: verdict.reason,
          },
        });

        // Relê do banco: `#requestApproval` moveu a task para `input_required`
        // e a sessão para `waiting_approval`. Devolver os objetos em memória
        // diria "working" para quem chamou, e um agente em polling esperaria
        // para sempre por algo que nem começou.
        return {
          session: this.store.sessions.get(session.id) ?? session,
          task: this.store.tasks.get(task.id) ?? task,
          budget: ledger.snapshot(),
          approval,
        };
      }
    }

    await this.#launch(session, task, renderBriefAsPrompt(brief), null);

    return { session, task, budget: ledger.snapshot() };
  }

  /**
   * Reconcilia o estado persistido com a realidade, na subida do daemon.
   *
   * Uma run só existe DENTRO de um processo do daemon. Quando ele morre — crash,
   * reinício, `hub stop` —, as sessões que estavam `running` ficam gravadas como
   * ativas para sempre: aparecem vivas no `hub status` e no painel, ocupam lugar
   * na cabeça de quem lê, e nunca progridem porque não há processo por trás.
   *
   * Sessões esperando aprovação humana são a exceção e ficam de pé: elas não
   * dependem de processo nenhum, dependem de você.
   */
  reconcileOnStartup(): { revividas: number; encerradas: number } {
    const pendentes = new Set(
      this.store.approvals.listPending().map((a) => a.sessionId),
    );

    let encerradas = 0;
    let revividas = 0;

    for (const sessao of this.store.sessions.list()) {
      if (sessao.state !== 'running' && sessao.state !== 'waiting_approval') continue;

      if (sessao.state === 'waiting_approval' && pendentes.has(sessao.id)) {
        revividas += 1;
        continue;
      }

      this.store.sessions.update(sessao.id, {
        state: 'killed',
        endedAt: sessao.endedAt ?? nowIso(),
      });

      // A task fica em `failed` para o pipeline não achar que ainda há trabalho.
      for (const task of this.store.tasks.list({ sessionId: sessao.id })) {
        if (!isTerminalTaskState(task.state)) {
          this.store.tasks.update(task.id, { state: 'failed' });
        }
      }

      encerradas += 1;
    }

    return { revividas, encerradas };
  }

  /**
   * Decide uma chamada de ferramenta ANTES de ela executar (gate pré-execução).
   *
   * É a única prevenção real que o Hub consegue sem sandbox de sistema: o
   * agente pergunta, nós respondemos, e a ferramenta só roda se deixarmos.
   * A vigilância reativa continua existindo para os agentes que não têm hook.
   */
  gateToolCall(input: {
    sessionId?: string | undefined;
    nativeSessionId?: string | undefined;
    cwd?: string | undefined;
    toolName: string;
    toolInput?: Record<string, unknown> | undefined;
  }): { decision: Decision; risk: RiskLevel; reason: string; session: Session | null } {
    const session = this.#localizarSessao(input);

    // Sem sessão conhecida o Hub não tem política de quem aplicar. Barrar aqui
    // transformaria qualquer uso do agente FORA do Hub num bloqueio, então a
    // resposta honesta é não opinar.
    if (!session) {
      return {
        decision: 'allow',
        risk: 'read',
        reason: 'chamada fora de uma sessão do Hub — sem política a aplicar',
        session: null,
      };
    }

    const workdir = input.cwd ?? session.workdir;
    const engine = this.policyFor(session);
    const actions = actionsOfToolCall(
      { toolName: input.toolName, toolInput: input.toolInput ?? {}, cwd: input.cwd },
      workdir,
    );

    const vereditos = actions.map((action) => {
      const v = engine.decide(action, { workdir: session.workdir, mode: session.mode });
      return { decision: v.decision, risk: v.risk, reason: v.reason };
    });

    const combinado = combineVerdicts(vereditos);

    // O agente perguntou: registrar na timeline é o que torna a decisão
    // auditável depois, inclusive quando foi "allow".
    if (combinado.decision !== 'allow') {
      this.#emit({
        sessionId: session.id,
        taskId: null,
        agentId: session.agentId,
        type: 'approval.requested',
        payload: {
          gate: 'pre-execution',
          tool: input.toolName,
          risk: combinado.risk,
          decision: combinado.decision,
          reason: combinado.reason,
        },
      });
    }

    return { ...combinado, session };
  }

  /**
   * Encontra a sessão do Hub a partir do que o hook conseguiu informar.
   *
   * A variável de ambiente é o caminho confiável (nós a injetamos ao spawnar);
   * id nativo e diretório são as saídas quando o hook roda num contexto que a
   * perdeu.
   */
  #localizarSessao(input: {
    sessionId?: string | undefined;
    nativeSessionId?: string | undefined;
    cwd?: string | undefined;
  }): Session | null {
    // O id do Hub é a fonte mais confiável: o próprio Hub o injetou no ambiente
    // do agente ao spawná-lo.
    if (input.sessionId) {
      const direta = this.store.sessions.get(input.sessionId);
      if (direta) return direta;
    }

    const candidatas = this.store.sessions.list();

    if (input.nativeSessionId) {
      const porNativa = candidatas.find((s) => s.nativeSessionId === input.nativeSessionId);
      if (porNativa) return porNativa;
    }

    if (input.cwd) {
      const alvo = path.resolve(input.cwd);
      const noDiretorio = candidatas.filter((s) => path.resolve(s.workdir) === alvo);

      // Sessão VIVA primeiro. Worktrees são por sessão, mas `isolation: none`
      // faz várias dividirem o diretório do projeto — e aplicar a política de
      // uma sessão já encerrada seria decidir por um contexto que não existe
      // mais, possivelmente mais frouxo que o da sessão que está rodando.
      const viva = noDiretorio
        .filter((s) => s.state === 'running' || s.state === 'waiting_approval')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (viva) return viva;

      const recente = noDiretorio.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (recente) return recente;
    }

    return null;
  }

  // ------------------------------------------------------------- aprovações

  pendingApprovals(sessionId?: string): Approval[] {
    return this.store.approvals.listPending(sessionId ? { sessionId } : {});
  }

  getApproval(id: string): Approval {
    const approval = this.store.approvals.get(id);
    if (!approval) {
      throw new HubError('ILLEGAL_STATE', `Aprovação ${id} não encontrada`, { id });
    }
    return approval;
  }

  /**
   * Resolve uma aprovação pendente.
   *
   * Aprovar retoma de onde parou: delegação segura vira execução, sessão
   * pausada por vigilância volta a andar com um aviso explícito do que foi
   * liberado — o agente precisa saber que houve uma decisão humana, senão
   * repete a mesma ação achando que falhou.
   */
  async resolveApproval(
    id: string,
    decision: 'approved' | 'denied',
    by = 'você',
  ): Promise<Approval> {
    const approval = this.getApproval(id);
    if (approval.state !== 'pending') {
      throw new HubError('ILLEGAL_STATE', `Aprovação ${id} já foi ${approval.state}`, { id });
    }

    const resolved = this.store.approvals.update(id, {
      state: decision,
      resolvedAt: nowIso(),
      resolvedBy: by,
    });

    const session = this.#session(approval.sessionId);
    this.#emit({
      sessionId: session.id,
      taskId: approval.taskId,
      agentId: session.agentId,
      type: 'approval.resolved',
      payload: { approvalId: id, decision, action: approval.action, by },
    });

    if (decision === 'denied') {
      if (approval.taskId) this.store.tasks.update(approval.taskId, { state: 'rejected' });
      await this.cancel(session.id, `negado por ${by}: ${approval.action}`);
      return resolved;
    }

    const isDelegation = approval.detail['kind'] === 'delegation';
    const task = approval.taskId ? this.store.tasks.get(approval.taskId) : null;

    // Liberar um bloqueio de orçamento sem aumentar o teto faria a sessão
    // retomar e estourar de novo na primeira chamada — um ciclo de aprovações
    // que nunca sai do lugar.
    if (approval.detail['kind'] === 'budget') {
      const incremento = approval.detail['increment'] as
        | { usd?: number; tokens?: number; seconds?: number }
        | undefined;

      const ledger = this.#ledger(session.rootId);
      const snapshot = ledger.raiseLimits(incremento ?? {});
      this.#persistLedger(ledger);

      this.#emit({
        sessionId: session.id,
        taskId: approval.taskId,
        agentId: session.agentId,
        type: 'budget.updated',
        payload: {
          text: `orçamento ampliado por ${by}: agora US$ ${snapshot.limits.usd.toFixed(2)}`,
          snapshot,
        },
      });
    }

    if (isDelegation && task) {
      // A sessão nem chegou a subir: agora sobe.
      this.store.tasks.update(task.id, { state: 'working' });
      await this.#launch(session, task, renderBriefAsPrompt(task.brief), null);
      return resolved;
    }

    // Vigilância: a run foi morta ao pausar, então continuamos por uma mensagem
    // nova, dizendo ao agente o que exatamente foi liberado.
    if (task) this.store.tasks.update(task.id, { state: 'working' });
    this.store.sessions.update(session.id, { state: 'running' });

    // A sessão pode ter morrido enquanto a aprovação esperava — timeout do
    // daemon, `hub stop`, reconciliação. Aprovar continua sendo registrado,
    // mas não há para onde retomar, e dizer isso é melhor que estourar um erro
    // que parece culpa de quem aprovou.
    const viva = this.store.sessions.get(session.id);
    if (!viva || viva.state === 'killed' || viva.state === 'failed' || viva.state === 'completed') {
      this.#emit({
        sessionId: session.id,
        taskId: approval.taskId,
        agentId: session.agentId,
        type: 'log',
        payload: {
          level: 'warn',
          text: `aprovação liberada, mas a sessão já havia terminado (${viva?.state ?? 'inexistente'}) — nada a retomar`,
        },
      });
      return resolved;
    }

    await this.send(
      session.id,
      `A ação "${approval.action}" foi aprovada por ${by}. Continue de onde parou.`,
    );
    return resolved;
  }

  #requestApproval(input: {
    session: Session;
    taskId: string | null;
    risk: RiskLevel;
    action: string;
    detail: Record<string, unknown>;
  }): Approval {
    const approval: Approval = {
      id: newId('apv'),
      sessionId: input.session.id,
      taskId: input.taskId,
      risk: input.risk,
      action: input.action,
      detail: input.detail,
      state: 'pending',
      requestedAt: nowIso(),
      resolvedAt: null,
      resolvedBy: null,
    };

    this.store.transaction(() => {
      this.store.approvals.create(approval);
      this.store.sessions.update(input.session.id, { state: 'waiting_approval' });
      if (input.taskId) this.store.tasks.update(input.taskId, { state: 'input_required' });
    });

    this.#emit({
      sessionId: input.session.id,
      taskId: input.taskId,
      agentId: input.session.agentId,
      type: 'approval.requested',
      payload: {
        approvalId: approval.id,
        risk: approval.risk,
        action: approval.action,
        ...approval.detail,
      },
    });

    return approval;
  }

  /**
   * Manda uma mensagem para uma sessão viva.
   *
   * Três caminhos, nesta ordem de preferência: injetar na run em andamento
   * (só quem declara `interactive`), retomar a sessão nativa, ou — como último
   * recurso — abrir um turno novo com replay. O chamador não precisa saber
   * qual foi usado; a resposta diz.
   */
  async send(sessionId: string, text: string): Promise<{ mode: 'live' | 'resume' | 'replay' }> {
    const session = this.#session(sessionId);
    const adapter = this.registry.get(session.agentId);
    const live = this.#runs.get(sessionId);

    if (live && live.handle.supportsLiveSend) {
      await adapter.send(live.handle, text);
      return { mode: 'live' };
    }

    if (live) {
      // Uma run one-shot ainda rodando não aceita entrada: interromper e
      // reiniciar perderia trabalho. Recusamos com um motivo claro.
      throw new HubError(
        'ILLEGAL_STATE',
        `A sessão ${sessionId} está executando um turno que não aceita mensagem ao vivo. Interrompa antes de enviar.`,
        { sessionId, agentId: session.agentId },
      );
    }

    // Falar com sessão encerrada lançaria um processo novo numa sessão morta,
    // e o trabalho ficaria pendurado num lugar que ninguém mais observa.
    if (session.state === 'killed' || session.state === 'failed' || session.state === 'completed') {
      throw new HubError(
        'ILLEGAL_STATE',
        `A sessão ${sessionId} já terminou (${session.state}). Abra uma sessão nova ou delegue a partir de outra.`,
        { sessionId, state: session.state },
      );
    }

    const task = this.#latestTask(sessionId);
    const canResume =
      adapter.manifest.session.strategy === 'native' && session.nativeSessionId !== null;

    // Sem sessão nativa, o processo novo nasce com contexto ZERO. Mandar só a
    // mensagem entregaria ao agente um "faça também X" sem ele saber qual era a
    // tarefa nem o que já tentou — que é o modo mais caro de ele recomeçar do
    // zero e repetir o mesmo erro.
    const prompt = canResume
      ? text
      : rebuildConversation({
          brief: task.brief,
          history: this.store.events.list({ sessionId, limit: 400 }),
          message: text,
        });

    await this.#launch(session, task, prompt, canResume ? session.nativeSessionId : null);
    return { mode: canResume ? 'resume' : 'replay' };
  }

  /**
   * Interrompe o turno em andamento.
   *
   * Devolve `false` quando a sessão existe mas não tinha nada rodando — e isso
   * precisa chegar a quem pediu. A versão anterior consultava `#runs` ANTES de
   * validar a sessão e saía calada quando não achava nada, então
   * `POST /sessions/ses_naoexiste/interrupt` respondia `{ok:true}` com 200.
   * Sucesso relatado sobre coisa nenhuma, e divergente dos irmãos `cancel` e
   * `pause`, que devolviam 404 para o mesmo id.
   */
  async interrupt(sessionId: string): Promise<boolean> {
    // Validar primeiro: id desconhecido é erro do chamador, não silêncio.
    const session = this.#session(sessionId);

    const live = this.#runs.get(sessionId);
    if (!live) return false;

    await this.registry.get(session.agentId).interrupt(live.handle);
    return true;
  }

  async cancel(sessionId: string, reason = 'cancelado pelo usuário', visited = new Set<string>()): Promise<void> {
    if (visited.has(sessionId)) return;
    visited.add(sessionId);

    const session = this.#session(sessionId);
    const live = this.#runs.get(sessionId);
    if (live) await this.registry.get(session.agentId).cancel(live.handle);

    // Cancelar um pai cancela a subárvore: deixar filhos órfãos rodando é como
    // agentes continuam gastando orçamento de um fluxo que você já abortou.
    for (const child of this.store.sessions.children(sessionId)) {
      if (child.state === 'running' || child.state === 'waiting_approval') {
        await this.cancel(child.id, `pai ${sessionId} cancelado`, visited);
      }
    }

    this.#emit({
      sessionId,
      taskId: null,
      agentId: session.agentId,
      type: 'session.ended',
      payload: { reason, state: 'killed' },
    });
    await this.#finish(sessionId, 'killed', reason);
  }

  async pause(sessionId: string): Promise<void> {
    await this.interrupt(sessionId);
    this.store.sessions.update(sessionId, { state: 'paused' });
  }

  /**
   * Transfere o controle da sessão para outro agente em tempo de execução (Fase 3).
   *
   * O agente anterior é interrompido e o novo agente assume a mesma sessão/worktree
   * com todo o histórico acumulado reconstruído como contexto.
   */
  async handoff(sessionId: string, targetAgentId: string, reason?: string): Promise<Session> {
    const session = this.#session(sessionId);
    const resolvedTarget = this.registry.resolveTarget(targetAgentId, this.config.policy.fallback);

    if (session.state === 'killed' || session.state === 'failed' || session.state === 'completed') {
      throw new HubError(
        'ILLEGAL_STATE',
        `A sessão ${sessionId} já terminou (${session.state}). Não é possível fazer handoff.`,
        { sessionId, state: session.state },
      );
    }

    this.#assertConcurrency(resolvedTarget);

    // Interrompe a execução atual se houver
    const live = this.#runs.get(sessionId);
    if (live) {
      await this.registry.get(session.agentId).cancel(live.handle);
      this.#runs.delete(sessionId);
    }

    const task = this.#latestTask(sessionId);
    const fromAgentId = session.agentId;

    this.#emit({
      sessionId,
      taskId: task.id,
      agentId: resolvedTarget,
      type: 'session.handoff',
      payload: {
        fromAgentId,
        toAgentId: resolvedTarget,
        reason: reason ?? 'transferência de controle solicitada',
      },
    });

    const updatedSession = this.store.sessions.update(sessionId, {
      agentId: resolvedTarget,
      nativeSessionId: null,
      state: 'running',
    });

    const prompt = rebuildConversation({
      brief: task.brief,
      history: this.store.events.list({ sessionId, limit: 400 }),
      message: `Você está assumindo esta sessão que estava sob responsabilidade de ${fromAgentId}. Motivo da transferência: ${reason ?? 'continuidade de trabalho'}. Continue a tarefa de onde parou.`,
    });

    await this.#launch(updatedSession, task, prompt, null);
    return updatedSession;
  }

  /**
   * Adota um agente que roda FORA do Hub como sessão-raiz.
   *
   * É o que faz "qualquer um pode ser o principal" funcionar de verdade:
   * quando você abre o Cursor na mão e ele chama `hub_agent_call`, o Cursor não
   * tem sessão no Hub — sem adoção, o filho nasceria órfão e o grafo, o
   * orçamento do fluxo e a herança de política não teriam a quem se ancorar.
   *
   * A sessão adotada é um nó de controle: não tem processo, não é isolada
   * (o agente externo trabalha onde já estava), e existe para ser pai.
   */
  adoptExternal(input: {
    agentId: string;
    projectId: string;
    title?: string;
    budget?: Partial<BudgetLimits>;
  }): Session {
    const project = this.store.projects.get(input.projectId);
    if (!project) {
      throw new HubError('PROJECT_NOT_FOUND', `Projeto ${input.projectId} não encontrado`, {
        projectId: input.projectId,
      });
    }
    if (!this.registry.has(input.agentId)) {
      throw new HubError('AGENT_NOT_FOUND', `Agente "${input.agentId}" não registrado`, {
        agentId: input.agentId,
        available: this.registry.ids(),
      });
    }

    const manifest = this.registry.get(input.agentId).manifest;
    const sessionId = newId('ses');
    const session: Session = {
      id: sessionId,
      projectId: project.id,
      agentId: input.agentId,
      nativeSessionId: null,
      rootId: sessionId,
      parentId: null,
      depth: 0,
      path: [pathKey(input.agentId, `external:${input.agentId}`)],
      state: 'running',
      mode: manifest.defaults.supervision,
      isolation: 'none',
      workdir: project.path,
      title: input.title ?? `${manifest.name} (externo)`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
    };

    this.store.sessions.create(session);
    this.bus.registerSession(sessionId, sessionId);

    this.#ledger(sessionId, {
      usd: input.budget?.usd ?? this.config.policy.defaultBudget.usd,
      tokens: input.budget?.tokens ?? this.config.policy.defaultBudget.tokens,
      seconds: input.budget?.seconds ?? this.config.policy.defaultBudget.seconds,
    });

    this.#emit({
      sessionId,
      taskId: null,
      agentId: input.agentId,
      type: 'session.started',
      payload: { external: true, adoptedAt: nowIso() },
    });

    return session;
  }

  /**
   * Encerra uma sessão adotada sem matar os filhos: o agente externo saiu, mas
   * o trabalho que ele delegou continua valendo.
   */
  async detach(sessionId: string): Promise<void> {
    const session = this.#session(sessionId);
    this.#emit({
      sessionId,
      taskId: null,
      agentId: session.agentId,
      type: 'session.ended',
      payload: { reason: 'agente externo desconectou', external: true },
    });
    await this.#finish(sessionId, 'completed');
  }

  // ---------------------------------------------------------------- consultas

  getSession(sessionId: string): Session {
    return this.#session(sessionId);
  }

  getTask(taskId: string): Task {
    const task = this.store.tasks.get(taskId);
    if (!task) {
      throw new HubError('TASK_NOT_FOUND', `Task ${taskId} não encontrada`, { taskId });
    }
    return task;
  }

  listTasks(sessionId: string): Task[] {
    return this.store.tasks.list({ sessionId });
  }

  /**
   * Resolve referências de contexto do Brief (`session:<id>#event:<seq>`).
   *
   * A delegação passa ponteiros, não conteúdo (ADR 03.4) — este é o método que
   * o filho usa quando decide que precisa mesmo ver um trecho do que o pai fez.
   */
  fetchContext(ref: string): { ref: string; events: EventEnvelope[] } {
    const match = /^session:([^#]+)(?:#event:(\d+))?$/.exec(ref.trim());
    if (!match) {
      throw new HubError(
        'ILLEGAL_STATE',
        `Referência inválida: "${ref}". Use session:<id> ou session:<id>#event:<seq>`,
        { ref },
      );
    }

    const sessionId = match[1] as string;
    this.#session(sessionId);

    if (match[2] === undefined) {
      return { ref, events: this.store.events.list({ sessionId, limit: 200 }) };
    }

    const seq = Number(match[2]);
    // Uma janela ao redor do evento apontado: um evento isolado quase nunca
    // é interpretável sem o que veio logo antes e depois.
    return {
      ref,
      events: this.store.events
        .list({ sessionId, sinceSeq: Math.max(0, seq - 6), limit: 13 })
        .filter((e) => e.seq <= seq + 6),
    };
  }

  listSessions(filter: { projectId?: string; rootId?: string } = {}): Session[] {
    return this.store.sessions.list(filter);
  }

  listEvents(sessionId: string, sinceSeq?: number, limit?: number): EventEnvelope[] {
    return this.store.events.list({ sessionId, sinceSeq, limit });
  }

  graph(rootId: string): GraphNode[] {
    return buildGraph(this.store.sessions.graphRows(rootId));
  }

  budget(rootId: string): BudgetSnapshot & { projection?: BudgetProjection } {
    const ledger = this.#ledger(rootId);
    const snap = ledger.snapshot();
    const elapsedSeconds = snap.consumed.seconds;
    const projection = elapsedSeconds > 0 ? ledger.project(elapsedSeconds) : undefined;
    return { ...snap, projection };
  }

  isLive(sessionId: string): boolean {
    return this.#runs.has(sessionId);
  }

  liveCount(): number {
    return this.#runs.size;
  }

  /** Encerra tudo com ordem, para o daemon não deixar processo órfão. */
  async shutdown(): Promise<void> {
    const sessions = [...this.#runs.keys()];
    await Promise.all(sessions.map((id) => this.cancel(id, 'daemon encerrando')));
  }

  // ---------------------------------------------------------------- internos

  async #launch(
    session: Session,
    task: Task,
    prompt: string,
    nativeSessionId: string | null,
  ): Promise<void> {
    const adapter = this.registry.get(session.agentId);
    const manifest = adapter.manifest;

    const ctx: RunContext = {
      sessionId: session.id,
      taskId: task.id,
      agentId: session.agentId,
      workdir: session.workdir,
      mode: session.mode,
      env: {},
      timeoutSeconds: Math.min(
        manifest.defaults.timeoutSeconds,
        this.config.policy.taskTimeoutSeconds,
      ),
      heartbeatSeconds: this.config.policy.heartbeatTimeoutSeconds,
    };

    // O vínculo sessão→raiz vive em memória no barramento. Depois de um
    // restart do daemon, retomar uma sessão sem reidratá-lo deixaria o
    // `watch --root` e o painel cegos para os eventos dela — sem erro nenhum,
    // só silêncio, que é o pior tipo de falha de observabilidade.
    this.bus.registerSession(session.id, session.rootId);
    this.store.sessions.update(session.id, { state: 'running' });

    const handle = nativeSessionId
      ? await adapter.resume(ctx, nativeSessionId, prompt)
      : await adapter.start(ctx, prompt);

    this.#runs.set(session.id, {
      handle,
      sessionId: session.id,
      taskId: task.id,
      ctx,
      startedAt: Date.now(),
    });

    // O pump roda solto: quem chamou `start` não deve esperar o agente terminar.
    void this.#pump(session, task, handle);
  }

  async #pump(session: Session, task: Task, handle: RunHandle): Promise<void> {
    const ledger = this.#ledger(session.rootId);
    let nativeSeen = session.nativeSessionId;

    try {
      for await (const bruto of handle.events) {
        const mapped = this.#priceEvent(session, bruto);
        this.#persistMapped(session, task, mapped);

        // Vigilância: classifica o que o agente ACABOU de fazer. Não previne a
        // ação que já ocorreu — impede a próxima, parando a sessão.
        const breach = this.#watch(session, task, mapped);
        if (breach === 'paused') {
          await this.registry.get(session.agentId).cancel(handle);
          break;
        }

        if (mapped.nativeSessionId && mapped.nativeSessionId !== nativeSeen) {
          nativeSeen = mapped.nativeSessionId;
          this.store.sessions.update(session.id, { nativeSessionId: nativeSeen });
        }

        if (mapped.cost) {
          const snapshot = ledger.charge({
            usd: mapped.cost.usd ?? 0,
            tokens: (mapped.cost.inputTokens ?? 0) + (mapped.cost.outputTokens ?? 0),
            seconds: 0,
          });
          this.#persistLedger(ledger);

          if (snapshot.exhausted) {
            this.#emit({
              sessionId: session.id,
              taskId: task.id,
              agentId: session.agentId,
              type: 'budget.exceeded',
              payload: { snapshot },
            });

            // Estouro é decisão humana por definição (ADR 03) — mas antes isto
            // só marcava a sessão como "aguardando" SEM criar aprovação: ela
            // não aparecia em `hub approvals` e não havia como destravar.
            // Beco sem saída silencioso, encontrado rodando de verdade.
            this.#requestApproval({
              session,
              taskId: task.id,
              risk: 'budget',
              action: `orçamento do fluxo esgotado (US$ ${snapshot.consumed.usd.toFixed(4)} de ${snapshot.limits.usd.toFixed(2)})`,
              detail: {
                kind: 'budget',
                consumed: snapshot.consumed,
                limits: snapshot.limits,
                // Aprovar libera outra rodada do mesmo tamanho: é previsível e
                // evita que um "ok" vire orçamento ilimitado.
                increment: snapshot.limits,
              },
            });

            await this.registry.get(session.agentId).cancel(handle);
          }
        }
      }
    } catch (err) {
      this.#emit({
        sessionId: session.id,
        taskId: task.id,
        agentId: session.agentId,
        type: 'error',
        payload: { message: (err as Error).message, phase: 'pump' },
      });
    }

    const outcome = await handle.done;
    const live = this.#runs.get(session.id);
    // Se a run ativa na sessão já foi substituída (ex: por handoff),
    // encerramos silenciosamente sem interferir na nova execução.
    if (live && live.handle !== handle) {
      return;
    }
    const elapsedSeconds = Math.round((Date.now() - (live?.startedAt ?? Date.now())) / 1000);
    this.#runs.delete(session.id);

    ledger.settle(task.id, { seconds: elapsedSeconds });
    this.#persistLedger(ledger);

    const current = this.store.tasks.get(task.id);
    // A task já está esperando decisão humana (orçamento estourado ou ação
    // barrada pela vigilância): o fim do processo não pode sobrescrever esse
    // estado com "falhou", senão a aprovação apontaria para uma sessão morta.
    if (current && current.state === 'input_required') {
      const pendente = this.store.approvals.listPending({ sessionId: session.id })[0];
      this.#emit({
        sessionId: session.id,
        taskId: task.id,
        agentId: session.agentId,
        type: 'session.ended',
        payload: {
          // Dizer "orçamento esgotado" para uma pausa da vigilância faria a
          // timeline mentir sobre o próprio motivo da parada.
          reason: pendente ? `aguardando aprovação: ${pendente.action}` : 'aguardando decisão humana',
          approvalId: pendente?.id ?? null,
          outcome,
        },
      });
      return;
    }

    await this.#settle(session, current ?? task, outcome, elapsedSeconds);
  }

  /**
   * Decide o destino de uma run que terminou (ADR 04.3).
   *
   * Sucesso ainda não é entrega: passa pelo portão de validação antes de ser
   * aceito. Falha não é fim: passa pela cadeia retry → fallback. Só quando os
   * dois se esgotam a task morre — e morre mesmo, sem ficar pendurada
   * esperando alguém aparecer (ADR 06.1).
   */
  async #settle(
    session: Session,
    task: Task,
    outcome: RunOutcome,
    elapsedSeconds: number,
  ): Promise<void> {
    const outcomeClass = classifyOutcome(outcome);
    let attempts = closeLastAttempt(task.attempts, outcomeClass, outcome.error);

    this.#emit({
      sessionId: session.id,
      taskId: task.id,
      agentId: session.agentId,
      type: outcomeClass === 'success' ? 'turn.completed' : 'error',
      payload: {
        reason: outcome.reason,
        exitCode: outcome.exitCode,
        error: outcome.error,
        elapsedSeconds,
        outcomeClass,
      },
    });

    // --- sucesso: o portão de validação ainda pode reprovar -----------------
    let effectiveClass = outcomeClass;
    let validation: ValidationOutcome | null = null;

    if (outcomeClass === 'success') {
      validation = await runValidation(this.policyFor(session).policy.validation, {
        workdir: session.workdir,
        acceptanceCriteria: task.brief.acceptanceCriteria,
      });

      // O portão de revisão roda DEPOIS do comando: reprovar no build é barato
      // e determinístico, e não faz sentido pagar uma sessão de modelo para
      // revisar código que nem compila.
      if (validationPassed(validation)) {
        const artefatos = await this.#capturarMudancas(session, task);
        const revisao = await this.#revisar(session, task, artefatos);

        if (revisao && !revisao.passed) {
          validation = {
            passed: false,
            checks: [...(validation?.checks ?? []), ...revisao.checks],
          };
          this.#emit({
            sessionId: session.id,
            taskId: task.id,
            agentId: session.agentId,
            type: 'error',
            payload: { message: `revisão reprovou: ${revisao.checks[0]?.detail ?? ''}` },
          });
        }
      }

      if (validationPassed(validation)) {
        const artefatos = this.store.artifacts
          .list({ sessionId: session.id })
          .filter((a) => a.taskId === task.id)
          .map((a) => a.id);

        this.store.tasks.update(task.id, {
          state: 'completed',
          attempts,
          result: {
            summary: this.#summarize(session.id, task.id),
            artifacts: artefatos,
            usage: { ...this.store.events.costOf(session.id), seconds: elapsedSeconds },
            ...(validation ? { validation } : {}),
          },
        });
        await this.#concludeSession(session, task, 'completed', null);
        return;
      }

      const detail = validation?.checks.map((c) => c.detail).filter(Boolean).join(' | ') ?? '';
      this.#emit({
        sessionId: session.id,
        taskId: task.id,
        agentId: session.agentId,
        type: 'error',
        payload: { message: `validação reprovou: ${detail}`, validation },
      });

      // Reprovar na validação volta para o retry (ADR 06), porque agora temos
      // algo concreto para dizer ao agente — é a tentativa com mais chance de
      // dar certo de todas.
      effectiveClass = 'transient';
      attempts = closeLastAttempt(attempts, 'invalid', detail || 'validação reprovou');
    }

    // --- falha: retry → fallback → desistir ---------------------------------
    const step = nextStep(
      { attempts, currentAgentId: session.agentId },
      effectiveClass,
      {
        maxRetries: this.config.policy.retries.max,
        backoffMs: this.config.policy.retries.backoffMs,
        fallbackChain: this.#fallbackChain(session.agentId),
      },
    );

    this.store.tasks.update(task.id, { attempts });

    if (step.kind === 'retry') {
      await this.#retry(session, task, step.agentId, step.backoffMs, step.reason, validation);
      return;
    }

    if (step.kind === 'fallback') {
      await this.#fallback(session, task, step.agentId, step.reason);
      return;
    }

    this.store.tasks.update(task.id, { state: 'failed' });
    this.#emit({
      sessionId: session.id,
      taskId: task.id,
      agentId: session.agentId,
      type: 'error',
      payload: {
        // Alta prioridade porque é o fim da linha: ninguém mais vai tentar.
        priority: 'high',
        message: `tarefa encerrada sem sucesso — ${step.reason}`,
        attempts: attempts.length,
        lastError: outcome.error,
      },
    });
    await this.#concludeSession(session, task, 'failed', outcome.error);
  }

  /** Nova tentativa com o mesmo agente, dizendo a ele o que deu errado. */
  async #retry(
    session: Session,
    task: Task,
    agentId: string,
    backoffMs: number,
    reason: string,
    validation: ValidationOutcome | null,
  ): Promise<void> {
    this.#emit({
      sessionId: session.id,
      taskId: task.id,
      agentId,
      type: 'log',
      payload: { level: 'warn', text: `nova tentativa em ${backoffMs}ms — ${reason}` },
    });

    await sleep(backoffMs);

    // A sessão pode ter sido cancelada enquanto esperávamos o backoff.
    const fresh = this.store.sessions.get(session.id);
    if (!fresh || fresh.state === 'killed' || fresh.state === 'waiting_approval') return;

    // Verifica o teto de concorrência antes de criar nova tentativa —
    // o mesmo controle que #fallback() já faz para o substituto.
    try {
      this.#assertConcurrency(agentId);
    } catch (err) {
      this.store.tasks.update(task.id, { state: 'failed' });
      this.#emit({
        sessionId: session.id,
        taskId: task.id,
        agentId,
        type: 'error',
        payload: { priority: 'high', message: `retry recusado: ${(err as Error).message}` },
      });
      return;
    }


    // Relê do banco: `#settle` acabou de fechar a tentativa anterior com o
    // desfecho dela. Usar o `task` recebido aqui reescreveria o histórico com
    // a versão sem desfecho, e a auditoria perderia o motivo de cada falha.
    const anterior = this.store.tasks.get(task.id) ?? task;
    const updated = this.store.tasks.update(task.id, {
      attempts: [...anterior.attempts, novaTentativa(anterior.attempts.length + 1, agentId)],
    });

    const feedback = validation
      ? `A tentativa anterior terminou, mas a validação reprovou:\n${validation.checks
          .map((c) => `- ${c.name}: ${c.detail ?? 'reprovou'}`)
          .join('\n')}\n\nCorrija exatamente isso e conclua.`
      : `A tentativa anterior falhou (${reason}). Continue de onde parou.`;

    // Retomar a sessão nativa é bem mais barato que reenviar o brief inteiro,
    // e o agente já sabe o que tentou.
    const canResume =
      this.registry.get(agentId).manifest.session.strategy === 'native' &&
      fresh.nativeSessionId !== null;

    await this.#launch(
      fresh,
      updated,
      canResume ? feedback : `${renderBriefAsPrompt(task.brief)}\n\n${feedback}`,
      canResume ? fresh.nativeSessionId : null,
    );
  }

  /**
   * Passa a tarefa para o próximo agente da cadeia.
   *
   * O substituto entra como IRMÃO no grafo, não como filho: ele não foi
   * chamado pelo que falhou, ele o está substituindo — e ver os dois lado a
   * lado é o que deixa claro que houve uma troca.
   */
  async #fallback(
    session: Session,
    task: Task,
    agentId: string,
    reason: string,
  ): Promise<void> {
    this.#emit({
      sessionId: session.id,
      taskId: task.id,
      agentId: session.agentId,
      type: 'log',
      payload: { level: 'warn', text: `passando a tarefa para ${agentId} — ${reason}` },
    });

    await this.#concludeSession(session, task, 'failed', reason, { silentParent: true });

    const project = this.store.projects.get(session.projectId);
    if (!project) return;

    // O substituto é um processo novo como qualquer outro: uma cadeia de
    // fallbacks em paralelo não pode furar o teto de concorrência.
    try {
      this.#assertConcurrency(agentId);
    } catch (err) {
      this.store.tasks.update(task.id, { state: 'failed' });
      this.#emit({
        sessionId: session.id,
        taskId: task.id,
        agentId: session.agentId,
        type: 'error',
        payload: { priority: 'high', message: `fallback recusado: ${(err as Error).message}` },
      });
      return;
    }

    const sessionId = newId('ses');
    const worktree = await this.worktrees.create({
      projectPath: project.path,
      projectName: project.name,
      sessionId,
      isolation: session.isolation,
    });

    const replacement: Session = {
      ...session,
      id: sessionId,
      agentId,
      nativeSessionId: null,
      // Mesma posição no grafo: troca de executor, não novo nível.
      path: [...session.path.slice(0, -1), pathKey(agentId, task.brief.objective)],
      state: 'running',
      workdir: worktree.path,
      title: session.title,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
    };

    this.store.sessions.create(replacement);
    this.bus.registerSession(sessionId, replacement.rootId);

    const anterior = this.store.tasks.get(task.id) ?? task;
    const updated = this.store.tasks.update(task.id, {
      sessionId,
      attempts: [...anterior.attempts, novaTentativa(anterior.attempts.length + 1, agentId)],
    });

    // O histórico de falhas vai junto: sem ele o substituto recomeça cego e
    // tende a cair no mesmo buraco.
    const prompt = [renderBriefAsPrompt(task.brief), failureContext(updated.attempts)]
      .filter((part) => part.length > 0)
      .join('\n\n');

    await this.#launch(replacement, updated, prompt, null);
  }

  /** Cadeia de fallback do agente, já filtrando quem não está instalado. */
  #fallbackChain(agentId: string): string[] {
    return this.registry
      .fallbackFor(agentId, this.config.policy.fallback)
      .filter((id) => this.registry.cachedProbe(id)?.installed !== false);
  }

  /** Fecha a sessão, avisa o pai e libera o que precisa ser liberado. */
  async #concludeSession(
    session: Session,
    task: Task,
    state: 'completed' | 'failed',
    error: string | null,
    options: { silentParent?: boolean } = {},
  ): Promise<void> {
    // Numa troca de agente o pai não deve ouvir "falhou": a tarefa dele
    // continua viva, só mudou de mãos.
    if (session.parentId && options.silentParent !== true) {
      const parent = this.store.sessions.get(session.parentId);
      if (parent) {
        this.#emit({
          sessionId: parent.id,
          taskId: task.id,
          agentId: parent.agentId,
          type: 'delegation.completed',
          payload: {
            childSessionId: session.id,
            agentId: session.agentId,
            state,
            error,
          },
        });
      }
    }

    await this.#finish(session.id, state, error ?? undefined);
  }

  /**
   * Olha um evento recém-chegado e decide se ele merece alerta ou parada.
   *
   * Retorna 'paused' quando a sessão foi interrompida e uma aprovação foi
   * aberta — o chamador precisa matar a run.
   */
  #watch(session: Session, task: Task, mapped: MappedEvent): 'ok' | 'flagged' | 'paused' {
    const actions = guardedActionsOf(mapped, session.workdir);
    if (actions.length === 0) return 'ok';

    const engine = this.policyFor(session);
    const watch = watchForMode(this.config.policy.watch, session.mode);

    let flagged = false;
    for (const action of actions) {
      const { risk, reason } = engine.classify(action, {
        workdir: session.workdir,
        mode: session.mode,
      });

      if (watch.pauseOn.includes(risk)) {
        this.#requestApproval({
          session,
          taskId: task.id,
          risk,
          action: describeAction(action),
          detail: { kind: 'watch', reason, eventType: mapped.type, alreadyExecuted: true },
        });
        return 'paused';
      }

      if (watch.flagOn.includes(risk)) {
        this.#emit({
          sessionId: session.id,
          taskId: task.id,
          agentId: session.agentId,
          type: 'log',
          payload: {
            level: 'warn',
            text: `ação de risco "${risk}": ${describeAction(action)} — ${reason}`,
          },
        });
        flagged = true;
      }
    }

    return flagged ? 'flagged' : 'ok';
  }

  /**
   * Próximo `seq` da sessão, semeado do banco na primeira vez que a vemos.
   *
   * O contador vive em memória, mas a sessão vive no banco: depois de o daemon
   * reiniciar, emitir um evento numa sessão antiga recomeçaria do 1 e colidiria
   * com a chave única `(session_id, seq)`. Isso derrubava operações inteiras —
   * cancelar ou negar uma aprovação de antes do restart falhava com um erro de
   * SQLite que não dizia nada sobre a causa real.
   */
  #nextSeq(sessionId: string): number {
    if (!this.#seeded.has(sessionId)) {
      this.#seq.seed(sessionId, this.store.events.lastSeq(sessionId));
      this.#seeded.add(sessionId);
    }
    return this.#seq.next(sessionId);
  }

  /**
   * Preenche o custo em dólares antes de o evento virar histórico.
   *
   * Metade dos agentes reporta só tokens — o Codex é o caso claro. Sem esta
   * etapa, o orçamento em dólares do fluxo simplesmente não se aplicaria a
   * eles, e o painel mostraria "US$ 0,0000" para uma sessão que obviamente
   * custou dinheiro. Estimar é melhor que fingir que foi de graça, desde que
   * fique registrado que é estimativa: `costBasis` viaja no payload para a UI
   * poder mostrar a diferença.
   */
  #priceEvent(session: Session, mapped: MappedEvent): MappedEvent {
    // O modelo costuma aparecer uma vez, no início da sessão; guardamos para
    // precificar os eventos seguintes, que não o repetem.
    const declarado = mapped.payload['model'];
    if (typeof declarado === 'string' && declarado.length > 0) {
      this.#models.set(session.id, declarado);
    }

    if (!mapped.cost) return mapped;

    const estimate = resolveEventCost(mapped.cost, {
      model: this.#models.get(session.id),
      agentId: session.agentId,
    });

    // `unknown` significa que não sabemos, não que foi zero: deixamos o campo
    // como veio para não inventar um número com cara de exato.
    if (estimate.basis === 'unknown') return mapped;

    return {
      ...mapped,
      cost: { ...mapped.cost, usd: estimate.usd },
      payload: {
        ...mapped.payload,
        costBasis: estimate.basis,
        costConfidence: estimate.confidence,
        ...(estimate.model ? { costModel: estimate.model } : {}),
      },
    };
  }

  #persistMapped(session: Session, task: Task, mapped: MappedEvent): void {
    const event = makeEvent(
      {
        sessionId: session.id,
        taskId: task.id,
        agentId: session.agentId,
        type: mapped.type,
        payload: mapped.payload,
        cost: mapped.cost ?? null,
        raw: mapped.raw,
      },
      this.#nextSeq(session.id),
    );
    this.store.events.append(event);
    this.bus.publish(event);
  }

  #emit(draft: {
    sessionId: string;
    taskId: string | null;
    agentId: string;
    type: EventEnvelope['type'];
    payload: Record<string, unknown>;
  }): void {
    const event = makeEvent(
      { ...draft, cost: null, raw: null },
      this.#nextSeq(draft.sessionId),
    );
    this.store.events.append(event);
    this.bus.publish(event);
  }

  async #finish(sessionId: string, state: Session['state'], _reason?: string): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session) return;

    this.store.sessions.update(sessionId, { state, endedAt: nowIso() });
    this.bus.forgetSession(sessionId);

    // O worktree DELIBERADAMENTE sobrevive ao fim da sessão (ADR 06.3): é a
    // janela em que você consegue abrir o diretório e ver o que o agente fez.
    // Quem recolhe é o WorktreeReaper, depois do prazo de retenção.
  }

  /**
   * Revisão cruzada: um SEGUNDO agente olha o resultado do primeiro.
   *
   * É o único portão capaz de julgar os critérios de aceite em linguagem
   * natural — o portão de comando só sabe dizer se compila. Custa uma sessão de
   * modelo por tarefa, e por isso é opt-in (`policy.validation.review.enabled`).
   *
   * Até agora esse campo existia na configuração, era herdado na interseção e
   * aparecia na documentação, mas nada o consumia: quem ligasse não recebia
   * revisão nenhuma, em silêncio.
   */
  async #revisar(
    session: Session,
    task: Task,
    artefatos: string[],
  ): Promise<ValidationOutcome | null> {
    const politica = this.policyFor(session).policy.validation.review;
    if (!politica.enabled) return null;

    // Diff vazio NÃO é aprovação automática.
    //
    // Observado num teste real: o agente foi barrado pelo próprio sandbox,
    // disse "não foi possível criar o arquivo", saiu com código 0 — e a task
    // foi marcada como concluída. "Terminou limpo" e "fez o que foi pedido"
    // continuam sendo coisas diferentes, e é justamente aqui que divergem.
    //
    // O Hub não sabe se a tarefa deveria mudar arquivos (análise não muda). O
    // revisor sabe, porque tem os critérios de aceite — então a pergunta vai
    // para ele, com o fato explícito de que nada mudou.
    let revisor: string;
    try {
      revisor = this.registry.resolveTarget(
        politica.agent ?? 'cap:code-review',
        this.config.policy.fallback,
      );
    } catch {
      return {
        passed: true,
        checks: [
          { name: 'revisão', passed: true, detail: 'nenhum agente de revisão disponível — portão ignorado' },
        ],
      };
    }

    // O revisor não pode ser quem escreveu: revisar o próprio trabalho é
    // exatamente o viés que a revisão existe para evitar.
    if (revisor === session.agentId) {
      const alternativa = this.#fallbackChain(session.agentId)[0];
      if (!alternativa) {
        return {
          passed: true,
          checks: [
            { name: 'revisão', passed: true, detail: 'só há um agente disponível; sem revisor independente' },
          ],
        };
      }
      revisor = alternativa;
    }

    return this.#executarRevisao(session, task, revisor);
  }

  /**
   * Roda o revisor num processo efêmero e interpreta o veredito.
   *
   * NÃO cria sessão do Hub: uma revisão não é trabalho delegado, é um portão de
   * qualidade. Virar sessão poluiria o grafo com nós que ninguém pediu e faria
   * o custo da revisão parecer uma delegação do agente.
   */
  async #executarRevisao(
    session: Session,
    task: Task,
    revisorId: string,
  ): Promise<ValidationOutcome> {
    const adapter = this.registry.get(revisorId);
    const diff = await captureDiff(session.workdir);
    // Sem o que o agente disse, o revisor não vê a discrepância entre o
    // relato e o resultado — que foi exatamente o caso que motivou isto.
    const resumoDoAgente = this.#summarize(session.id, task.id);

    const prompt = [
      '# Revisão de código',
      '',
      'Outro agente executou a tarefa abaixo. Revise o que ele mudou.',
      '',
      '## Tarefa original',
      '',
      task.brief.objective,
      '',
      ...(task.brief.acceptanceCriteria.length > 0
        ? ['## Critérios de aceite', '', ...task.brief.acceptanceCriteria.map((c) => `- ${c}`), '']
        : []),
      ...(task.brief.constraints.length > 0
        ? ['## Restrições', '', ...task.brief.constraints.map((c) => `- ${c}`), '']
        : []),
      '## Mudanças',
      '',
      ...(diff && !diff.empty
        ? [
            `${diff.filesChanged} arquivo(s) alterado(s), +${diff.insertions} −${diff.deletions}`,
            ...(diff.untracked.length > 0
              ? [`Arquivos novos: ${diff.untracked.join(', ')}`]
              : []),
            '',
            '```diff',
            diff.patch.slice(0, 60_000),
            '```',
          ]
        : [
            'O AGENTE NÃO ALTEROU NENHUM ARQUIVO.',
            '',
            'Se a tarefa exigia mudança de código, isso é uma reprovação — pode ter',
            'sido bloqueio de permissão, engano do agente ou tarefa mal compreendida.',
            'Se a tarefa era de análise ou resposta, não alterar nada é o esperado.',
          ]),
      '',
      '## O que o agente respondeu',
      '',
      resumoDoAgente,
      '',
      '## Como responder',
      '',
      'Responda em UMA linha, começando exatamente com APROVADO ou REPROVADO,',
      'seguido de um motivo curto. Reprove apenas se um critério de aceite não',
      'foi atendido ou se há defeito claro — não reprove por estilo.',
    ].join(NEWLINE_PROMPT);

    const ctx: RunContext = {
      sessionId: session.id,
      taskId: task.id,
      agentId: revisorId,
      workdir: session.workdir,
      mode: session.mode,
      env: {},
      timeoutSeconds: Math.min(600, this.config.policy.taskTimeoutSeconds),
      heartbeatSeconds: this.config.policy.heartbeatTimeoutSeconds,
    };

    try {
      const handle = await adapter.start(ctx, prompt);
      const textos: string[] = [];

      for await (const evento of handle.events) {
        if (evento.type === 'message') {
          const texto = evento.payload['text'];
          if (typeof texto === 'string') textos.push(texto);
        }
        // O custo da revisão é do fluxo como qualquer outro: sai do mesmo
        // orçamento, senão ligar a revisão furaria o teto em silêncio.
        if (evento.cost) {
          this.#ledger(session.rootId).charge({
            usd: evento.cost.usd ?? 0,
            tokens: (evento.cost.inputTokens ?? 0) + (evento.cost.outputTokens ?? 0),
            seconds: 0,
          });
        }
      }

      await handle.done;
      this.#persistLedger(this.#ledger(session.rootId));

      return interpretarRevisao(textos.join(' '), revisorId);
    } catch (err) {
      // Revisor quebrado não pode reprovar trabalho bom: falhar aqui e barrar a
      // entrega puniria o agente executor por um problema que não é dele.
      return {
        passed: true,
        checks: [
          {
            name: `revisão (${revisorId})`,
            passed: true,
            detail: `revisor indisponível (${(err as Error).message}) — portão ignorado`,
          },
        ],
      };
    }
  }

  /**
   * Registra o que a sessão mudou no código.
   *
   * Sem isto, `TaskResult.artifacts` era sempre `[]` e a tabela de artefatos
   * nunca via uma linha: o Hub sabia quanto custou e o que o agente disse, mas
   * não o que ele efetivamente escreveu. O diff é a resposta à pergunta que
   * sempre vem primeiro.
   */
  async #capturarMudancas(session: Session, task: Task): Promise<string[]> {
    const capture = await captureDiff(session.workdir);
    if (!capture || capture.empty) return [];

    const arquivo = await persistDiff(this.config.artifactRoot, session.id, capture);
    if (!arquivo) return [];

    const artifact: Artifact = {
      id: newId('art'),
      sessionId: session.id,
      taskId: task.id,
      kind: 'diff',
      path: arquivo,
      hash: null,
      createdAt: nowIso(),
    };
    this.store.artifacts.create(artifact);

    this.#emit({
      sessionId: session.id,
      taskId: task.id,
      agentId: session.agentId,
      type: 'file.changed',
      payload: {
        summary: `${capture.filesChanged} arquivo(s), +${capture.insertions} −${capture.deletions}`,
        untracked: capture.untracked,
        artifactId: artifact.id,
      },
    });

    return [artifact.id];
  }

  listArtifacts(sessionId: string): Artifact[] {
    return this.store.artifacts.list({ sessionId });
  }

  /** Último texto do agente — serve de resumo quando ele não produz um. */
  #summarize(sessionId: string, taskId: string): string {
    // Para pegar os ÚLTIMOS 200 eventos (não os primeiros), calculamos o offset
    // via lastSeq: sinceSeq = max(0, lastSeq - 200) garante uma janela que
    // cobre o fim da sessão mesmo quando há mais de 200 eventos no total.
    const WINDOW = 200;
    const last = this.store.events.lastSeq(sessionId);
    const sinceSeq = Math.max(0, last - WINDOW);
    const messages = this.store.events.list({
      sessionId,
      taskId,
      types: ['message', 'turn.completed'],
      sinceSeq,
      limit: WINDOW,
    });
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const payload = messages[i]?.payload ?? {};
      const text = (payload['summary'] ?? payload['text']) as unknown;
      if (typeof text === 'string' && text.trim().length > 0) return text.slice(0, 4000);
    }
    return 'sessão concluída sem resumo textual';
  }

  #assertConcurrency(agentId: string): void {
    const total = this.#runs.size;
    if (total >= this.config.policy.maxConcurrency) {
      throw new HubError(
        'CONCURRENCY_EXCEEDED',
        `Limite de ${this.config.policy.maxConcurrency} sessões simultâneas atingido`,
        { active: total, limit: this.config.policy.maxConcurrency },
      );
    }

    const perAgent = [...this.#runs.values()].filter(
      (r) => r.ctx.agentId === agentId,
    ).length;
    if (perAgent >= this.config.policy.maxConcurrencyPerAgent) {
      throw new HubError(
        'CONCURRENCY_EXCEEDED',
        `Limite de ${this.config.policy.maxConcurrencyPerAgent} sessões simultâneas para "${agentId}" atingido`,
        { agentId, active: perAgent },
      );
    }
  }

  #ledger(rootId: string, initialLimits?: BudgetLimits): BudgetLedger {
    const cached = this.#ledgers.get(rootId);
    if (cached) return cached;

    const record = this.store.budgets.ensure(
      rootId,
      initialLimits ?? this.config.policy.defaultBudget,
    );
    const ledger = new BudgetLedger(rootId, record.limits, record.consumed, ZERO_USAGE);
    this.#ledgers.set(rootId, ledger);
    return ledger;
  }

  #persistLedger(ledger: BudgetLedger): void {
    const snapshot = ledger.snapshot();
    this.store.budgets.upsert({
      rootId: ledger.rootId,
      limits: snapshot.limits,
      consumed: snapshot.consumed,
      reserved: snapshot.reserved,
      updatedAt: nowIso(),
    });
  }

  #session(sessionId: string): Session {
    const session = this.store.sessions.get(sessionId);
    if (!session) {
      throw new HubError('SESSION_NOT_FOUND', `Sessão ${sessionId} não encontrada`, { sessionId });
    }
    return session;
  }

  #latestTask(sessionId: string): Task {
    const [task] = this.store.tasks.list({ sessionId });
    if (!task) {
      throw new HubError('TASK_NOT_FOUND', `Nenhuma task na sessão ${sessionId}`, { sessionId });
    }
    return task;
  }

  /**
   * Política efetiva de uma sessão.
   *
   * Numa sessão-raiz é a política do Hub; num filho é a interseção com a do
   * pai, que é o que garante que delegar nunca aumente privilégio (ADR 03).
   */
  policyFor(session: Session, visited = new Set<string>()): PolicyEngine {
    const base = new PolicyEngine(this.#projectPolicy(session.projectId));
    if (!session.parentId || visited.has(session.id)) return base;
    visited.add(session.id);

    const parent = this.store.sessions.get(session.parentId);
    if (!parent) return base;

    return this.policyFor(parent, visited).intersect(base.policy);
  }

  /**
   * Política global com os ajustes do projeto aplicados por cima (ADR 05.2).
   *
   * O projeto só consegue APERTAR — a fusão garante isso. Um repositório que
   * pudesse elevar o próprio teto transformaria qualquer clone malicioso em
   * execução arbitrária.
   */
  #projectPolicy(projectId: string): PolicyDocument {
    const project = this.store.projects.get(projectId);
    if (!project) return this.config.policy;
    return mergeProjectPolicy(this.config.policy, loadProjectOverrides(project.path));
  }

  briefOf(sessionId: string): Brief {
    return this.#latestTask(sessionId).brief;
  }
}

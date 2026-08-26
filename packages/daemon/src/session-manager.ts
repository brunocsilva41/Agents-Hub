import path from 'node:path';
import {
  BudgetLedger,
  HubError,
  PolicyEngine,
  SequenceCounter,
  ZERO_USAGE,
  buildGraph,
  checkDelegation,
  inheritMode,
  makeEvent,
  newId,
  nowIso,
  parseBrief,
  pathKey,
  renderBriefAsPrompt,
  type Brief,
  type BudgetSnapshot,
  type EventEnvelope,
  type GraphNode,
  type IsolationMode,
  type Project,
  type Session,
  type SessionMode,
  type Task,
  type UnitOfWork,
} from '@agents-hub/core';
import type { AgentRegistry, MappedEvent, RunContext, RunHandle } from '@agents-hub/adapters';
import type { InMemoryEventBus } from './bus.js';
import type { HubConfig } from './config.js';
import type { WorktreeManager } from './worktree.js';

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
    return this.store.projects.create({
      name: name ?? path.basename(absolute),
      path: absolute,
      defaultBranch: 'main',
    });
  }

  listProjects(): Project[] {
    return this.store.projects.list();
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

    // --- orçamento: reserva sai do saldo da RAIZ ----------------------------
    const ledger = this.#ledger(rootId);
    const taskId = newId('tsk');
    ledger.reserve(taskId, {
      usd: brief.budget.usd ?? undefined,
      tokens: brief.budget.tokens ?? undefined,
      seconds: brief.budget.seconds ?? undefined,
    });
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

    await this.#launch(session, task, renderBriefAsPrompt(brief), null);

    return { session, task, budget: ledger.snapshot() };
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

    const task = this.#latestTask(sessionId);
    const canResume =
      adapter.manifest.session.strategy === 'native' && session.nativeSessionId !== null;

    await this.#launch(session, task, text, canResume ? session.nativeSessionId : null);
    return { mode: canResume ? 'resume' : 'replay' };
  }

  async interrupt(sessionId: string): Promise<void> {
    const live = this.#runs.get(sessionId);
    if (!live) return;
    await this.registry.get(this.#session(sessionId).agentId).interrupt(live.handle);
  }

  async cancel(sessionId: string, reason = 'cancelado pelo usuário'): Promise<void> {
    const session = this.#session(sessionId);
    const live = this.#runs.get(sessionId);
    if (live) await this.registry.get(session.agentId).cancel(live.handle);

    // Cancelar um pai cancela a subárvore: deixar filhos órfãos rodando é como
    // agentes continuam gastando orçamento de um fluxo que você já abortou.
    for (const child of this.store.sessions.children(sessionId)) {
      if (child.state === 'running' || child.state === 'waiting_approval') {
        await this.cancel(child.id, `pai ${sessionId} cancelado`);
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

  // ---------------------------------------------------------------- consultas

  getSession(sessionId: string): Session {
    return this.#session(sessionId);
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

  budget(rootId: string): BudgetSnapshot {
    return this.#ledger(rootId).snapshot();
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

    this.#seq.seed(session.id, this.store.events.lastSeq(session.id));
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
      for await (const mapped of handle.events) {
        this.#persistMapped(session, task, mapped);

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
            // Estouro é decisão humana por definição (ADR 03): paramos o agente
            // e deixamos a task esperando você, sem matar o trabalho já feito.
            this.#emit({
              sessionId: session.id,
              taskId: task.id,
              agentId: session.agentId,
              type: 'budget.exceeded',
              payload: { snapshot },
            });
            this.store.tasks.update(task.id, { state: 'input_required' });
            this.store.sessions.update(session.id, { state: 'waiting_approval' });
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
    const elapsedSeconds = Math.round((Date.now() - (this.#runs.get(session.id)?.startedAt ?? Date.now())) / 1000);
    this.#runs.delete(session.id);

    ledger.settle(task.id, { seconds: elapsedSeconds });
    this.#persistLedger(ledger);

    const current = this.store.tasks.get(task.id);
    // Se o orçamento já colocou a task em `input_required`, o fim do processo
    // não deve sobrescrever esse estado com "falhou".
    if (current && current.state === 'input_required') {
      this.#emit({
        sessionId: session.id,
        taskId: task.id,
        agentId: session.agentId,
        type: 'session.ended',
        payload: { reason: 'orçamento esgotado', outcome },
      });
      return;
    }

    const failed = outcome.reason !== 'exit' || (outcome.exitCode ?? 0) !== 0;
    const attempts = (current?.attempts ?? task.attempts).map((a, i, arr) =>
      i === arr.length - 1
        ? {
            ...a,
            endedAt: nowIso(),
            outcome: failed ? ('error' as const) : ('success' as const),
            error: outcome.error,
          }
        : a,
    );

    this.store.tasks.update(task.id, {
      state: failed ? 'failed' : 'completed',
      attempts,
      result: failed
        ? null
        : {
            summary: this.#summarize(session.id, task.id),
            artifacts: [],
            usage: {
              ...this.store.events.costOf(session.id),
              seconds: elapsedSeconds,
            },
          },
    });

    this.#emit({
      sessionId: session.id,
      taskId: task.id,
      agentId: session.agentId,
      type: failed ? 'error' : 'turn.completed',
      payload: {
        reason: outcome.reason,
        exitCode: outcome.exitCode,
        error: outcome.error,
        elapsedSeconds,
      },
    });

    // Avisa o pai de que a delegação terminou — é o que permite ao chamador
    // reagir sem ficar em polling.
    if (session.parentId) {
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
            state: failed ? 'failed' : 'completed',
            error: outcome.error,
          },
        });
      }
    }

    await this.#finish(session.id, failed ? 'failed' : 'completed', outcome.error ?? undefined);
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
      this.#seq.next(session.id),
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
      this.#seq.next(draft.sessionId),
    );
    this.store.events.append(event);
    this.bus.publish(event);
  }

  async #finish(sessionId: string, state: Session['state'], _reason?: string): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session) return;

    this.store.sessions.update(sessionId, { state, endedAt: nowIso() });
    this.bus.forgetSession(sessionId);

    if (session.isolation === 'worktree') {
      const project = this.store.projects.get(session.projectId);
      if (project) {
        await this.worktrees.release({
          projectPath: project.path,
          worktreePath: session.workdir,
        });
      }
    }
  }

  /** Último texto do agente — serve de resumo quando ele não produz um. */
  #summarize(sessionId: string, taskId: string): string {
    const messages = this.store.events.list({
      sessionId,
      taskId,
      types: ['message', 'turn.completed'],
      limit: 200,
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

  #ledger(rootId: string): BudgetLedger {
    const cached = this.#ledgers.get(rootId);
    if (cached) return cached;

    const record = this.store.budgets.ensure(rootId, this.config.policy.defaultBudget);
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

  /** Exposto para o motor de política das próximas fases. */
  policyFor(session: Session): PolicyEngine {
    return new PolicyEngine(this.config.policy).intersect(this.config.policy);
  }

  briefOf(sessionId: string): Brief {
    return this.#latestTask(sessionId).brief;
  }
}

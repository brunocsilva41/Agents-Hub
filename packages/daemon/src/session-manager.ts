import os from 'node:os';
import path from 'node:path';
import {
  BudgetLedger,
  HubError,
  PolicyEngine,
  SequenceCounter,
  ZERO_USAGE,
  buildGraph,
  checkDelegation,
  classifyOutcome,
  closeLastAttempt,
  failureContext,
  nextStep,
  novaTentativa,
  validationPassed,
  inheritMode,
  isTerminalSessionState,
  isTerminalTaskState,
  makeEvent,
  newId,
  nowIso,
  parseBrief,
  pathKey,
  rebuildConversation,
  renderBriefAsPrompt,
  type ContextoDoProjeto,
  resolveEventCost,
  TurnCostTracker,
  usoDoCusto,
  EVENTOS_NARRATIVOS,
  watchForMode,
  agentOwnDirs,
  type Approval,
  type Artifact,
  type Brief,
  type BudgetLimits,
  type BudgetProjection,
  type Decision,
  type BudgetSnapshot,
  type EventEnvelope,
  type GraphNode,
  type IsolationMode,
  type Project,
  type ProjectFolder,
  type Session,
  type SessionMode,
  type PolicyDocument,
  type RiskLevel,
  type Task,
  type ValidationOutcome,
  type UnitOfWork,
} from '@agents-hub/core';
import {
  killProcessTree,
  imagemDoProcesso,
  imagemPareceEsperada,
  resolveBin,
  horarioDeCriacaoDoProcesso,
  pidPareceReciclado,
  describeAction,
  avaliarVigilancia,
} from '@agents-hub/adapters';
import type {
  AgentRegistry,
  MappedEvent,
  RunContext,
  RunHandle,
  RunOutcome,
} from '@agents-hub/adapters';
import type { InMemoryEventBus } from './bus.js';
import type { HubConfig } from './config.js';
import { cliHookEntrypoint } from './config.js';
import { juntarErroDoAgente, textoDoErroDoAgente } from './agent-error-text.js';
import { recusaDeSessaoTerminada } from './session-continuation.js';
import {
  montarConfigDoGate,
  modoExigeGate,
  segmentoDeComando,
  TIMEOUT_PADRAO_SEC,
} from './codex-gate.js';
import {
  contextForAgent,
  envForAgent,
  loadProjectContext,
  loadProjectOverrides,
  type ProjectContext,
} from './project-config.js';
import { effectiveProjectContext, repoTrustWarning } from './repo-trust.js';
import { captureBaseline, captureDiff, loadBaseline, saveBaseline } from './diff-capture.js';
import { capturarMudancas } from './artifact-capture.js';
import { baseDoAcumulado, CUSTO_FECHADO } from './turn-cost-base.js';
import { interpretarRevisao } from './review-verdict.js';
import {
  actionsOfToolCall,
  combineVerdicts,
  ESPERA_DO_GATE_MS,
  resumoDaChamada,
} from './pretool-gate.js';
import { TetoDeSaida, limitarPagina } from './event-limits.js';
import { runValidation } from './validation.js';
import { CicloDeVida, esperarAbortavel, type PedidoDeParada } from './session-lifecycle.js';
import type { WorktreeManager } from './worktree.js';
import { ProjectRegistry, type RepoConfigStatus } from './project-registry.js';
import { policyFor as resolvePolicyFor, projectPolicyFor } from './effective-policy.js';
import { resolverBases } from './session-bases.js';
import { branchExiste, commitarTrabalho, juntarBranches } from './worktree-commit.js';

/** Quebra de linha literal para montar prompt sem brigar com escapes. */
const NEWLINE_PROMPT = String.fromCharCode(10);

/**
 * Quanto cancel/interrupt/pause esperam o pump fechar a sessão antes de
 * responder. Com teto: um adapter cujo stream não fecha não pode pendurar a
 * rota HTTP (o cancelamento então fecha a sessão por conta própria).
 */
const ESPERA_DO_FECHAMENTO_MS = 10_000;

export interface StartSessionInput {
  projectId: string;
  agentId: string;
  brief: unknown;
  /** Sessão que pediu. `null` = você, pela CLI/UI (sessão-raiz). */
  requesterSessionId?: string | null;
  title?: string;
  /**
   * Sessões de cujo trabalho o worktree desta deve partir (passo seguinte de
   * um workflow). O worktree nasce do branch `hub/<id>` da primeira e junta as
   * demais por merge; conflito recusa a sessão com erro explícito.
   */
  baseSessionIds?: string[];
}

export interface StartSessionResult {
  session: Session;
  task: Task;
  budget: BudgetSnapshot;
  /** Presente quando a delegação ficou retida esperando sua decisão. */
  approval?: Approval;
}

/** O que `start()` já fez e precisa desfazer se lançar no meio. */
interface InicioFeito {
  reserva?: { ledger: BudgetLedger; taskId: string };
  worktree?: { projectPath: string; path: string };
  sessao?: { session: Session; task: Task };
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
  /** Teto de saída por sessão (item 2.5). */
  readonly #tetoDeSaida = new TetoDeSaida();
  /**
   * Reservas de concorrência: sessão → agente, entre o instante em que
   * `#reserveSlot` aceitou a vaga e o instante em que a run de verdade nasce
   * em `#runs` (ou a tentativa desiste antes disso).
   *
   * Existe para fechar a janela TOCTOU entre `#assertConcurrency` e
   * `#runs.set(...)`: como o registro de verdade só acontece dentro de
   * `#launch`, depois de vários `await` (worktree, baseline, possível gate de
   * aprovação, e só então `adapter.start()`), um fan-out de tarefas para o
   * mesmo agente furava o teto de verdade — todas liam o mesmo `#runs` vazio
   * antes de qualquer uma escrever nele. Contando esta reserva junto de
   * `#runs` em `#assertConcurrency`, a checagem-e-reserva vira uma única
   * operação síncrona, sem brecha para outra tentativa entrar no meio.
   */
  readonly #reserved = new Map<string, { agentId: string; projectId: string | null }>();
  /** Sessões cujo `seq` já foi reconciliado com o banco nesta instância. */
  readonly #seeded = new Set<string>();
  /** Modelo declarado por sessão, para precificar os eventos que não o repetem. */
  readonly #models = new Map<string, string>();
  /**
   * Raízes que já emitiram `budget.warning` nesta passagem pelos 80%.
   *
   * Detecção de BORDA (false→true), não de nível: sem isto, todo evento de
   * custo depois de cruzar o limiar reemitiria o aviso — uma sessão comum
   * cobra dezenas de vezes por turno. Limpa em `raiseLimits()` (o teto mudou,
   * então a próxima passagem pelos 80% é nova) e no fim do fluxo raiz.
   */
  readonly #warned = new Set<string>();

  /**
   * Desfecho da run que parou por estouro de orçamento, por task, guardado
   * até a aprovação: se o turno já tinha concluído, aprovar finaliza a tarefa
   * com ele (validação, `completed`) em vez de relançar o agente.
   */
  readonly #desfechoRetido = new Map<string, { outcome: RunOutcome; elapsedSeconds: number }>();

  /**
   * Pumps em andamento. Cada um escreve no banco até drenar, então o
   * desligamento precisa esperá-los antes de `store.close()`.
   */
  readonly #pumps = new Set<Promise<void>>();

  /**
   * Pedidos de parada (cancel/interrupt/pause) anotados ANTES de mexer no
   * processo, fechamentos em andamento (validação/revisão/backoff) e o pump
   * de cada sessão — ver `session-lifecycle.ts`.
   */
  readonly #ciclo = new CicloDeVida();

  /**
   * Teto da espera do gate pré-execução por uma decisão humana.
   *
   * Precisa ser MENOR que o timeout que o agente dá ao hook: quando o hook
   * estoura, o agente roda a ferramenta (medido com o `claude` real). Antes a
   * premissa era "60s é o padrão do Claude", mas o Hub instalava o hook com
   * 10 s — o humano tinha 10 s, não 60, e a ação rodava sem aprovação. A
   * ordem entre os três relógios (daemon < teto HTTP do hook < timeout do
   * hook) está em `pretool-gate.ts`.
   *
   * Público e mutável de propósito: é o único jeito de um teste exercitar o
   * caminho de timeout sem esperar um minuto. Ainda não é campo de config
   * porque não existe caso de uso real para afrouxá-lo — quem precisa de mais
   * tempo precisa, na verdade, de um modo de supervisão diferente.
   */
  gateWaitMs = ESPERA_DO_GATE_MS;

  readonly #projects: ProjectRegistry;

  constructor(
    private readonly config: HubConfig,
    private readonly store: UnitOfWork,
    private readonly registry: AgentRegistry,
    private readonly bus: InMemoryEventBus,
    private readonly worktrees: WorktreeManager,
  ) {
    this.#seq = new SequenceCounter();
    this.#projects = new ProjectRegistry(store);
  }

  // ---------------------------------------------------------------- projetos
  //
  // O CRUD mora em `ProjectRegistry` (`project-registry.ts`) — os métodos
  // abaixo são delegações finas, preservando a API pública que
  // `server.ts`/CLI/MCP já chamam sobre `SessionManager`.

  registerProject(dir: string, name?: string): Project {
    return this.#projects.register(dir, name);
  }

  listProjects(): Project[] {
    return this.#projects.list();
  }

  /** Projeto por id, ou erro PROJECT_NOT_FOUND. */
  getProject(projectId: string): Project {
    return this.#projects.get(projectId);
  }

  /** Marca/desmarca o projeto como confiável — ver `ProjectRegistry.setTrusted`. */
  setProjectTrusted(projectId: string, trusted: boolean): Project {
    return this.#projects.setTrusted(projectId, trusted);
  }

  /**
   * Memória e instruções do projeto para o agente desta sessão.
   *
   * Resolvido aqui, no daemon, e não na interface: assim vale igual para a
   * sessão que você abre no painel, para a que a CLI abre, e para a que um
   * agente delega a outro. O agente que recebeu a tarefa delegada é justamente
   * quem mais precisa das regras da casa — e é quem uma configuração guardada
   * no navegador nunca alcançaria.
   */
  #contextoDoProjeto(session: Session): ContextoDoProjeto {
    const project = this.store.projects.get(session.projectId);
    if (!project) return {};
    // Repositório só se confiável (e não suspenso); o do usuário (Hub) sempre.
    return contextForAgent(effectiveProjectContext(this.store, project).ctx, session.agentId);
  }

  /**
   * Ambiente que o projeto define para o agente desta sessão.
   *
   * É o caminho que torna "modelo local" real: apontar `OPENAI_BASE_URL` para
   * um Ollama local vale igual para sessão do painel, da CLI e de delegação.
   * O filtro por lista de permissão acontece na leitura da configuração.
   */
  #envDoProjeto(session: Session): Record<string, string> {
    const project = this.store.projects.get(session.projectId);
    if (!project) return {};
    return envForAgent(effectiveProjectContext(this.store, project).ctx, session.agentId);
  }

  /**
   * Recusa operar sobre sessão que já terminou.
   *
   * O invariante estava escrito à mão em `send` e `handoff`, e esquecido em
   * `pause`, `cancel` e `delegate`. Nomeá-lo em um lugar só é o que impede a
   * próxima rota de esquecer de novo.
   */
  #exigirNaoTerminal(session: Session, acao: string): void {
    if (isTerminalSessionState(session.state)) {
      throw new HubError(
        'ILLEGAL_STATE',
        `A sessão ${session.id} já terminou (${session.state}); não é possível ${acao}. ` +
          'Abra uma sessão nova ou delegue a partir de outra que ainda esteja viva.',
        { sessionId: session.id, state: session.state, acao },
      );
    }
  }

  /** Contexto que o usuário configurou pelo Hub — ver `ProjectRegistry.getContext`. */
  getProjectContext(projectId: string): ProjectContext {
    return this.#projects.getContext(projectId);
  }

  /** Estado do `config.yaml` do repositório — ver `ProjectRegistry.repoStatus`. */
  getProjectRepoStatus(projectId: string): RepoConfigStatus {
    return this.#projects.repoStatus(projectId);
  }

  /** Grava o contexto do usuário no banco do Hub (fora do repositório). */
  setProjectContext(projectId: string, ctx: ProjectContext): ProjectContext {
    return this.#projects.setContext(projectId, ctx);
  }

  listProjectFolders(projectId: string): ProjectFolder[] {
    return this.#projects.listFolders(projectId);
  }

  addProjectFolder(projectId: string, dir: string, label?: string): ProjectFolder {
    return this.#projects.addFolder(projectId, dir, label);
  }

  removeProjectFolder(projectId: string, folderId: string): void {
    this.#projects.removeFolder(projectId, folderId);
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

    // Delegar a partir de sessão morta criava um filho órfão: ele nasce, gasta
    // orçamento do fluxo e responde a um pai que não está mais ouvindo. Ninguém
    // recolhe o resultado, e o custo aparece num fluxo que o usuário já
    // considerava fechado.
    if (parent) this.#exigirNaoTerminal(parent, 'delegar a partir dela');

    // Política do PROJETO (global com os ajustes dele, só apertando): antes
    // `fallback`, `maxDepth`, `defaultBudget` e concorrência vinham da global
    // e os overrides declarados no `.agents-hub/config.yaml` eram ignorados.
    const politicaDoProjeto = this.#projectPolicy(project.id);
    const agentId = this.registry.resolveTarget(brief.agent, politicaDoProjeto.fallback);
    const manifest = this.registry.get(agentId).manifest;
    const sessionId = newId('ses');

    // Checagem-e-reserva como UMA operação síncrona (sem `await` entre elas):
    // é o que fecha a janela TOCTOU entre "ainda cabe" e "já registrei". A
    // reserva já conta para a concorrência a partir de agora — mesmo a run de
    // verdade só nascer bem mais adiante, depois de worktree, baseline e
    // possível portão de aprovação — e por isso todo caminho de saída que não
    // chegar a `#launch` (negado, retido para aprovação, ou erro no meio do
    // caminho) precisa liberá-la explicitamente. O `finally` abaixo garante
    // isso sem precisar espalhar a liberação por cada `return`/`throw`.
    this.#reserveSlot(sessionId, agentId, project.id);

    // O que já foi feito e precisa ser desfeito se algo lançar no meio do
    // caminho (agente não instalado, gate do Codex recusado, projeto não-git,
    // spawn que falhou): sem isto ficavam sessão `running` sem processo, task
    // `working`, worktree no disco e — em delegação — a fatia do orçamento
    // reservada para sempre, e a próxima delegação legítima dava
    // BUDGET_EXCEEDED.
    const feito: InicioFeito = {};

    try {
      // --- grafo: profundidade e ciclo (ADR 03) -----------------------------
      const graph = parent
        ? checkDelegation({
            parentPath: parent.path,
            parentDepth: parent.depth,
            maxDepth: politicaDoProjeto.maxDepth,
            target: { agentId, objective: brief.objective },
          })
        : { depth: 0, path: [pathKey(agentId, brief.objective)], key: '' };

      // --- modo: nunca escala em relação ao pai -----------------------------
      const parentMode: SessionMode = parent?.mode ?? manifest.defaults.supervision;
      const mode = inheritMode(parentMode, brief.supervision);

      const rootId = parent ? parent.rootId : sessionId;

    // --- orçamento ----------------------------------------------------------
    // Na raiz, o budget do Brief DEFINE o teto do fluxo inteiro.
    // Num filho, ele RESERVA uma fatia do que a raiz ainda tem.
    const taskId = newId('tsk');
    const ledger = parent
      ? this.#ledger(rootId)
      : this.#ledger(rootId, {
          usd: brief.budget.usd ?? politicaDoProjeto.defaultBudget.usd,
          tokens: brief.budget.tokens ?? politicaDoProjeto.defaultBudget.tokens,
          seconds: brief.budget.seconds ?? politicaDoProjeto.defaultBudget.seconds,
        });

    if (parent) {
      ledger.reserve(taskId, {
        usd: brief.budget.usd ?? undefined,
        tokens: brief.budget.tokens ?? undefined,
        seconds: brief.budget.seconds ?? undefined,
      });
      feito.reserva = { ledger, taskId };
    }
    this.#persistLedger(ledger);

    // --- isolamento ---------------------------------------------------------
    const isolation: IsolationMode = brief.isolation ?? manifest.defaults.isolation;
    const bases = await resolverBases(this.store, project, isolation, input.baseSessionIds ?? []);
    const worktree = await this.worktrees.create({
      projectPath: project.path,
      projectName: project.name,
      sessionId,
      isolation,
      ...(bases.refs[0] !== undefined ? { baseRef: bases.refs[0] } : {}),
    });
    if (worktree.isolated) feito.worktree = { projectPath: project.path, path: worktree.path };
    if (worktree.isolated && bases.refs.length > 1) {
      try {
        await juntarBranches(worktree.path, bases.refs.slice(1));
      } catch (err) {
        await this.worktrees
          .release({ projectPath: project.path, worktreePath: worktree.path, force: true })
          .catch(() => undefined);
        throw new HubError(
          'ILLEGAL_STATE',
          `Não foi possível juntar o trabalho das sessões anteriores: ${(err as Error).message}`,
          { baseSessionIds: input.baseSessionIds },
        );
      }
    }

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
      // Preenchido em `#launch`, assim que o adapter devolver o handle real.
      pid: null,
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
    feito.sessao = { session, task };
    this.bus.registerSession(sessionId, rootId);

    this.#avisarConfigDoProjetoQuebrada(session, taskId, project);
    this.#avisarDependenciasNaoLigadas(session, taskId, worktree.dependencyWarnings);
    for (const aviso of bases.avisos) this.#avisar(session, taskId, aviso);
    if (bases.refs.length > 0 && worktree.isolated) {
      this.#avisar(
        session,
        taskId,
        `worktree criado a partir do trabalho de ${bases.refs.join(' + ')}`,
        'info',
      );
    }
    // `--mode autonomous` pedido numa raiz cujo manifesto é `semi` vira `semi`
    // (o modo nunca passa do padrão do agente). Reduzir é o lado seguro, mas
    // em silêncio o usuário achava que o agente rodaria sem pausas.
    if (brief.supervision !== undefined && mode !== brief.supervision) {
      this.#avisar(
        session,
        taskId,
        `modo "${brief.supervision}" pedido, mas a sessão roda em "${mode}" — ` +
          (parent
            ? `o filho nunca tem mais autonomia que o pai (${parent.mode})`
            : `o padrão do agente ${agentId} é "${manifest.defaults.supervision}" e o modo nunca passa dele`),
      );
    }

    // Fotografa o que já estava pendente ANTES de o agente começar.
    //
    // Sem isto, `isolation: none` credita ao agente tudo que estivesse sujo na
    // árvore. Foi medido numa sessão real em somente-leitura: o Hub anunciou
    // "2 arquivo(s), +510 −0" para um agente que não tocou em nada.
    await saveBaseline(
      this.config.artifactRoot,
      sessionId,
      await captureBaseline(session.workdir),
    );

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

      await this.#launch(session, task, renderBriefAsPrompt(brief, this.#contextoDoProjeto(session)), null);

      return { session, task, budget: ledger.snapshot() };
    } catch (err) {
      await this.#desfazerInicio(err, feito);
      throw err;
    } finally {
      // Se `#launch` chegou a rodar, a run real já está em `#runs` — liberar a
      // reserva aqui não abre brecha nenhuma porque não existe `await` entre o
      // `#runs.set(...)` (dentro de `#launch`) e o retorno desta função: nada
      // mais roda no meio para explorar a janela. Nos caminhos que saíram sem
      // chegar a `#launch` (negado, retido para aprovação, erro no meio),
      // libera uma reserva que nunca virou run — sem isto o teto ficaria
      // preso para sempre por uma vaga órfã.
      this.#releaseSlot(sessionId);
    }
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
  async reconcileOnStartup(): Promise<{ revividas: number; encerradas: number }> {
    const pendentes = new Set(
      this.store.approvals.listPending().map((a) => a.sessionId),
    );

    let encerradas = 0;
    let revividas = 0;

    // Passada complementar: fecha tasks não-terminais cuja sessão dona JÁ é
    // terminal. Cobre o que pode ter vazado historicamente por escritas
    // relacionadas fora de transação (ex.: `#fallback` criando a sessão
    // substituta e reatribuindo a task em dois passos separados) — o laço
    // principal abaixo só revisita sessões `running`/`waiting_approval`, então
    // uma task presa apontando para uma sessão já terminal nunca seria
    // revisitada sem isto.
    const estadoPorSessao = new Map(this.store.sessions.list().map((s) => [s.id, s.state]));
    for (const task of this.store.tasks.list()) {
      if (isTerminalTaskState(task.state)) continue;
      const estado = estadoPorSessao.get(task.sessionId);
      if (estado && isTerminalSessionState(estado)) {
        this.store.tasks.update(task.id, { state: 'failed' });
      }
    }

    for (const sessao of this.store.sessions.list()) {
      if (sessao.state !== 'running' && sessao.state !== 'waiting_approval') continue;

      if (sessao.state === 'waiting_approval' && pendentes.has(sessao.id)) {
        revividas += 1;
        continue;
      }

      // Best-effort: o registro no banco já vai virar `killed` de qualquer
      // jeito. Se sobrar um processo de verdade rodando por trás dele (o
      // daemon anterior morreu sem chance de matar a árvore), esta é a única
      // oportunidade de limpar antes de o worktree ser recolhido com ele
      // ainda escrevendo nele. `#matarOrfao` é best-effort e assíncrono, por
      // isso fica FORA da transação abaixo — só a atualização de estado da
      // sessão e o fechamento das tasks precisam ser atômicos entre si.
      if (sessao.pid !== null) {
        await this.#matarOrfao(sessao);
      }

      // Sessão e tasks são escritas relacionadas: se o daemon cair de novo
      // NO MEIO desta própria rotina de recuperação (ex.: dois crashes
      // seguidos), sem a transação a sessão ficaria `killed` mas as tasks
      // continuariam não-terminais — e como o laço externo só revisita
      // sessões `running`/`waiting_approval`, elas nunca seriam revisitadas.
      //
      // O evento `session.ended` e o fechamento da tentativa entram na MESMA
      // transação: antes a sessão virava `killed` sem nenhum evento (a
      // timeline acabava no meio, sem explicação, e quem escutava não sabia
      // de nada) e a tentativa ficava com `endedAt: null` para sempre
      // (vistoria 2026-09-25, item 2.8).
      const motivo = 'o daemon reiniciou e a execução desta sessão não sobreviveu';
      this.store.transaction(() => {
        this.store.sessions.update(sessao.id, {
          state: 'killed',
          endedAt: sessao.endedAt ?? nowIso(),
          pid: null,
        });

        // A task fica em `failed` para o pipeline não achar que ainda há trabalho.
        let taskId: string | null = null;
        for (const task of this.store.tasks.list({ sessionId: sessao.id })) {
          if (!isTerminalTaskState(task.state)) {
            taskId = task.id;
            const ultima = task.attempts[task.attempts.length - 1];
            this.store.tasks.update(task.id, {
              state: 'failed',
              ...(ultima && ultima.endedAt === null
                ? { attempts: closeLastAttempt(task.attempts, 'transient', motivo) }
                : {}),
            });
          }
        }

        this.#emit({
          sessionId: sessao.id,
          taskId,
          agentId: sessao.agentId,
          type: 'session.ended',
          payload: { state: 'killed', reason: motivo, reconciled: true },
        });
      });

      encerradas += 1;
    }

    return { revividas, encerradas };
  }

  /**
   * Mata o processo órfão de uma sessão morta cujo daemon anterior nunca
   * teve chance de limpar — best-effort, sempre engolindo erro.
   *
   * A parte que não é opcional: um PID é um número que o SO recicla. Um
   * daemon reiniciado dias depois do crash pode achar no banco o PID de uma
   * sessão de agente que já morreu há muito, e esse número já foi dado de
   * novo para QUALQUER outro processo do usuário. Matar sem checar seria
   * capaz de derrubar algo que não tem nada a ver com o Hub. Por isso
   * `tasklist /FI "PID eq <pid>"` confirma o nome do binário antes de mandar
   * `taskkill` — só mata quando o processo vivo naquele PID ainda parece ser
   * o esperado.
   */
  async #matarOrfao(sessao: Session): Promise<void> {
    const pid = sessao.pid;
    if (pid === null) return;

    try {
      const imagem = await imagemDoProcesso(pid);
      if (imagem === null) return; // já não existe — o caso comum e esperado

      const bin = this.registry.has(sessao.agentId)
        ? this.registry.get(sessao.agentId).manifest.bin
        : null;

      // Shim npm desembrulhado (ver `resolverShimNpm`): o PID guardado é do
      // `node.exe`/`.exe` real que o adapter spawnou, não de um `cmd.exe`.
      const resolvido = bin === null ? null : await resolveBin(bin).catch(() => null);
      if (bin === null || !imagemPareceEsperada(imagem, bin, resolvido?.file)) {
        // Ou o agente nem está mais registrado (não dá para saber o que
        // esperar), ou o PID já foi reciclado para outro binário. Nos dois
        // casos, não mexer é mais seguro do que adivinhar.
        return;
      }

      // A checagem de nome de imagem sozinha não fecha o caso do PID
      // reciclado: se o SO reaproveitar o PID órfão para outro processo com o
      // MESMO nome de binário (outro `node.exe`/shim `.cmd` do usuário, por
      // exemplo — `imagemPareceEsperada` inclusive aceita `cmd`/`sh`/`bash`
      // como wrapper plausível para QUALQUER `bin` alvo), a checagem de nome
      // passa e mataríamos um processo alheio. Um processo reciclado nasce
      // DEPOIS do daemon anterior morrer — ou seja, depois do último registro
      // conhecido desta sessão no banco. Se o horário de criação do processo
      // vivo for mais novo que isso, não é o órfão de verdade: é o SO tendo
      // devolvido o número pra outro programa. Só no Windows por enquanto
      // (mesma limitação de `imagemDoProcesso`: POSIX segue sem cobertura de
      // kill nesta reconciliação).
      if (process.platform === 'win32') {
        const inicioProcesso = await horarioDeCriacaoDoProcesso(pid);
        if (pidPareceReciclado(inicioProcesso, sessao.updatedAt)) {
          console.error(
            `reconciliação: pid ${pid} (${imagem}) da sessão ${sessao.id} nasceu em ` +
              `${inicioProcesso?.toISOString()}, depois do último registro da sessão ` +
              `(${sessao.updatedAt}) — provável PID reciclado, kill abortado`,
          );
          return;
        }
      }

      // Chegamos até aqui só porque `imagemDoProcesso` confirmou que o PID
      // está vivo e bate com o binário esperado, e (no Windows) o processo não
      // nasceu depois do último registro da sessão — ou seja, é um órfão de
      // verdade sobrevivendo a um crash, não o caminho comum de "já tinha
      // morrido sozinho". Vale o log.
      await killProcessTree(pid, () => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // já não existia mais entre o `tasklist` e agora — corrida rara,
          // sem problema.
        }
      });
      console.error(
        `reconciliação: processo órfão (pid ${pid}, ${imagem}) da sessão ${sessao.id} (${sessao.agentId}) encerrado`,
      );
    } catch {
      // "processo não existe" é o caminho esperado na imensa maioria das
      // vezes — a sessão terminou limpo antes do crash do daemon, e o
      // registro só não tinha sido atualizado ainda.
    }
  }

  /**
   * Decide uma chamada de ferramenta ANTES de ela executar (gate pré-execução).
   *
   * É a única prevenção real que o Hub consegue sem sandbox de sistema: o
   * agente pergunta, nós respondemos, e a ferramenta só roda se deixarmos.
   * A vigilância reativa continua existindo para os agentes que não têm hook.
   */
  /**
   * Portão PRÉ-execução: o agente pergunta antes de agir, e o Hub responde.
   *
   * Quando a decisão é `approve`, a resposta depende de um humano — e é aqui
   * que estava o buraco: o gate emitia um evento `approval.requested` e
   * NÃO chamava `#requestApproval`. A timeline mostrava "aprovação solicitada",
   * mas nenhuma linha entrava na tabela, nada aparecia em `GET /approvals`,
   * `hub approve` não tinha id para receber e a sessão não ia para
   * `waiting_approval`. A decisão ficava inteiramente com o `escalate` dentro
   * do agente — que, num `-p` headless, é onde não existe humano para
   * responder. O nível de controle que a documentação chama de "o mais forte"
   * era o único sem como ser respondido.
   *
   * Agora a aprovação é real e a chamada BLOQUEIA esperando por ela. Bloquear é
   * a única forma de um portão pré-execução valer alguma coisa: devolver
   * "escalate" e seguir deixaria a ferramenta rodar antes da decisão.
   *
   * Como o hook do agente tem timeout próprio, a espera é limitada, e o que
   * acontece quando ela estoura é **negar** — não permitir. Um portão de
   * segurança que falha aberto no silêncio não é portão. A negação por tempo
   * diz ao agente que foi falta de resposta, não proibição, para ele não
   * concluir que a ação é impossível e tentar contorná-la.
   */
  async gateToolCall(input: {
    sessionId?: string | undefined;
    nativeSessionId?: string | undefined;
    cwd?: string | undefined;
    toolName: string;
    toolInput?: Record<string, unknown> | undefined;
  }): Promise<{
    decision: Decision;
    risk: RiskLevel;
    reason: string;
    session: Session | null;
    approvalId?: string;
    explanation?: string;
  }> {
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
      const v = engine.decide(action, {
        workdir: session.workdir,
        mode: session.mode,
        agentDirs: this.#agentDirs(session),
      });
      return { decision: v.decision, risk: v.risk, reason: v.reason };
    });

    const combinado = combineVerdicts(vereditos);

    // Proibido pela política: não há o que perguntar a ninguém. Registrar na
    // timeline é o que torna a decisão auditável depois.
    if (combinado.decision === 'deny') {
      this.#emit({
        sessionId: session.id,
        taskId: null,
        agentId: session.agentId,
        type: 'log',
        payload: {
          level: 'warn',
          gate: 'pre-execution',
          tool: input.toolName,
          risk: combinado.risk,
          text: `portão pré-execução negou ${input.toolName}: ${combinado.reason}`,
        },
      });
      return { ...combinado, session };
    }

    if (combinado.decision === 'allow') return { ...combinado, session };

    // Sessão já encerrada (processo órfão com o id antigo no ambiente, por
    // exemplo): abrir aprovação nela a jogaria de volta para
    // `waiting_approval`, ressuscitando no painel algo que acabou. Não há a
    // quem perguntar — nega, dizendo por quê.
    if (isTerminalSessionState(session.state)) {
      return {
        ...combinado,
        decision: 'deny',
        session,
        explanation:
          `Agents-Hub classificou esta ação como "${combinado.risk}": ${combinado.reason}. ` +
          `Ela precisa de aprovação humana, mas a sessão ${session.id} já terminou ` +
          `(${session.state}) e não há aprovação a pedir. Não tente contornar — explique ao ` +
          `usuário o que você precisava fazer.`,
      };
    }

    // `approve` = precisa de gente. A partir daqui a chamada do hook fica
    // parada, o que é exatamente o ponto: a ferramenta não roda enquanto a
    // decisão não sai.
    const task = this.#latestTaskOrNull(session.id);
    const approval = this.#requestApproval({
      session,
      taskId: task?.id ?? null,
      risk: combinado.risk,
      action: `${input.toolName}: ${resumoDaChamada(input.toolName, input.toolInput ?? {})}`,
      detail: {
        kind: 'tool-call',
        tool: input.toolName,
        toolInput: input.toolInput ?? {},
        reason: combinado.reason,
      },
    });

    const desfecho = await this.#aguardarDecisao(approval.id, this.gateWaitMs);

    if (desfecho === 'approved') {
      return {
        ...combinado,
        decision: 'allow',
        session,
        approvalId: approval.id,
        explanation: `Liberado por decisão humana no Agents-Hub (${approval.id}).`,
      };
    }

    const porTempo = desfecho === 'timeout';
    return {
      ...combinado,
      decision: 'deny',
      session,
      approvalId: approval.id,
      explanation: porTempo
        ? `Agents-Hub classificou esta ação como "${combinado.risk}": ${combinado.reason}. ` +
          `Ela precisava de aprovação humana e ninguém respondeu em ` +
          `${Math.round(this.gateWaitMs / 1000)}s, então foi negada por falta de resposta — ` +
          `não por proibição. Siga com o resto da tarefa e diga ao usuário que esta ação ` +
          `ficou pendente (aprovação ${approval.id}).`
        : `Agents-Hub classificou esta ação como "${combinado.risk}": ${combinado.reason}. ` +
          `Um humano negou explicitamente. Não tente contornar — explique ao usuário o que ` +
          `você precisava fazer e por quê.`,
    };
  }

  /**
   * Espera a decisão humana sobre uma aprovação, com teto.
   *
   * Poll em vez de evento porque a resolução pode vir de qualquer processo — a
   * CLI, o painel, o MCP —, e todos escrevem no mesmo banco. Um emissor em
   * memória só enxergaria quem resolvesse dentro deste processo.
   */
  async #aguardarDecisao(
    approvalId: string,
    tetoMs: number,
  ): Promise<'approved' | 'denied' | 'timeout'> {
    const limite = Date.now() + tetoMs;

    while (Date.now() < limite) {
      const atual = this.store.approvals.get(approvalId);
      if (atual && atual.state !== 'pending') {
        return atual.state === 'approved' ? 'approved' : 'denied';
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Deixar a aprovação pendente para sempre travaria a sessão em
    // `waiting_approval` enquanto o agente já teria seguido em frente. Fechar
    // aqui mantém banco e realidade de acordo.
    const ainda = this.store.approvals.get(approvalId);
    if (ainda && ainda.state === 'pending') {
      await this.resolveApproval(approvalId, 'denied', 'tempo esgotado').catch(() => undefined);
    }
    return 'timeout';
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

      // Só sessão VIVA que o Hub spawnou. O diretório é a pista mais fraca:
      // casar com sessão encerrada, ou com a raiz adotada de um agente externo
      // (que roda no diretório do projeto e fica `running` enquanto o MCP
      // viver), aplicava a política do Hub ao Claude que você abriu na mão
      // naquele projeto — com aprovações que ninguém ia ver.
      const viva = candidatas
        .filter(
          (s) =>
            path.resolve(s.workdir) === alvo &&
            (s.state === 'running' || s.state === 'waiting_approval') &&
            !sessaoAdotada(s),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (viva) return viva;
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
      throw new HubError('APPROVAL_NOT_FOUND', `Aprovação ${id} não encontrada`, { id });
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

    // Aprovação do gate pré-execução decide UMA chamada de ferramenta, não a
    // sessão. Antes caía nos ramos genéricos: negar (inclusive por tempo
    // esgotado) cancelava a sessão inteira, e aprovar chamava `send` numa run
    // one-shot viva — que lança ILLEGAL_STATE, então `hub approve` respondia
    // erro depois de já ter liberado a ferramenta.
    if (approval.detail['kind'] === 'tool-call') {
      await this.#resolverChamadaDoGate(approval, decision, by);
      return resolved;
    }

    const retido = approval.taskId ? this.#desfechoRetido.get(approval.taskId) : undefined;
    if (approval.taskId) this.#desfechoRetido.delete(approval.taskId);

    if (decision === 'denied') {
      if (approval.taskId) this.store.tasks.update(approval.taskId, { state: 'rejected' });
      await this.cancel(session.id, `negado por ${by}: ${approval.action}`);
      return resolved;
    }

    const isDelegation = approval.detail['kind'] === 'delegation';
    const task = approval.taskId ? this.store.tasks.get(approval.taskId) : null;

    // A sessão pode ter morrido enquanto a aprovação esperava — timeout do
    // daemon, cancelamento do pai, `hub stop`, reconciliação. A checagem
    // precisa vir ANTES de qualquer escrita ou `#launch`: a versão anterior
    // escrevia `state: 'running'` incondicionalmente e só DEPOIS relia a
    // sessão para checar terminalidade — o que sempre lia de volta o próprio
    // "running" que acabara de escrever, e a checagem nunca disparava de
    // verdade. Aprovar uma sessão morta ressuscitava um processo de agente
    // novo para algo que o resto do sistema já tratava como encerrado.
    const viva = this.store.sessions.get(session.id);
    if (!viva || isTerminalSessionState(viva.state)) {
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

      // Teto mudou: a próxima vez que a pressão cruzar 80% é uma passagem
      // nova, não a mesma que acabou de ser resolvida.
      this.#warned.delete(session.rootId);

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

      // O turno já tinha CONCLUÍDO quando o teto estourou: não há de onde
      // "continuar". Relançar aqui era um turno extra que ninguém pediu (e
      // que estourava de novo). A tarefa só passa pelo que faltava — portão
      // de validação e conclusão —; um próximo turno, só se o usuário mandar.
      if (approval.detail['turnCompleted'] === true && task) {
        this.store.transaction(() => {
          this.store.tasks.update(task.id, { state: 'working' });
          this.store.sessions.update(session.id, { state: 'running' });
        });
        // Run ainda drenando: o próprio pump fecha a tarefa ao ver o fim do
        // processo (já com o desfecho corrigido para sucesso).
        if (this.#runs.has(session.id)) return resolved;

        const desfecho = retido ?? {
          outcome: {
            exitCode: 0,
            signal: null,
            reason: 'exit' as const,
            error: null,
            nativeSessionId: viva.nativeSessionId,
            tail: '',
          },
          elapsedSeconds: 0,
        };
        const atual = this.store.sessions.get(session.id) ?? viva;
        await this.#settle(atual, this.store.tasks.get(task.id) ?? task, desfecho.outcome, desfecho.elapsedSeconds);
        return resolved;
      }
    }

    if (isDelegation && task) {
      // A sessão nem chegou a subir: agora sobe.
      this.store.tasks.update(task.id, { state: 'working' });
      await this.#launch(session, task, renderBriefAsPrompt(task.brief, this.#contextoDoProjeto(session)), null);
      return resolved;
    }

    // Vigilância: a run foi morta ao pausar, então continuamos por uma mensagem
    // nova, dizendo ao agente o que exatamente foi liberado. A terminalidade
    // já foi checada acima, antes desta escrita — não depois dela.
    if (task) this.store.tasks.update(task.id, { state: 'working' });
    this.store.sessions.update(session.id, { state: 'running' });

    await this.send(
      session.id,
      `A ação "${approval.action}" foi aprovada por ${by}. Continue de onde parou.`,
    );
    return resolved;
  }

  /**
   * Fecha uma aprovação do gate sem tocar no destino da sessão.
   *
   * O agente está parado no hook esperando esta resposta; quem entrega o
   * desfecho a ele é o próprio `gateToolCall` (`allow`, ou `deny` com o motivo
   * real). Aqui só se devolve a sessão ao estado em que estava antes da
   * pergunta — `running`, task `working` — quando não sobrou outra pendência.
   *
   * O caso raro é a run ter morrido durante a espera (crash, reinício do
   * daemon): aí não há hook para ler a resposta, e a sessão ficaria `running`
   * sem processo. Relançar com uma mensagem que diz o desfecho é a mesma
   * saída que a vigilância usa. Falhar nesse relançamento não desfaz a
   * decisão — vira aviso na timeline, não erro para quem aprovou.
   */
  async #resolverChamadaDoGate(
    approval: Approval,
    decision: 'approved' | 'denied',
    by: string,
  ): Promise<void> {
    const sessao = this.store.sessions.get(approval.sessionId);
    if (!sessao || isTerminalSessionState(sessao.state)) return;

    const outrasPendentes =
      this.store.approvals.listPending({ sessionId: sessao.id }).length > 0;
    if (outrasPendentes) return;

    this.store.transaction(() => {
      if (sessao.state === 'waiting_approval') {
        this.store.sessions.update(sessao.id, { state: 'running' });
      }
      const task = approval.taskId ? this.store.tasks.get(approval.taskId) : null;
      if (task && task.state === 'input_required') {
        this.store.tasks.update(task.id, { state: 'working' });
      }
    });

    // Run viva = agente bloqueado no hook, que vai receber a resposta. Sessão
    // adotada não tem run do Hub: o agente externo é quem está no hook.
    if (this.#runs.has(sessao.id) || sessaoAdotada(sessao)) return;

    const texto =
      decision === 'approved'
        ? `A ação "${approval.action}" foi aprovada por ${by}, mas o turno anterior terminou ` +
          `antes de receber a resposta. Se ela ainda for necessária, refaça-a e continue de onde parou.`
        : `A ação "${approval.action}" foi negada (${by}). Não tente contorná-la: siga com o resto ` +
          `da tarefa e diga ao usuário que esta ação ficou pendente.`;
    try {
      await this.send(sessao.id, texto);
    } catch (err) {
      this.#emit({
        sessionId: sessao.id,
        taskId: approval.taskId,
        agentId: sessao.agentId,
        type: 'log',
        payload: {
          level: 'warn',
          text: `decisão registrada, mas a sessão não pôde ser retomada: ${(err as Error).message}`,
        },
      });
    }
  }

  /**
   * Recusa relançar o agente por cima de uma decisão humana pendente.
   *
   * `send` e `handoff` numa sessão `waiting_approval` subiam um processo novo
   * com a aprovação ainda aberta: sessão viva, task esperando humano e
   * pendência aberta ao mesmo tempo — e a parada de orçamento ou de
   * vigilância contornada por uma mensagem.
   */
  #exigirSemAprovacaoPendente(session: Session, acao: string): void {
    if (session.state !== 'waiting_approval') return;
    const pendentes = this.store.approvals.listPending({ sessionId: session.id });
    const ids = pendentes.map((a) => a.id);
    throw new HubError(
      'ILLEGAL_STATE',
      `A sessão ${session.id} está aguardando aprovação` +
        (ids.length > 0 ? ` (${ids.join(', ')})` : '') +
        `; não é possível ${acao}. Resolva a aprovação primeiro com hub approve/deny.`,
      { sessionId: session.id, state: session.state, approvalIds: ids, acao },
    );
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
    this.#exigirSemAprovacaoPendente(session, 'enviar mensagem');
    const adapter = this.registry.get(session.agentId);
    const live = this.#runs.get(sessionId);

    if (live && live.handle.supportsLiveSend) {
      this.#emitUserMessage(session, live.taskId, text);
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
    // e o trabalho ficaria pendurado num lugar que ninguém mais observa. A
    // recusa ensina a continuar numa sessão nova (ver session-continuation).
    if (session.state === 'killed' || session.state === 'failed' || session.state === 'completed') {
      throw recusaDeSessaoTerminada(session);
    }

    // Processo já saiu e o Hub está validando o resultado ou esperando o
    // backoff de uma nova tentativa: um turno novo agora rodaria em paralelo
    // com isso, e o desfecho da validação sobrescreveria o dele.
    if (this.#ciclo.emFechamento(sessionId)) {
      throw new HubError(
        'ILLEGAL_STATE',
        `A sessão ${sessionId} está fechando o turno anterior (validação/revisão/nova tentativa). ` +
          'Aguarde o desfecho antes de enviar.',
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
          history: this.#historicoRecente(sessionId),
          message: text,
        });

    // Antes do `#launch`: a fala do usuário precede o que o agente responde, e
    // o evento (estrutural para o painel) faz a UI reler o estado — que o
    // `#launch` troca de `paused`/`idle` para `running` sem evento próprio.
    this.#emitUserMessage(session, task.id, text);

    // Retomar depois de interrupt/pause: a task esperava a próxima instrução
    // (`input_required`) e volta a trabalhar. Se o agente não subir, a sessão
    // e a task voltam ao que eram — continuam retomáveis, nada é encerrado
    // por uma falha de spawn num turno de continuação.
    const retomando = task.state === 'input_required' && (session.state === 'idle' || session.state === 'paused');
    if (retomando) this.store.tasks.update(task.id, { state: 'working' });
    try {
      await this.#launch(session, task, prompt, canResume ? session.nativeSessionId : null, {
        continuacao: true,
      });
    } catch (err) {
      // `running` sem processo seria a sessão fantasma de novo: sem run
      // viva, o estado honesto é `idle` (retomável por outro `send`).
      this.store.sessions.update(sessionId, {
        state: session.state === 'running' ? 'idle' : session.state,
      });
      if (retomando) this.store.tasks.update(task.id, { state: 'input_required' });
      throw err;
    }
    return { mode: canResume ? 'resume' : 'replay' };
  }

  /**
   * Registra na timeline o que foi pedido. Sem isto a conversa tinha um lado
   * só: relendo o histórico, não havia como saber o que o agente respondia.
   */
  #emitUserMessage(session: Session, taskId: string | null, text: string): void {
    this.#emit({
      sessionId: session.id,
      taskId,
      agentId: session.agentId,
      type: 'user.message',
      payload: { text },
    });
  }

  /**
   * Interrompe o turno em andamento e deixa a sessão `idle`, retomável por
   * `send` (resume nativo quando o agente tem, replay quando não).
   *
   * Devolve `false` quando a sessão existe mas não tinha nada rodando — e isso
   * precisa chegar a quem pediu. A versão anterior consultava `#runs` ANTES de
   * validar a sessão e saía calada quando não achava nada, então
   * `POST /sessions/ses_naoexiste/interrupt` respondia `{ok:true}` com 200.
   * Sucesso relatado sobre coisa nenhuma, e divergente dos irmãos `cancel` e
   * `pause`, que devolviam 404 para o mesmo id.
   *
   * Só devolve depois de o pump fechar o turno: quem lê a sessão logo em
   * seguida já a vê `idle`, não `running` com processo morto.
   */
  async interrupt(sessionId: string): Promise<boolean> {
    // Validar primeiro: id desconhecido é erro do chamador, não silêncio.
    const session = this.#session(sessionId);
    this.#exigirNaoTerminal(session, 'interromper o turno');

    const live = this.#runs.get(sessionId);
    if (!live) return false;

    await this.#pararTurno(session, live, { tipo: 'interrupt', motivo: 'interrompido pelo usuário' });
    return true;
  }

  /**
   * Para o turno de uma run viva sem encerrar a sessão (interrupt/pause).
   *
   * O pedido é anotado ANTES de mexer no processo: no Windows parar o turno é
   * matar a árvore, e sem a anotação o pump leria "processo morto" como falha
   * — era assim que `hub pause` terminava em `failed`.
   */
  async #pararTurno(session: Session, live: LiveRun, pedido: PedidoDeParada): Promise<void> {
    const acao = pedido.tipo === 'pause' ? 'pausar' : 'interromper o turno';
    // Agente parado no gate ou em estouro de orçamento: parar o turno por
    // cima da pendência deixaria sessão ociosa com aprovação aberta.
    this.#exigirSemAprovacaoPendente(session, acao);

    const adapter = this.registry.get(session.agentId);
    // Sem como retomar, "interromper" seria encerrar com outro nome — e é
    // exatamente a mentira que este método existe para não contar.
    if (adapter.manifest.session.strategy === 'none') {
      throw new HubError(
        'ILLEGAL_STATE',
        `O agente "${session.agentId}" não retoma sessão (session.strategy: none): não é possível ${acao} ` +
          'sem perder o turno. Use cancel para encerrar a sessão.',
        { sessionId: session.id, agentId: session.agentId, acao },
      );
    }

    this.#ciclo.pedir(session.id, pedido);
    await adapter.interrupt(live.handle);
    await this.#ciclo.aguardarPump(session.id, ESPERA_DO_FECHAMENTO_MS);
  }

  /**
   * Cancela a sessão (e a subárvore dela).
   *
   * O pedido é anotado ANTES de matar a run, e quem fecha a sessão é um
   * caminho só (`#encerrarCancelada`): sessão `killed`, task `canceled`. Antes,
   * `cancel` gravava `killed` e o pump da mesma run, terminando logo depois,
   * via o desfecho `canceled`, passava pelo pipeline de falha e sobrescrevia
   * com `failed` — 6 de 8 vezes na medição, sempre com a task `failed`.
   *
   * Também alcança o que acontece DEPOIS de o processo sair: validação,
   * revisão e backoff de retry são abortados (o comando/revisor morre), em vez
   * de o cancelado voltar como `completed` ao fim da validação.
   */
  async cancel(sessionId: string, reason = 'cancelado pelo usuário', visited = new Set<string>()): Promise<void> {
    if (visited.has(sessionId)) return;
    visited.add(sessionId);

    const session = this.#session(sessionId);
    // Cancelar o que já acabou reescrevia o desfecho: uma sessão `completed`
    // virava `killed` na auditoria, com `{ok:true}` de resposta.
    //
    // Na recursão pela subárvore, filho já terminado é normal e não é erro —
    // por isso o `visited` guarda só a raiz da chamada do usuário.
    if (isTerminalSessionState(session.state)) {
      if (visited.size === 1) this.#exigirNaoTerminal(session, 'cancelar');
      return;
    }

    this.#ciclo.pedir(sessionId, { tipo: 'cancel', motivo: reason });
    const live = this.#runs.get(sessionId);
    if (live) await this.registry.get(session.agentId).cancel(live.handle);
    this.#ciclo.abortarFechamento(sessionId);

    // Cancelar um pai cancela a subárvore: deixar filhos órfãos rodando é como
    // agentes continuam gastando orçamento de um fluxo que você já abortou.
    // Qualquer filho não terminal — pausado e ocioso também seguram orçamento.
    for (const child of this.store.sessions.children(sessionId)) {
      if (!isTerminalSessionState(child.state)) {
        await this.cancel(child.id, `pai ${sessionId} cancelado`, visited);
      }
    }

    // O pump fecha a sessão depois de drenar os eventos da run morta. Sem run
    // (sessão ociosa, pausada, aguardando aprovação) ou com um adapter cujo
    // stream não fecha, fecha aqui — `#encerrarCancelada` é idempotente.
    await this.#ciclo.aguardarPump(sessionId, ESPERA_DO_FECHAMENTO_MS);
    await this.#encerrarCancelada(sessionId, reason);
  }

  /**
   * Pausa a sessão: para o turno em andamento (se houver) e a deixa `paused`,
   * retomável por `send`. Mesmo mecanismo de `interrupt`, outro estado final.
   */
  async pause(sessionId: string): Promise<void> {
    // Sem esta checagem, pausar uma sessão `completed` a devolvia para
    // `paused` — e uma sessão pausada aceita resume, então uma conversa
    // encerrada com sucesso voltava a rodar.
    const session = this.#session(sessionId);
    this.#exigirNaoTerminal(session, 'pausar');
    if (session.state === 'paused') return;

    // Processo já saiu e o Hub está validando/revisando o resultado: não há
    // turno para parar, e "pausar" agora seria sobrescrito pelo desfecho.
    if (this.#ciclo.emFechamento(sessionId)) {
      throw new HubError(
        'ILLEGAL_STATE',
        `A sessão ${sessionId} está fechando o turno (validação/revisão/nova tentativa); ` +
          'não é possível pausar agora. Aguarde o desfecho ou cancele.',
        { sessionId, state: session.state },
      );
    }

    const live = this.#runs.get(sessionId);
    if (live) {
      await this.#pararTurno(session, live, { tipo: 'pause', motivo: 'pausado pelo usuário' });
      return;
    }

    this.#exigirSemAprovacaoPendente(session, 'pausar');
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
    this.#exigirSemAprovacaoPendente(session, 'fazer handoff');

    // Mesma correção de `start()`/`#retry()`/`#fallback()`: checa e reserva
    // numa única operação síncrona, antes de qualquer `await` desta função.
    this.#reserveSlot(sessionId, resolvedTarget);

    // Run antiga marcada como SUBSTITUÍDA antes do cancel: o `#pump` dela
    // encerra em silêncio quando vê em `#runs` um handle diferente do seu. Antes
    // o `#runs.delete` vinha logo após o cancel, o pump antigo não achava run
    // nenhuma e seguia para `#settle` — emitindo "tarefa encerrada sem
    // sucesso" e marcando a task `failed` no meio do handoff (vistoria
    // 2026-09-25, 13-orquestracao). O marcador herda tudo do handle real
    // (protótipo), então cancel/shutdown continuam alcançando o processo
    // enquanto o novo agente não sobe.
    const live = this.#runs.get(sessionId);
    const marcador = live ? (Object.create(live.handle) as RunHandle) : null;
    if (live && marcador) this.#runs.set(sessionId, { ...live, handle: marcador });

    try {
      // Interrompe a execução atual se houver
      if (live) {
        await this.registry.get(session.agentId).cancel(live.handle);
      }

      const task = this.#latestTask(sessionId);
      const fromAgentId = session.agentId;

      // A tentativa do agente antigo fecha aqui (sem desfecho de falha: ele não
      // falhou, foi substituído) e o novo agente ganha a sua — sem isto o
      // histórico de tentativas não registrava a troca e o retry/fallback
      // posterior contava tentativas do agente errado.
      const attempts = closeLastAttempt(task.attempts, 'canceled', `handoff para ${resolvedTarget}`);
      const taskAtualizada = this.store.tasks.update(task.id, {
        attempts: [...attempts, novaTentativa(attempts.length + 1, resolvedTarget)],
        // Sessão pausada/interrompida: a task esperava instrução
        // (`input_required`); com o substituto no ar ela volta a trabalhar,
        // como no `send` — senão quem espera lia "precisa de instrução".
        ...(task.state === 'input_required' ? { state: 'working' as const } : {}),
      });

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
        history: this.#historicoRecente(sessionId),
        message: `Você está assumindo esta sessão que estava sob responsabilidade de ${fromAgentId}. Motivo da transferência: ${reason ?? 'continuidade de trabalho'}. Continue a tarefa de onde parou.`,
      });

      await this.#launch(updatedSession, taskAtualizada, prompt, null);
      return updatedSession;
    } finally {
      // Se o novo agente não chegou a subir, o marcador não pode ficar em
      // `#runs` ocupando vaga para sempre (a run antiga já foi cancelada).
      if (marcador && this.#runs.get(sessionId)?.handle === marcador) {
        this.#runs.delete(sessionId);
      }
      this.#releaseSlot(sessionId);
    }
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
      // Sessão adotada: o processo já existia fora do Hub antes da adoção, e
      // nenhum adapter foi quem o subiu — não há PID para rastrear aqui.
      pid: null,
    };

    this.store.sessions.create(session);
    this.bus.registerSession(sessionId, sessionId);

    // Mesma razão da sessão comum: a sessão adotada roda no diretório do
    // usuário, que raramente está limpo.
    //
    // Sem `await` porque a adoção é síncrona por contrato — quem adota espera a
    // sessão de volta, não um disco. O risco é o agente alterar um arquivo
    // antes da foto sair; nesse caso ele aparece como já-sujo e some do diff,
    // que erra para o lado de atribuir de menos. Atribuir de menos é o erro
    // menos danoso dos dois.
    void captureBaseline(session.workdir).then((baseline) =>
      saveBaseline(this.config.artifactRoot, sessionId, baseline),
    );

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
  async detach(sessionId: string, reason = 'agente externo desconectou'): Promise<void> {
    const session = this.#session(sessionId);
    // Desanexar é só para quem foi ADOTADO. Numa sessão comum, isto a marcava
    // `completed` sem matar o processo do agente — um "encerrar" que mente o
    // estado e deixa a run órfã. Para essas existe `cancel`.
    if (!sessaoAdotada(session)) {
      throw new HubError(
        'ILLEGAL_STATE',
        `A sessão ${sessionId} não foi adotada de um agente externo; desanexar não se aplica — use cancelar.`,
        { sessionId },
      );
    }
    // Idempotente: o MCP pode desconectar depois de a raiz já ter expirado por
    // falta de sinal de vida (ver `adopted-leases.ts`) — não há o que fechar.
    if (isTerminalSessionState(session.state)) return;
    this.#emit({
      sessionId,
      taskId: null,
      agentId: session.agentId,
      type: 'session.ended',
      payload: { reason, external: true },
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

  /**
   * Sessões por onde a task passou: a original e cada substituto de fallback
   * (a task é reatribuída à sessão nova). A atual vem por último.
   */
  sessoesDaTask(taskId: string): string[] {
    const task = this.getTask(taskId);
    const vistas = new Set<string>();
    for (const e of this.store.events.list({ taskId, limit: 5000 })) vistas.add(e.sessionId);
    vistas.delete(task.sessionId);
    // O pai registra a delegação na timeline DELE com o id da task do filho —
    // isso não faz dele uma sessão por onde a task passou.
    if (task.requesterSessionId) vistas.delete(task.requesterSessionId);
    return [...vistas, task.sessionId];
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
      // Os ÚLTIMOS 200: antes vinham os primeiros, e numa sessão longa o
      // filho recebia a exploração inicial em vez do estado atual.
      return { ref, events: this.store.events.list({ sessionId, tail: true, limit: 200 }) };
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

  /**
   * Histórico para reconstruir a conversa (replay/handoff): os ÚLTIMOS 400
   * eventos narrativos. `condensarHistorico` preserva o fim; antes a consulta
   * entregava os 400 PRIMEIROS (e gastava o limite com log/delta), então em
   * sessão longa o fim — justamente o que importa — nunca chegava.
   */
  #historicoRecente(sessionId: string): EventEnvelope[] {
    return this.store.events.list({
      sessionId,
      types: [...EVENTOS_NARRATIVOS],
      tail: true,
      limit: 400,
    });
  }

  listEvents(
    sessionId: string,
    sinceSeq?: number,
    limit?: number,
    page: { beforeSeq?: number; newest?: boolean } = {},
  ): EventEnvelope[] {
    // Página limitada em bytes (item 2.5): uma sessão com eventos gigantes
    // (inclusive os gravados antes dos tetos existirem) chegou a gerar uma
    // resposta de 125 MB.
    return limitarPagina(this.store.events.list({ sessionId, sinceSeq, limit, ...page }));
  }

  /**
   * Redefine o teto do fluxo (edição pelo operador, `PUT /budget/:rootId`).
   *
   * Só na RAIZ: o ledger é chaveado por ela, e aceitar o id de uma sub-sessão
   * criaria um ledger órfão que ninguém consulta. Campos ausentes ficam como
   * estão. O teto novo não pode ficar abaixo do que já foi gasto mais o que
   * está reservado para delegações em curso — isso não "para" o fluxo, só o
   * deixa num estado que o ledger chama de esgotado sem ninguém ter gasto
   * nada a mais; para parar existe `cancel`.
   */
  setBudgetLimits(
    rootId: string,
    limits: Partial<BudgetLimits>,
  ): { before: BudgetLimits; budget: BudgetSnapshot & { projection?: BudgetProjection } } {
    const session = this.#session(rootId);
    if (session.rootId !== session.id) {
      throw new HubError(
        'ILLEGAL_STATE',
        `A sessão ${rootId} não é raiz de fluxo; o orçamento pertence à raiz ${session.rootId}.`,
        { sessionId: rootId, rootId: session.rootId },
      );
    }

    const ledger = this.#ledger(rootId);
    const atual = ledger.snapshot();
    const alvo: BudgetLimits = { ...atual.limits };
    const abaixo: string[] = [];
    for (const campo of ['usd', 'tokens', 'seconds'] as const) {
      const novo = limits[campo];
      if (novo === undefined) continue;
      const piso = atual.consumed[campo] + atual.reserved[campo];
      if (novo < piso) abaixo.push(`${campo} (mínimo ${Number(piso.toFixed(4))})`);
      alvo[campo] = novo;
    }
    if (abaixo.length > 0) {
      throw new HubError(
        'INVALID_QUERY',
        `o teto novo fica abaixo do já gasto + reservado em: ${abaixo.join(', ')}`,
        { rootId, abaixo },
      );
    }

    ledger.setLimits(alvo);
    this.#persistLedger(ledger);
    // Teto mudou: cruzar 80% de novo é uma passagem nova.
    this.#warned.delete(rootId);

    const snapshot = ledger.snapshot();
    this.#emit({
      sessionId: rootId,
      taskId: null,
      agentId: session.agentId,
      type: 'budget.updated',
      payload: {
        text: `orçamento redefinido pelo operador: US$ ${snapshot.limits.usd.toFixed(2)}`,
        snapshot,
      },
    });
    return { before: atual.limits, budget: this.budget(rootId) };
  }

  graph(rootId: string): GraphNode[] {
    return buildGraph(this.store.sessions.graphRows(rootId));
  }

  budget(rootId: string): BudgetSnapshot & { projection?: BudgetProjection } {
    const ledger = this.#ledger(rootId);
    const snap = ledger.snapshot();

    // `consumed.seconds` só é alimentado em `ledger.settle()`, chamado DEPOIS
    // que uma run termina — durante toda a sessão viva ele fica em zero, e a
    // projeção nunca aparecia justamente enquanto haveria alguém olhando.
    //
    // Em vez disso, usamos o tempo de parede real do FLUXO INTEIRO: da criação
    // da sessão-raiz até agora. Ressalva: isto mede o relógio de parede do
    // fluxo inteiro, não a soma dos tempos de execução ativa — se houver uma
    // aprovação pendente no meio, o burn rate cai artificialmente durante a
    // espera, porque o relógio não pausa. É uma simplificação aceitável, e
    // mais correta que o zero de hoje.
    const rootSession = this.store.sessions.get(rootId);
    const elapsedSeconds = rootSession
      ? (Date.now() - Date.parse(rootSession.createdAt)) / 1000
      : snap.consumed.seconds;
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
  /**
   * Encerra todas as runs vivas.
   *
   * `allSettled`, nunca `all`: com `all`, um único `cancel` que rejeitasse
   * abortava o desligamento inteiro — e o que vem depois dele, na ordem do
   * `hub.shutdown()`, é fechar o banco. Uma sessão problemática deixava o
   * SQLite sem fechar e TODOS os outros filhos órfãos. O cancelamento de cada
   * sessão é independente por natureza; tratá-lo como tudo-ou-nada só
   * transformava uma falha pequena numa grande.
   */
  async shutdown(): Promise<void> {
    // Inclui as sessões em fechamento (validação/revisão/backoff): a run já
    // saiu de `#runs`, mas o comando de validação ou o revisor ainda estão
    // vivos — e ficavam órfãos depois que o daemon saía.
    const sessions = [...new Set([...this.#runs.keys(), ...this.#ciclo.sessoesEmFechamento()])];
    const desfechos = await Promise.allSettled(
      sessions.map((id) => this.cancel(id, 'daemon encerrando')),
    );

    for (const [i, desfecho] of desfechos.entries()) {
      if (desfecho.status === 'rejected') {
        console.error(
          `[agents-hub] falha ao encerrar a sessão ${sessions[i]} no desligamento: ` +
            `${desfecho.reason instanceof Error ? desfecho.reason.message : String(desfecho.reason)}`,
        );
      }
    }

    // Cancelar a run não encerra o pump: ele ainda drena o que restou do stream
    // e escreve o desfecho no banco. Quem chama `shutdown()` fecha o store logo
    // depois, então sair daqui antes disso deixaria escritas em voo contra um
    // banco fechado — perdendo justamente o registro de como a sessão terminou.
    //
    // Com teto: um adapter cujo stream não fecha não pode segurar o
    // desligamento para sempre. Perder o último evento é ruim; não desligar é pior.
    if (this.#pumps.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.#pumps]),
        new Promise((r) => setTimeout(r, 5_000).unref()),
      ]);
    }
  }

  // ---------------------------------------------------------------- internos

  /**
   * Sobe a run de uma sessão.
   *
   * `continuacao`: a sessão já existia e só ganha um turno novo (`send`). Se o
   * agente não subir, quem chamou devolve a sessão ao estado anterior — ela
   * continua retomável. Em todo outro caminho (sessão nova, delegação
   * aprovada, retry, fallback, handoff) não sobra nada rodando: a sessão
   * termina `failed` com o motivo, a task `failed`, a reserva do orçamento
   * volta para o fluxo e o worktree ainda limpo é liberado.
   */
  async #launch(
    session: Session,
    task: Task,
    prompt: string,
    nativeSessionId: string | null,
    opcoes: { continuacao?: boolean } = {},
  ): Promise<void> {
    const adapter = this.registry.get(session.agentId);
    const manifest = adapter.manifest;

    let ctx!: RunContext;
    let handle: RunHandle;
    try {
      const gate = this.#codexGate(session.agentId, session.mode, session.id);

      ctx = {
        sessionId: session.id,
        taskId: task.id,
        agentId: session.agentId,
        workdir: session.workdir,
        mode: session.mode,
        env: this.#envDoProjeto(session),
        timeoutSeconds: Math.min(
          manifest.defaults.timeoutSeconds,
          this.config.policy.taskTimeoutSeconds,
        ),
        heartbeatSeconds: this.config.policy.heartbeatTimeoutSeconds,
        extraArgs: gate.extraArgs,
      };

      if (gate.aviso) {
        this.#emit({
          sessionId: session.id,
          taskId: task.id,
          agentId: session.agentId,
          type: 'log',
          payload: { stream: 'gate', level: 'warn', text: gate.aviso },
        });
      }

      // O vínculo sessão→raiz vive em memória no barramento. Depois de um
      // restart do daemon, retomar uma sessão sem reidratá-lo deixaria o
      // `watch --root` e o painel cegos para os eventos dela — sem erro nenhum,
      // só silêncio, que é o pior tipo de falha de observabilidade.
      this.bus.registerSession(session.id, session.rootId);
      this.store.sessions.update(session.id, { state: 'running' });

      handle = nativeSessionId
        ? await adapter.resume(ctx, nativeSessionId, prompt)
        : await adapter.start(ctx, prompt);
    } catch (err) {
      if (!opcoes.continuacao) await this.#falhaAoLancar(session, task, err);
      throw err;
    }

    // PID real da run, quando o adapter souber (processo dedicado por
    // sessão). `null` para o OpenCode, cujo processo é o servidor
    // compartilhado, não um filho por sessão — ver comentário em
    // `RunHandle.pid`. Sem isto, `reconcileOnStartup` não sabe qual processo
    // matar quando o daemon reinicia com sessões vivas no banco.
    this.store.sessions.update(session.id, { pid: handle.pid });

    this.#runs.set(session.id, {
      handle,
      sessionId: session.id,
      taskId: task.id,
      ctx,
      startedAt: Date.now(),
    });

    // O pump roda solto: quem chamou `start` não deve esperar o agente terminar.
    //
    // Mas "solto" não é "esquecido": guardamos a promessa para que o
    // desligamento consiga esperar o pump drenar antes de fechar o banco. Sem
    // isto, `store.close()` acontecia com pumps ainda vivos, e a escrita
    // seguinte falhava com "database is not open" — erro que, sem handler de
    // `unhandledRejection`, derrubava o processo em vez de aparecer.
    const drenando = this.#pump(session, task, handle).finally(() => {
      this.#pumps.delete(drenando);
    });
    this.#pumps.add(drenando);
    this.#ciclo.registrarPump(session.id, drenando);

    // Um cancelamento que chegou enquanto o agente subia (no `await` acima)
    // não achou run para matar. Mata agora; o pump fecha a sessão como
    // cancelada.
    if (this.#ciclo.cancelada(session.id)) await adapter.cancel(handle);
  }

  /**
   * Desfaz uma sessão cujo agente não chegou a subir (ou cuja subida foi
   * recusada). Idempotente: sessão já terminal não é tocada.
   */
  async #falhaAoLancar(session: Session, task: Task, err: unknown): Promise<void> {
    const atual = this.store.sessions.get(session.id);
    if (!atual || isTerminalSessionState(atual.state)) return;

    const motivo = err instanceof Error ? err.message : String(err);
    const codigo = err instanceof HubError ? err.code : null;
    const tarefa = this.store.tasks.get(task.id) ?? task;
    if (!isTerminalTaskState(tarefa.state)) {
      this.store.tasks.update(task.id, {
        state: 'failed',
        attempts: closeLastAttempt(tarefa.attempts, 'permanent', motivo),
      });
    }

    // A fatia reservada para esta delegação volta para o fluxo: ela nunca
    // vai ser gasta.
    const ledger = this.#ledger(atual.rootId);
    ledger.release(task.id);
    this.#persistLedger(ledger);

    this.#emit({
      sessionId: atual.id,
      taskId: task.id,
      agentId: atual.agentId,
      type: 'error',
      payload: {
        priority: 'high',
        phase: 'launch',
        code: codigo,
        message: `o agente ${atual.agentId} não pôde ser iniciado: ${motivo}`,
      },
    });
    this.#emit({
      sessionId: atual.id,
      taskId: task.id,
      agentId: atual.agentId,
      type: 'session.ended',
      payload: { reason: `falha ao iniciar o agente: ${motivo}`, state: 'failed', code: codigo },
    });

    // Antes de `#finish`: um aviso de worktree retido emitido depois dele
    // perderia o roteamento pela raiz.
    await this.#liberarWorktree(atual);
    await this.#concludeSession(atual, tarefa, 'failed', motivo);
  }

  /** Desfaz o que `start()` deixou para trás quando algo lançou no meio. */
  async #desfazerInicio(err: unknown, feito: InicioFeito): Promise<void> {
    try {
      if (feito.sessao) await this.#falhaAoLancar(feito.sessao.session, feito.sessao.task, err);
      if (feito.reserva) {
        feito.reserva.ledger.release(feito.reserva.taskId);
        this.#persistLedger(feito.reserva.ledger);
      }
      if (feito.worktree) {
        await this.worktrees
          .release({ projectPath: feito.worktree.projectPath, worktreePath: feito.worktree.path })
          .catch(() => undefined);
      }
    } catch (limpeza) {
      // O erro original é o que importa para quem chamou; a limpeza falhar
      // vira log, não troca a mensagem.
      console.error(
        `[agents-hub] falha ao desfazer o início da sessão: ${(limpeza as Error).message}`,
      );
    }
  }

  /**
   * Libera o worktree de uma sessão que termina sem ter produzido nada.
   * `release` não força: worktree com arquivo alterado fica (o reaper decide).
   */
  async #liberarWorktree(session: Session): Promise<void> {
    if (session.isolation !== 'worktree') return;
    const project = this.store.projects.get(session.projectId);
    if (!project || path.resolve(project.path) === path.resolve(session.workdir)) return;
    try {
      const r = await this.worktrees.release({
        projectPath: project.path,
        worktreePath: session.workdir,
      });
      if (!r.removed) {
        this.#emit({
          sessionId: session.id,
          taskId: null,
          agentId: session.agentId,
          type: 'log',
          payload: { level: 'warn', text: `worktree mantido em ${session.workdir}: ${r.reason ?? ''}` },
        });
      }
    } catch {
      /* o reaper tenta de novo depois da retenção */
    }
  }

  /**
   * Config do gate pré-execução para esta invocação — hoje só o Codex precisa
   * disto, porque só ele exige argumento novo a cada spawn (ver
   * `codex-gate.ts`). Todo outro agente devolve `extraArgs: []` sem efeito.
   *
   * Lança quando o modo promete prevenção (`supervised`) e o gate não pode ser
   * garantido: seguir em frente sem avisar deixaria a sessão rodar sem a
   * proteção que o próprio modo prometeu, silenciosamente.
   */
  #codexGate(
    agentId: string,
    mode: SessionMode,
    sessionId: string,
  ): { extraArgs: string[]; aviso?: string } {
    if (agentId !== 'codex') return { extraArgs: [] };

    // O Codex não repassa `AGENTS_HUB_SESSION_ID` ao hook (só `CODEX_*`), então
    // o id vai no próprio comando. Sem ele, a correlação dependia do `cwd` — e
    // o hook não sabia que a chamada era de uma sessão do Hub, que é o que
    // decide falhar FECHADO se o daemon sumir.
    const comando = `${segmentoDeComando(process.execPath)} ${segmentoDeComando(cliHookEntrypoint())} hook --dialect codex --session ${sessionId}`;
    const config = montarConfigDoGate(
      { comando, timeoutSec: TIMEOUT_PADRAO_SEC },
      this.config.codexGate.bypassHookTrust,
    );

    if (!config.garantido && modoExigeGate(mode)) {
      throw new HubError(
        'CODEX_GATE_NOT_GUARANTEED',
        `Sessão em modo "supervised", mas o gate pré-execução do Codex não está garantido: ${config.aviso}`,
        { agentId, mode },
      );
    }

    return config.aviso ? { extraArgs: config.args, aviso: config.aviso } : { extraArgs: config.args };
  }

  async #pump(session: Session, task: Task, handle: RunHandle): Promise<void> {
    const ledger = this.#ledger(session.rootId);
    let nativeSeen = session.nativeSessionId;
    // O custo final do turno substitui as estimativas parciais em vez de
    // somar a elas (ver `TurnCostTracker`).
    const custos = new TurnCostTracker(baseDoAcumulado(this.store, session));
    // Um estouro por run: depois dele o que ainda chega do stream (a linha de
    // custo final depois da estimativa parcial, por exemplo) não pode abrir
    // outra aprovação de orçamento para a mesma parada.
    let estourou = false;
    let turnoConcluidoNoEstouro = false;
    // O motivo que o agente deu (ex.: "Prompt is too long"), para a tentativa
    // não ficar só com "processo terminou com código 1" (achado 11 da 08).
    let erroDoAgente: string | null = null;
    // Orçamento em SEGUNDOS: só era somado em `settle`, depois que a run
    // acabava — um teto de 3 s com um agente de 9 s terminava `completed` com
    // "300% do orçamento". O relógio aqui é o teto de tempo de parede desta
    // run, com o que o fluxo ainda tem de saldo em segundos.
    const tetoDeTempo = this.#armarTetoDeTempo(session, task, handle, ledger, () => {
      if (estourou) return false;
      estourou = true;
      return true;
    });

    try {
      for await (const bruto of handle.events) {
        const mapped = this.#priceEvent(session, bruto);
        this.#persistMapped(session, task, mapped);
        if (mapped.type === 'error') erroDoAgente = textoDoErroDoAgente(mapped.payload) ?? erroDoAgente;

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
          const passo = custos.observe(mapped.cost);
          const snapshot =
            passo.kind === 'final'
              ? ledger.charge(usoDoCusto(passo.cost), task.id)
              : ledger.estimate(task.id, usoDoCusto(passo.total));
          this.#persistLedger(ledger);
          this.#checkBudgetWarning(session, task.id, snapshot);

          if (snapshot.exhausted && !estourou) {
            estourou = true;
            // Estouro na linha de custo FINAL do turno = o turno já acabou; o
            // agente não está no meio de nada. Aprovar depois disso não pode
            // relançá-lo (era um turno extra, não pedido, que estourava de
            // novo): só finaliza a tarefa. O processo é encerrado do mesmo
            // jeito — nada mais pode rodar por cima do teto —, e o `canceled`
            // que isso produz não é falha do agente (ver depois do `done`).
            turnoConcluidoNoEstouro = passo.kind === 'final';
            this.#abrirEstouroDeOrcamento(session, task, snapshot, turnoConcluidoNoEstouro);
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

    this.#fecharCustoDoTurno(session, task, custos, ledger);

    const desfechoBruto = await handle.done;
    clearTimeout(tetoDeTempo);
    // O Hub encerrou o processo DEPOIS de o turno concluir (estouro na linha
    // de custo final): o desfecho real do trabalho é sucesso, não `canceled`
    // — senão aprovar o estouro mandaria o turno concluído para retry.
    const outcome: RunOutcome =
      turnoConcluidoNoEstouro && desfechoBruto.reason === 'canceled'
        ? { ...desfechoBruto, reason: 'exit', exitCode: 0, signal: null, error: null }
        : { ...desfechoBruto, error: juntarErroDoAgente(desfechoBruto.error, erroDoAgente) };
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

    // Quem parou esta run anotou o motivo ANTES de mexer no processo
    // (`session-lifecycle.ts`): o desfecho do processo sozinho não distingue
    // cancelamento de interrupção de falha. Antes, o cancelamento caía aqui
    // como `canceled`, passava pelo pipeline de falha e sobrescrevia o
    // `killed` gravado por `cancel` com `failed` (6 de 8 vezes, na corrida).
    const pedido = this.#ciclo.pedido(session.id);
    if (pedido?.tipo === 'cancel') {
      await this.#encerrarCancelada(session.id, pedido.motivo);
      return;
    }
    if (pedido) {
      await this.#encerrarTurnoInterrompido(session, task, pedido, outcome);
      return;
    }

    // Outro caminho já fechou a sessão: o desfecho desta run não a reescreve.
    const sessaoAtual = this.store.sessions.get(session.id);
    if (!sessaoAtual || isTerminalSessionState(sessaoAtual.state)) return;

    const current = this.store.tasks.get(task.id);
    // A task já está esperando decisão humana (orçamento estourado ou ação
    // barrada pela vigilância): o fim do processo não pode sobrescrever esse
    // estado com "falhou", senão a aprovação apontaria para uma sessão morta.
    if (current && current.state === 'input_required') {
      const pendente = this.store.approvals.listPending({ sessionId: session.id })[0];
      // Quem aprovar um estouro com o turno já concluído finaliza a tarefa
      // com ESTE desfecho (ver `resolveApproval`), sem relançar o agente.
      this.#desfechoRetido.set(task.id, { outcome, elapsedSeconds });
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

    // A run saiu de `#runs`, mas a sessão ainda não acabou: validação, revisão
    // e backoff de retry acontecem aqui. O fechamento fica registrado para
    // `cancel`/`shutdown` conseguirem abortá-lo (matando o comando de
    // validação ou o revisor) em vez de o cancelado "ressuscitar" como
    // `completed` no fim da validação.
    const fechamento = this.#ciclo.abrirFechamento(session.id);
    try {
      await this.#settle(session, current ?? task, outcome, elapsedSeconds, fechamento.signal);
    } catch (err) {
      // Rede de segurança: exceção no fechamento (ex.: substituto do fallback
      // que não subiu) não pode deixar a sessão `running` sem processo nem
      // virar rejeição sem dono.
      const depois = this.store.sessions.get(session.id);
      if (depois && !isTerminalSessionState(depois.state) && !this.#runs.has(session.id)) {
        await this.#falhaAoLancar(depois, this.store.tasks.get(task.id) ?? task, err);
      }
    } finally {
      this.#ciclo.fecharFechamento(session.id, fechamento);
    }

    // Cancelado no meio do fechamento: `#settle` parou no ponto de checagem
    // seguinte sem gravar desfecho; fecha como cancelada aqui.
    const pedidoTardio = this.#ciclo.pedido(session.id);
    if (pedidoTardio?.tipo === 'cancel' && !this.#runs.has(session.id)) {
      await this.#encerrarCancelada(session.id, pedidoTardio.motivo);
    }
  }

  /**
   * Fecha uma sessão cancelada: sessão `killed`, task `canceled` (o estado
   * A2A que existia e nunca era gravado), pai avisado com `canceled` — não
   * com `failed`, que faria quem delegou tentar de novo algo que o usuário
   * mandou parar.
   *
   * É o ÚNICO caminho de fechamento de um cancelamento: chamado pelo pump
   * quando a run morre (depois de drenar os eventos dela, para nenhum evento
   * chegar depois de `#finish` e perder o roteamento pela raiz) ou pelo
   * próprio `cancel` quando não havia run. Idempotente.
   */
  async #encerrarCancelada(sessionId: string, motivo: string): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session || isTerminalSessionState(session.state)) {
      this.#ciclo.esquecer(sessionId);
      return;
    }

    const task = this.#latestTaskOrNull(sessionId);
    if (task && !isTerminalTaskState(task.state)) {
      const aberta = task.attempts.at(-1)?.endedAt === null;
      this.store.tasks.update(task.id, {
        state: 'canceled',
        ...(aberta ? { attempts: closeLastAttempt(task.attempts, 'canceled', motivo) } : {}),
      });
      const ledger = this.#ledger(session.rootId);
      ledger.release(task.id);
      this.#persistLedger(ledger);
    }

    this.#emit({
      sessionId,
      taskId: task?.id ?? null,
      agentId: session.agentId,
      type: 'session.ended',
      payload: { reason: motivo, state: 'killed' },
    });

    if (session.parentId) {
      const parent = this.store.sessions.get(session.parentId);
      if (parent) {
        this.#emit({
          sessionId: parent.id,
          taskId: task?.id ?? null,
          agentId: parent.agentId,
          type: 'delegation.completed',
          payload: {
            childSessionId: session.id,
            agentId: session.agentId,
            state: 'canceled',
            error: motivo,
          },
        });
      }
    }

    if (task) await this.#capturarNoFim(session, task);
    await this.#finish(sessionId, 'killed', motivo);
    this.#ciclo.esquecer(sessionId);
  }

  /**
   * Fecha um TURNO parado a pedido (interrupt/pause) sem encerrar a sessão.
   *
   * No Windows parar o turno é matar o processo (não há SIGINT entregável), e
   * esse desfecho caía no pipeline de falha: `hub interrupt` respondia
   * "interrompido" e a sessão terminava `failed`, irrecuperável. Aqui a sessão
   * fica `idle` (interrupt) ou `paused` (pause), a task `input_required` —
   * esperando a próxima instrução — e `send` a retoma: resume nativo quando o
   * agente tem, replay do histórico quando não. A tentativa continua aberta:
   * interromper não é falhar, e não pode gastar retry.
   */
  async #encerrarTurnoInterrompido(
    session: Session,
    task: Task,
    pedido: PedidoDeParada,
    outcome: RunOutcome,
  ): Promise<void> {
    this.#ciclo.esquecer(session.id);
    const atual = this.store.sessions.get(session.id);
    if (!atual || isTerminalSessionState(atual.state)) return;

    const estado = pedido.tipo === 'pause' ? 'paused' : 'idle';
    const tarefa = this.store.tasks.get(task.id);
    this.store.transaction(() => {
      this.store.sessions.update(session.id, { state: estado, pid: null });
      if (tarefa && !isTerminalTaskState(tarefa.state)) {
        this.store.tasks.update(tarefa.id, { state: 'input_required' });
      }
    });

    this.#emit({
      sessionId: session.id,
      taskId: task.id,
      agentId: session.agentId,
      type: 'turn.completed',
      payload: {
        reason: 'interrupted',
        interrupted: true,
        state: estado,
        exitCode: outcome.exitCode,
        outcomeClass: 'interrupted',
        message:
          `turno interrompido (${pedido.motivo}) — sessão ${estado === 'paused' ? 'pausada' : 'ociosa'}; ` +
          'envie uma mensagem para retomar',
      },
    });
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
    signal?: AbortSignal,
  ): Promise<void> {
    // Pontos de checagem depois de cada `await` longo: um `cancel` no meio da
    // validação/revisão aborta o sinal e a sessão não pode, na volta, gravar
    // `completed` (ou `failed`) por cima do pedido — quem fecha é o pump.
    const cancelada = (): boolean => this.#ciclo.cancelada(session.id);

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
        ...(signal ? { signal } : {}),
      });
      if (cancelada()) return;

      // O portão de revisão roda DEPOIS do comando: reprovar no build é barato
      // e determinístico, e não faz sentido pagar uma sessão de modelo para
      // revisar código que nem compila.
      if (validationPassed(validation)) {
        const artefatos = await this.#capturarMudancas(session, task);
        if (cancelada()) return;
        const revisao = await this.#revisar(session, task, artefatos, signal);
        if (cancelada()) return;

        // Aprovação também deixa rastro (R13-17): antes só a reprovação virava
        // evento/`validation`, e uma revisão APROVADA só aparecia no custo.
        if (revisao?.passed) {
          validation = {
            passed: validation?.passed ?? true,
            checks: [...(validation?.checks ?? []), ...revisao.checks],
          };
          const check = revisao.checks[0];
          this.#emit({
            sessionId: session.id,
            taskId: task.id,
            agentId: session.agentId,
            type: 'log',
            payload: {
              level: 'info',
              kind: 'review.approved',
              text: `${check?.name ?? 'revisão'}: APROVADO${check?.detail ? ` — ${check.detail}` : ''}`,
            },
          });
        }

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

        // ANTES de a task virar `completed`: quem espera por ela (o passo
        // seguinte de um workflow) cria o próprio worktree a partir deste
        // commit assim que a vê concluída.
        await this.#commitarWorktree(session, task);

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
    // `retries` e `fallback` da política EFETIVA da sessão (global + projeto,
    // só apertando): antes vinham da global e `retries: {max: 0}` no
    // `.agents-hub/config.yaml` do projeto ainda rodava o agente 3 vezes.
    const efetiva = this.policyFor(session).policy;
    const step = nextStep(
      { attempts, currentAgentId: session.agentId },
      effectiveClass,
      {
        maxRetries: efetiva.retries.max,
        backoffMs: efetiva.retries.backoffMs,
        fallbackChain: this.#fallbackChain(session.agentId, efetiva.fallback),
      },
      { reason: outcome.reason },
    );

    this.store.tasks.update(task.id, { attempts });

    if (step.kind === 'retry') {
      await this.#retry(session, task, step.agentId, step.backoffMs, step.reason, validation, signal);
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
    signal?: AbortSignal,
  ): Promise<void> {
    this.#emit({
      sessionId: session.id,
      taskId: task.id,
      agentId,
      type: 'log',
      payload: { level: 'warn', text: `nova tentativa em ${backoffMs}ms — ${reason}` },
    });

    // Abortável: um cancelamento no meio do backoff não espera os segundos
    // restantes, e quem fecha a sessão (task `canceled`) é o pump — antes a
    // task ficava `working` para sempre.
    await esperarAbortavel(backoffMs, signal);
    if (this.#ciclo.cancelada(session.id)) return;

    // A sessão pode ter terminado enquanto esperávamos o backoff.
    const fresh = this.store.sessions.get(session.id);
    if (!fresh || isTerminalSessionState(fresh.state) || fresh.state === 'waiting_approval') return;

    // Checa o teto e já reserva a vaga na mesma operação síncrona — mesma
    // correção de `start()`. Sem isto, duas tentativas de retry concorrentes
    // (ex: dois filhos do mesmo fluxo falhando ao mesmo tempo) liam o mesmo
    // `#runs` antes de qualquer uma registrar a sua.
    try {
      this.#reserveSlot(session.id, agentId, session.projectId);
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

    try {
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
        canResume ? feedback : `${renderBriefAsPrompt(task.brief, this.#contextoDoProjeto(fresh))}\n\n${feedback}`,
        canResume ? fresh.nativeSessionId : null,
      );
    } catch {
      // `#launch` já fechou a sessão como `failed` (agente sumiu entre as
      // tentativas, por exemplo). Relançar aqui só viraria rejeição no pump.
    } finally {
      this.#releaseSlot(session.id);
    }
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
    // fallbacks em paralelo não pode furar o teto de concorrência. Reserva já
    // conta a vaga na mesma checagem síncrona — mesma correção de `start()`.
    const sessionId = newId('ses');
    try {
      this.#reserveSlot(sessionId, agentId, session.projectId);
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

    try {
      // O substituto parte de onde o original PARTIU — o branch `hub/<id>`
      // dele, que carrega a base do workflow (o código dos passos anteriores)
      // e nunca o trabalho da tentativa falha, que não é commitado. Do HEAD do
      // projeto ele perderia o código herdado de um passo anterior.
      const baseDoOriginal =
        session.isolation === 'worktree' && (await branchExiste(project.path, `hub/${session.id}`))
          ? `hub/${session.id}`
          : undefined;
      const worktree = await this.worktrees.create({
        projectPath: project.path,
        projectName: project.name,
        sessionId,
        isolation: session.isolation,
        ...(baseDoOriginal !== undefined ? { baseRef: baseDoOriginal } : {}),
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

      // Criar a sessão substituta e reatribuir a task a ela são duas escritas
      // relacionadas: se o daemon cair entre uma e outra, a task fica com
      // `sessionId` apontando para a sessão ANTIGA (já terminal), e
      // `reconcileOnStartup` nunca a revisita — um vazamento permanente.
      // `transaction` garante que as duas acontecem juntas ou nenhuma.
      let updated!: Task;
      this.store.transaction(() => {
        this.store.sessions.create(replacement);
        const anterior = this.store.tasks.get(task.id) ?? task;
        updated = this.store.tasks.update(task.id, {
          sessionId,
          attempts: [...anterior.attempts, novaTentativa(anterior.attempts.length + 1, agentId)],
        });
      });

      this.bus.registerSession(sessionId, replacement.rootId);
      this.#avisarConfigDoProjetoQuebrada(replacement, task.id, project);
      this.#avisarDependenciasNaoLigadas(replacement, task.id, worktree.dependencyWarnings);

      // O histórico de falhas vai junto: sem ele o substituto recomeça cego e
      // tende a cair no mesmo buraco.
      // `replacement`, nao a sessao que falhou: o substituto e OUTRO agente, e
      // quem tem instrucoes proprias no projeto e ele.
      const prompt = [
        renderBriefAsPrompt(task.brief, this.#contextoDoProjeto(replacement)),
        failureContext(updated.attempts),
      ]
        .filter((part) => part.length > 0)
        .join('\n\n');

      await this.#launch(replacement, updated, prompt, null);
    } finally {
      this.#releaseSlot(sessionId);
    }
  }

  /** Cadeia de fallback do agente, já filtrando quem não está instalado. */
  #fallbackChain(agentId: string, fallback: PolicyDocument['fallback'] = this.config.policy.fallback): string[] {
    return this.registry
      .fallbackFor(agentId, fallback)
      .filter((id) => this.registry.cachedProbe(id)?.installed !== false);
  }

  /**
   * Commita o trabalho da sessão no branch `hub/<id>` do worktree dela.
   *
   * Falhar aqui não reprova a tarefa — o trabalho está no disco e o diff já
   * foi capturado —, mas precisa aparecer: sem o commit, quem parte deste
   * branch (o passo seguinte do workflow) não recebe o código.
   */
  async #commitarWorktree(session: Session, task: Task): Promise<void> {
    if (session.isolation !== 'worktree') return;
    const project = this.store.projects.get(session.projectId);
    if (!project || path.resolve(session.workdir) === path.resolve(project.path)) return;
    try {
      const sha = await commitarTrabalho(
        session.workdir,
        `hub: trabalho de ${session.agentId} na sessão ${session.id}

${task.brief.objective.slice(0, 500)}`,
      );
      if (sha) {
        this.#avisar(session, task.id, `trabalho commitado em hub/${session.id} (${sha.slice(0, 10)})`, 'info');
      }
    } catch (err) {
      this.#avisar(
        session,
        task.id,
        `não foi possível commitar o trabalho em hub/${session.id}: ${(err as Error).message} — ` +
          'quem partir deste branch não recebe o código',
      );
    }
  }

  /** Fecha a sessão, avisa o pai e libera o que precisa ser liberado. */
  async #concludeSession(
    session: Session,
    task: Task,
    state: 'completed' | 'failed',
    error: string | null,
    options: { silentParent?: boolean } = {},
  ): Promise<void> {
    // Sessão já fechada (cancelada, por exemplo): o pai já ouviu o desfecho
    // verdadeiro e não pode receber um segundo, contraditório.
    const gravada = this.store.sessions.get(session.id);
    if (gravada && isTerminalSessionState(gravada.state)) return;

    // O que o agente escreveu antes de falhar também é registro do trabalho
    // (R06-14): antes só o caminho de sucesso gerava o artefato de diff, e o
    // worktree — única prova — é apagado pelo reaper depois.
    if (state === 'failed') await this.#capturarNoFim(session, task);

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
  /**
   * Vigilância reativa. Decisão em `avaliarVigilancia`
   * (`packages/adapters/src/guarded-actions.ts`) — aqui só os efeitos
   * (emitir alerta, abrir aprovação), que dependem de `store`/`bus`.
   */
  /**
   * Diretórios de trabalho do próprio agente (plano do Claude em
   * `~/.claude/plans`): escrita ali não pede aprovação — ver `agentOwnDirs`.
   */
  #agentDirs(session: Session): string[] {
    return agentOwnDirs(session.agentId, os.homedir(), process.env);
  }

  #watch(session: Session, task: Task, mapped: MappedEvent): 'ok' | 'flagged' | 'paused' {
    const engine = this.policyFor(session);
    // `watch` da política EFETIVA (global + projeto + pai): o projeto que pede
    // `pauseOn: [escalate]` precisa de fato parar em `escalate`.
    const watch = watchForMode(engine.policy.watch, session.mode);
    const veredito = avaliarVigilancia(
      mapped,
      session.workdir,
      session.mode,
      engine,
      watch,
      this.#agentDirs(session),
    );

    for (const f of veredito.flagged) {
      this.#emit({
        sessionId: session.id,
        taskId: task.id,
        agentId: session.agentId,
        type: 'log',
        payload: {
          level: 'warn',
          text: `ação de risco "${f.risk}": ${describeAction(f.action)} — ${f.reason}`,
        },
      });
    }

    if (veredito.outcome === 'paused' && veredito.pausedBy) {
      this.#requestApproval({
        session,
        taskId: task.id,
        risk: veredito.pausedBy.risk,
        action: describeAction(veredito.pausedBy.action),
        detail: {
          kind: 'watch',
          reason: veredito.pausedBy.reason,
          eventType: mapped.type,
          alreadyExecuted: true,
        },
      });
    }

    return veredito.outcome;
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

  /**
   * Turno que acabou sem custo final do agente (Copilot nunca manda um; um
   * processo morto no meio também não): a última estimativa vira custo num
   * evento próprio, para o store/grafo e o orçamento não perderem o gasto.
   */
  #fecharCustoDoTurno(
    session: Session,
    task: Task,
    custos: TurnCostTracker,
    ledger: BudgetLedger,
  ): void {
    const cumulativeUsd = custos.cumulativeUsd;
    const cumulativeCredits = custos.cumulativeCredits;
    const aberto = custos.flush();
    if (!aberto) return;

    const creditos = aberto.credits;
    const event = makeEvent(
      {
        sessionId: session.id,
        taskId: task.id,
        agentId: session.agentId,
        type: 'log',
        payload: {
          kind: CUSTO_FECHADO,
          text:
            typeof creditos === 'number'
              ? `custo do turno: ${creditos.toFixed(2)} AI Credits (US$ ${(aberto.usd ?? 0).toFixed(4)})`
              : `custo do turno fechado pela estimativa: US$ ${(aberto.usd ?? 0).toFixed(4)} (o agente não informou o total)`,
          costBasis: typeof creditos === 'number' ? 'reported' : 'estimated',
          ...(cumulativeUsd !== null ? { cumulativeUsd } : {}),
          ...(cumulativeCredits !== null ? { cumulativeCredits } : {}),
        },
        cost: aberto,
        raw: null,
      },
      this.#nextSeq(session.id),
    );
    this.store.events.append(event);
    this.bus.publish(event);

    const snapshot = ledger.charge(usoDoCusto(aberto), task.id);
    this.#persistLedger(ledger);
    this.#checkBudgetWarning(session, task.id, snapshot);
  }

  #persistMapped(session: Session, task: Task, mapped: MappedEvent): void {
    // Tetos por evento e por sessão (item 2.5, ver `event-limits.ts`): o que o
    // agente imprime não pode inchar o banco, o barramento e o SSE sem limite.
    const { evento: limitado, aviso } = this.#tetoDeSaida.admitir(session.id, mapped);
    if (aviso) {
      this.#emit({
        sessionId: session.id,
        taskId: task.id,
        agentId: session.agentId,
        type: 'log',
        payload: { stream: 'daemon', level: 'warn', text: aviso },
      });
    }
    if (!limitado) return;
    const event = makeEvent(
      {
        sessionId: session.id,
        taskId: task.id,
        agentId: session.agentId,
        type: mapped.type,
        payload: limitado.payload,
        cost: mapped.cost ?? null,
        raw: limitado.raw as MappedEvent['raw'],
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

  /**
   * Avisa na timeline quando o YAML de projeto está quebrado.
   *
   * `loadProjectOverrides`/`loadProjectContext` já caem na política global e já
   * `console.error` no log do daemon — mas isso não aparece pra quem só olha o
   * painel da sessão, exatamente onde a política "deveria" estar mais apertada
   * e não está. Chamado uma vez no nascimento da sessão, não a cada gate.
   *
   * Também avisa quando o YAML declara campos sensíveis (`validation.command`,
   * revisão, `env`, `prompts`, `memory`) e eles foram IGNORADOS por o projeto
   * não ser confiável ou por a confiança estar suspensa (o conteúdo mudou
   * depois de confiado) — sem isto, quem configurou `npm test` ou um Ollama
   * no repo veria o efeito simplesmente não acontecer, sem saber por quê.
   */
  #avisarConfigDoProjetoQuebrada(session: Session, taskId: string, project: Project): void {
    const { trust } = effectiveProjectContext(this.store, project);
    const overrides = loadProjectOverrides(project.path, { trusted: trust.state === 'trusted' });
    const contexto = loadProjectContext(project.path);

    // Campos sensíveis do repo (execução, env, prompts, memória) ignorados por
    // falta de confiança ou por confiança suspensa — ver `repo-trust.ts`.
    const aviso = repoTrustWarning(project.path, trust);
    if (aviso !== null) {
      this.#emit({
        sessionId: session.id,
        taskId,
        agentId: session.agentId,
        type: 'log',
        payload: {
          level: 'warn',
          text: aviso,
          repoTrust: trust.state,
          ignoredRepoFields: trust.sensitiveFields,
          ignoredExecFields: overrides.ignoredExecFields,
        },
      });
    }

    const erro = overrides.error ?? contexto.error;
    if (!erro) return;

    this.#emit({
      sessionId: session.id,
      taskId,
      agentId: session.agentId,
      type: 'log',
      payload: {
        level: 'warn',
        text: `configuração do projeto (.agents-hub/config.yaml) inválida — usando política global sem os ajustes do projeto: ${erro}`,
      },
    });
  }

  /**
   * Avisa na timeline quando `node_modules`/`.venv`/`vendor` não puderam ser
   * ligados no worktree — o sintoma sem este sinal é "o portão de validação
   * reprovou sem motivo aparente", que a Fase 2 já corrigiu uma vez por outro
   * caminho.
   */
  /** Uma linha de aviso na timeline da sessão. */
  #avisar(session: Session, taskId: string | null, text: string, level: 'warn' | 'info' = 'warn'): void {
    this.#emit({
      sessionId: session.id,
      taskId,
      agentId: session.agentId,
      type: 'log',
      payload: { level, text },
    });
  }

  #avisarDependenciasNaoLigadas(session: Session, taskId: string, avisos: string[]): void {
    if (avisos.length === 0) return;

    this.#emit({
      sessionId: session.id,
      taskId,
      agentId: session.agentId,
      type: 'log',
      payload: {
        level: 'warn',
        text: `dependências não ligadas neste worktree — build/testes podem falhar por causa disso: ${avisos.join('; ')}`,
      },
    });
  }

  async #finish(sessionId: string, state: Session['state'], _reason?: string): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session) return;
    // Estado terminal não se reescreve: era assim que um `killed` gravado por
    // `cancel` virava `failed` quando o pump da mesma run terminava depois.
    if (isTerminalSessionState(session.state)) return;

    // `pid: null` no mesmo update que encerra: um PID sem sessão viva
    // associada não pode sobreviver no banco depois que a sessão termina
    // limpo, senão a reconciliação da próxima subida tentaria matar um PID
    // que o SO já reciclou para outro processo qualquer.
    this.store.sessions.update(sessionId, { state, endedAt: nowIso(), pid: null });
    this.bus.forgetSession(sessionId);

    // Nenhuma aprovação pendente pode sobreviver à sessão que a gerou.
    //
    // Sem isto, uma aprovação de vigilância ou delegação ficava órfã
    // (`pending` para sempre) quando a sessão terminava com ela ainda em
    // aberto — por exemplo, `cancel()` no pai encerra filhos em
    // `waiting_approval` sem tocar na tabela de aprovações. Resolver essa
    // aprovação órfã dias depois ressuscitava um processo de agente novo para
    // uma sessão que todo o resto do sistema já tratava como encerrada — o
    // mesmo sintoma que a checagem de terminalidade em `resolveApproval`
    // combate, mas fechando a causa, não só o sintoma: com a aprovação já
    // `denied` aqui, `resolveApproval` nem chega a rodar — barra na checagem
    // de `state !== 'pending'` do topo da função.
    for (const pendente of this.store.approvals.listPending({ sessionId })) {
      this.store.approvals.update(pendente.id, {
        state: 'denied',
        resolvedAt: nowIso(),
        resolvedBy: `sistema (sessão ${state})`,
      });
      this.#emit({
        sessionId,
        taskId: pendente.taskId,
        agentId: session.agentId,
        type: 'log',
        payload: {
          level: 'warn',
          text: `aprovação ${pendente.id} negada automaticamente: a sessão terminou (${state}) antes de uma decisão`,
        },
      });
    }

    // Caches por sessão: sem isto, cada sessão encerrada deixava três entradas
    // para sempre. O daemon é um processo de vida longa — é justamente onde um
    // crescimento monotônico discreto termina em heap estourada depois de dias.
    //
    // Todos os três são cache, não estado: `#ledgers` se remonta do banco em
    // `#ledger()`, `#seeded` volta a semear o `seq` na primeira emissão, e
    // `#models` é reposto pelo próximo evento que declare modelo. Descartar é
    // seguro; o que não é seguro é descartar cedo demais.
    this.#seeded.delete(sessionId);
    this.#models.delete(sessionId);

    // `#ledgers` é chaveado pela RAIZ, não pela sessão: o orçamento é do fluxo
    // inteiro (ADR 03) e os descendentes consomem do mesmo saldo. Só dá para
    // esquecê-lo quando o fluxo todo acabou — soltar no fim de uma sessão
    // qualquer faria os irmãos ainda vivos remontarem o ledger do banco no meio
    // do consumo, perdendo a reserva que ainda não foi liquidada.
    const irmaosVivos = this.store.sessions
      .list({ rootId: session.rootId })
      .some((s) => s.id !== sessionId && !isTerminalSessionState(s.state));
    if (!irmaosVivos) {
      this.#ledgers.delete(session.rootId);
      this.#warned.delete(session.rootId);
    }

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
    signal?: AbortSignal,
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
        this.policyFor(session).policy.fallback,
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
      const alternativa = this.#fallbackChain(
        session.agentId,
        this.policyFor(session).policy.fallback,
      )[0];
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

    return this.#executarRevisao(session, task, revisor, signal);
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
    signal?: AbortSignal,
  ): Promise<ValidationOutcome> {
    const adapter = this.registry.get(revisorId);
    const diff = await captureDiff(
      session.workdir,
      await loadBaseline(this.config.artifactRoot, session.id),
    );
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
      // O revisor é outro agente: o ambiente que ele recebe é o DELE.
      env: this.#envDoProjeto({ ...session, agentId: revisorId }),
      timeoutSeconds: Math.min(600, this.config.policy.taskTimeoutSeconds),
      heartbeatSeconds: this.config.policy.heartbeatTimeoutSeconds,
    };

    try {
      const gate = this.#codexGate(revisorId, session.mode, session.id);
      ctx.extraArgs = gate.extraArgs;
      if (gate.aviso) {
        this.#emit({
          sessionId: session.id,
          taskId: task.id,
          agentId: revisorId,
          type: 'log',
          payload: { stream: 'gate', level: 'warn', text: gate.aviso },
        });
      }

      // Cancelamento/desligamento no meio da revisão mata o revisor: sem isto
      // ele seguia vivo (e órfão, quando o daemon saía).
      if (signal?.aborted) throw new Error('revisão abortada: sessão encerrada');
      const handle = await adapter.start(ctx, prompt);
      const matarRevisor = (): void => {
        void adapter.cancel(handle);
      };
      signal?.addEventListener('abort', matarRevisor, { once: true });
      if (signal?.aborted) matarRevisor();
      const textos: string[] = [];
      // Revisão nova, sessão nativa nova: acumulado começa do zero.
      const custos = new TurnCostTracker();
      const escopo = `${task.id}#revisao`;
      const ledger = this.#ledger(session.rootId);

      for await (const evento of handle.events) {
        if (evento.type === 'message') {
          const texto = evento.payload['text'];
          if (typeof texto === 'string') textos.push(texto);
        }
        // O custo da revisão é do fluxo como qualquer outro: sai do mesmo
        // orçamento, senão ligar a revisão furaria o teto em silêncio. Com a
        // mesma regra do turno normal: o custo final substitui as parciais.
        if (evento.cost) {
          const passo = custos.observe(evento.cost);
          const snapshot =
            passo.kind === 'final'
              ? ledger.charge(usoDoCusto(passo.cost), escopo)
              : ledger.estimate(escopo, usoDoCusto(passo.total));
          this.#checkBudgetWarning(session, task.id, snapshot);
        }
      }
      const aberto = custos.flush();
      if (aberto) ledger.charge(usoDoCusto(aberto), escopo);

      await handle.done;
      signal?.removeEventListener('abort', matarRevisor);
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

  /** Registra o que a sessão mudou no código. Lógica em `artifact-capture.ts`. */
  async #capturarMudancas(session: Session, task: Task): Promise<string[]> {
    return capturarMudancas(
      { store: this.store, artifactRoot: this.config.artifactRoot, emit: (draft) => this.#emit(draft) },
      session,
      task,
    );
  }

  /**
   * Diff do trabalho numa sessão que acaba em falha ou cancelamento (R06-14).
   * Melhor esforço: erro de git aqui não pode impedir a sessão de fechar. Se
   * a task já tem diff (capturado numa tentativa que passou da validação e
   * reprovou depois), não duplica a linha.
   */
  async #capturarNoFim(session: Session, task: Task): Promise<void> {
    const jaTem = this.store.artifacts
      .list({ sessionId: session.id, taskId: task.id })
      .some((a) => a.kind === 'diff');
    if (jaTem) return;
    try {
      await this.#capturarMudancas(session, task);
    } catch (err) {
      console.error(`[hub] diff da sessão ${session.id} não capturado: ${(err as Error).message}`);
    }
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

  /**
   * Checa o teto de concorrência contando runs de verdade (`#runs`) E
   * reservas em voo (`#reserved`) — sem as duas, uma reserva não impediria
   * uma segunda checagem concorrente de passar antes de a run nascer.
   */
  #assertConcurrency(agentId: string, sessionId: string, projectId?: string): void {
    // Uma sessão ocupa UMA vaga, mesmo com run viva E reserva ao mesmo tempo:
    // é o `handoff`, que reserva a vaga do agente novo enquanto a run antiga da
    // MESMA sessão ainda está em `#runs`. Somar os dois mapas contava a sessão
    // duas vezes — com o Hub cheio, todo handoff era recusado (vistoria
    // 2026-09-25, item 2.7). Por isso a conta é "as OUTRAS sessões ocupando
    // vaga", e na contagem por agente cada sessão vale para o agente que vai
    // rodar nela (a reserva), não para o da run que está saindo.
    const outras = new Set([...this.#runs.keys(), ...this.#reserved.keys()]);
    outras.delete(sessionId);

    if (outras.size >= this.config.policy.maxConcurrency) {
      throw new HubError(
        'CONCURRENCY_EXCEEDED',
        `Limite de ${this.config.policy.maxConcurrency} sessões simultâneas atingido`,
        { active: outras.size, limit: this.config.policy.maxConcurrency },
      );
    }

    let perAgent = 0;
    for (const id of outras) {
      const agente = this.#reserved.get(id)?.agentId ?? this.#runs.get(id)?.ctx.agentId;
      if (agente === agentId) perAgent += 1;
    }
    if (perAgent >= this.config.policy.maxConcurrencyPerAgent) {
      throw new HubError(
        'CONCURRENCY_EXCEEDED',
        `Limite de ${this.config.policy.maxConcurrencyPerAgent} sessões simultâneas para "${agentId}" atingido`,
        { agentId, active: perAgent },
      );
    }

    if (projectId !== undefined) this.#assertConcurrencyDoProjeto(agentId, projectId, sessionId);
  }

  /**
   * Teto de concorrência declarado pelo PROJETO (`maxConcurrency` e
   * `maxConcurrencyPerAgent` no `.agents-hub/config.yaml`, já com o clamp que
   * só deixa apertar). Conta só as sessões daquele projeto: é um limite do
   * repositório ("aqui, no máximo N agentes ao mesmo tempo"), não do Hub —
   * o global continua valendo por cima, na checagem acima.
   */
  #assertConcurrencyDoProjeto(agentId: string, projectId: string, sessionId: string): void {
    const politica = this.#projectPolicy(projectId);
    const global = this.config.policy;
    if (
      politica.maxConcurrency >= global.maxConcurrency &&
      politica.maxConcurrencyPerAgent >= global.maxConcurrencyPerAgent
    ) {
      return;
    }

    const ocupadas: string[] = [];
    // Mesma regra do teto global: a sessão que pede a vaga (handoff) não
    // conta contra si mesma.
    for (const [id, run] of this.#runs) {
      if (id === sessionId) continue;
      if (this.store.sessions.get(run.sessionId)?.projectId === projectId) ocupadas.push(run.ctx.agentId);
    }
    for (const [id, reserva] of this.#reserved) {
      if (id === sessionId) continue;
      if (reserva.projectId === projectId) ocupadas.push(reserva.agentId);
    }

    if (ocupadas.length >= politica.maxConcurrency) {
      throw new HubError(
        'CONCURRENCY_EXCEEDED',
        `Limite de ${politica.maxConcurrency} sessões simultâneas deste projeto atingido (config do projeto)`,
        { projectId, active: ocupadas.length, limit: politica.maxConcurrency },
      );
    }
    const doAgente = ocupadas.filter((a) => a === agentId).length;
    if (doAgente >= politica.maxConcurrencyPerAgent) {
      throw new HubError(
        'CONCURRENCY_EXCEEDED',
        `Limite de ${politica.maxConcurrencyPerAgent} sessões simultâneas para "${agentId}" neste projeto atingido (config do projeto)`,
        { projectId, agentId, active: doAgente },
      );
    }
  }

  /**
   * Checa o teto E reserva a vaga, na mesma chamada síncrona — o coração da
   * correção do TOCTOU. Quem chama esta função é responsável por liberar a
   * reserva (`#releaseSlot`) em TODO caminho de saída que não termine com a
   * sessão registrada em `#runs`, tipicamente com `try { ... } finally { this.#releaseSlot(sessionId); }`
   * envolvendo tudo até (e inclusive) o `await this.#launch(...)`.
   */
  #reserveSlot(sessionId: string, agentId: string, projectId?: string): void {
    this.#assertConcurrency(agentId, sessionId, projectId);
    this.#reserved.set(sessionId, { agentId, projectId: projectId ?? null });
  }

  /** Libera uma reserva de concorrência. Idempotente: chave ausente é no-op. */
  #releaseSlot(sessionId: string): void {
    this.#reserved.delete(sessionId);
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

  /**
   * Emite `budget.warning` na transição false→true da pressão de alerta.
   *
   * Nível, não borda, dispararia a cada evento de custo depois de cruzar o
   * limiar — por isso o `#warned` guarda quem já foi avisado desde a última
   * vez que o teto mudou (`raiseLimits`) ou o fluxo terminou.
   */
  #checkBudgetWarning(session: Session, taskId: string | null, snapshot: BudgetSnapshot): void {
    if (!snapshot.isWarning || snapshot.exhausted) return;
    if (this.#warned.has(session.rootId)) return;
    this.#warned.add(session.rootId);

    this.#emit({
      sessionId: session.id,
      taskId,
      agentId: session.agentId,
      type: 'budget.warning',
      payload: { snapshot },
    });
  }

  /**
   * Para o fluxo por orçamento: evento `budget.exceeded` + UMA aprovação.
   *
   * Se já existe aprovação de orçamento pendente para a sessão, não abre
   * outra — antes cada linha de custo depois do estouro (e cada `send`)
   * empilhava aprovações obsoletas em `hub approvals`.
   *
   * O motivo diz QUAL dimensão estourou: a mensagem citava sempre dólares,
   * inclusive quando o teto batido era de tokens ("US$ 0.0000 de 5.00").
   */
  #abrirEstouroDeOrcamento(
    session: Session,
    task: Task,
    snapshot: BudgetSnapshot,
    turnoConcluido: boolean,
  ): void {
    const jaPendente = this.store.approvals
      .listPending({ sessionId: session.id })
      .some((a) => a.detail['kind'] === 'budget');
    if (jaPendente) return;

    this.#emit({
      sessionId: session.id,
      taskId: task.id,
      agentId: session.agentId,
      type: 'budget.exceeded',
      payload: { snapshot },
    });

    const { consumed, limits, remaining } = snapshot;
    const estouradas: string[] = [];
    if (consumed.usd >= limits.usd || remaining.usd < 0) {
      estouradas.push(`US$ ${consumed.usd.toFixed(4)} de ${limits.usd.toFixed(2)}`);
    }
    if (consumed.tokens >= limits.tokens || remaining.tokens < 0) {
      estouradas.push(`${consumed.tokens} de ${limits.tokens} tokens`);
    }
    if (consumed.seconds >= limits.seconds || remaining.seconds < 0) {
      estouradas.push(`${Math.round(consumed.seconds)}s de ${limits.seconds}s de tempo`);
    }

    // Estouro é decisão humana por definição (ADR 03).
    this.#requestApproval({
      session,
      taskId: task.id,
      risk: 'budget',
      action: `orçamento do fluxo esgotado (${estouradas.join('; ') || `US$ ${consumed.usd.toFixed(4)} de ${limits.usd.toFixed(2)}`})`,
      detail: {
        kind: 'budget',
        consumed,
        limits,
        // Aprovar libera outra rodada do mesmo tamanho: é previsível e
        // evita que um "ok" vire orçamento ilimitado.
        increment: limits,
        // O turno já tinha acabado quando o teto estourou: aprovar só
        // finaliza a tarefa, não relança o agente.
        turnCompleted: turnoConcluido,
      },
    });
  }

  /**
   * Teto de tempo de parede da run, pelo saldo em segundos do fluxo.
   *
   * Os segundos só entram no ledger em `settle` (fim da run), então sem este
   * relógio o teto em segundos nunca parava nada. Estourado, segue o mesmo
   * caminho do estouro em dólares/tokens: aprovação e processo encerrado —
   * aprovar amplia o teto e retoma, porque aqui o Hub cortou o agente no meio.
   */
  #armarTetoDeTempo(
    session: Session,
    task: Task,
    handle: RunHandle,
    ledger: BudgetLedger,
    reivindicar: () => boolean,
  ): ReturnType<typeof setTimeout> | undefined {
    const inicial = ledger.snapshot();
    // Saldo de tempo do FLUXO (teto − consumido), sem descontar reservas: a
    // fatia reservada de um filho é justamente o tempo que ele pode gastar.
    const restanteMs = Math.max(0, inicial.limits.seconds - inicial.consumed.seconds) * 1000;
    // Acima do máximo do `setTimeout` (~24,8 dias) o Node dispara na hora.
    if (!Number.isFinite(restanteMs) || restanteMs > 2_000_000_000) return undefined;
    const inicio = Date.now();

    const timer = setTimeout(() => {
      if (this.#runs.get(session.id)?.handle !== handle) return;
      if (!reivindicar()) return;

      const atual = ledger.snapshot();
      const decorrido = (Date.now() - inicio) / 1000;
      const consumed = { ...atual.consumed, seconds: Math.round(atual.consumed.seconds + decorrido) };
      const snapshot: BudgetSnapshot = {
        ...atual,
        consumed,
        remaining: { ...atual.remaining, seconds: atual.limits.seconds - consumed.seconds },
        exhausted: true,
      };
      this.#abrirEstouroDeOrcamento(session, task, snapshot, false);
      void this.registry
        .get(session.agentId)
        .cancel(handle)
        .catch(() => undefined);
    }, restanteMs);
    timer.unref?.();
    return timer;
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
   * Como `#latestTask`, mas para quem não pode lançar.
   *
   * O gate pré-execução é o caso: o hook pode chegar antes de a primeira task
   * existir (o agente já subiu e já quer rodar algo), e ali lançar
   * `TASK_NOT_FOUND` transformaria uma aprovação legítima num erro de hook —
   * que, dependendo do agente, **libera a ferramenta**. A aprovação sem task
   * é menos informativa e continua barrando, que é o que importa.
   */
  #latestTaskOrNull(sessionId: string): Task | null {
    const [task] = this.store.tasks.list({ sessionId });
    return task ?? null;
  }

  /**
   * Política efetiva de uma sessão. Lógica em `effective-policy.ts`
   * (pai→filho e projeto→global) — aqui só a ligação com `store`/`config`.
   */
  policyFor(session: Session, visited = new Set<string>()): PolicyEngine {
    return resolvePolicyFor({ store: this.store, globalPolicy: this.config.policy }, session, visited);
  }

  #projectPolicy(projectId: string): PolicyDocument {
    return projectPolicyFor({ store: this.store, globalPolicy: this.config.policy }, projectId);
  }

  briefOf(sessionId: string): Brief {
    return this.#latestTask(sessionId).brief;
  }
}

/**
 * Sessão adotada (`adoptExternal`): nó de controle de um agente que roda FORA
 * do Hub, sem run própria. Reconhecida pelo `path` que a adoção grava.
 */
export function sessaoAdotada(session: Session): boolean {
  return (
    session.parentId === null &&
    session.path.length === 1 &&
    session.path[0] === pathKey(session.agentId, `external:${session.agentId}`)
  );
}

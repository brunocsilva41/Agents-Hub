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
  sleep,
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
  saveProjectContext,
  type ProjectContext,
} from './project-config.js';
import { captureBaseline, captureDiff, loadBaseline, saveBaseline } from './diff-capture.js';
import { capturarMudancas } from './artifact-capture.js';
import { interpretarRevisao } from './review-verdict.js';
import { actionsOfToolCall, combineVerdicts, resumoDaChamada } from './pretool-gate.js';

/** Ver `SessionManager.gateWaitMs` — o porquê deste número mora lá. */
const ESPERA_PADRAO_DO_GATE_MS = 60_000;
import { runValidation } from './validation.js';
import type { WorktreeManager } from './worktree.js';
import { ProjectRegistry } from './project-registry.js';
import { policyFor as resolvePolicyFor, projectPolicyFor } from './effective-policy.js';

/** Quebra de linha literal para montar prompt sem brigar com escapes. */
const NEWLINE_PROMPT = String.fromCharCode(10);

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
  readonly #reserved = new Map<string, string>();
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
   * Pumps em andamento. Cada um escreve no banco até drenar, então o
   * desligamento precisa esperá-los antes de `store.close()`.
   */
  readonly #pumps = new Set<Promise<void>>();

  /**
   * Teto da espera do gate pré-execução por uma decisão humana.
   *
   * Existe porque o hook do agente tem timeout próprio e **mais curto**:
   * esperar além dele não ganha nada — o agente já desistiu do nosso lado da
   * conversa — e deixa a sessão presa em `waiting_approval` por uma resposta
   * que não vai mais ser lida. 60s é o timeout padrão de hook do Claude Code,
   * que é o único agente com o gate ligado hoje.
   *
   * Público e mutável de propósito: é o único jeito de um teste exercitar o
   * caminho de timeout sem esperar um minuto. Ainda não é campo de config
   * porque não existe caso de uso real para afrouxá-lo — quem precisa de mais
   * tempo precisa, na verdade, de um modo de supervisão diferente.
   */
  gateWaitMs = ESPERA_PADRAO_DO_GATE_MS;

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
    return contextForAgent(loadProjectContext(project.path).ctx, session.agentId);
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
    return envForAgent(loadProjectContext(project.path).ctx, session.agentId);
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

  /** Memória e prompts do projeto, como estão no arquivo. */
  getProjectContext(projectId: string): ProjectContext {
    return this.#projects.getContext(projectId);
  }

  /** Grava memória e prompts, preservando o bloco de política do arquivo. */
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

    const agentId = this.registry.resolveTarget(brief.agent, this.config.policy.fallback);
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
    this.#reserveSlot(sessionId, agentId);

    try {
      // --- grafo: profundidade e ciclo (ADR 03) -----------------------------
      const graph = parent
        ? checkDelegation({
            parentPath: parent.path,
            parentDepth: parent.depth,
            maxDepth: this.config.policy.maxDepth,
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
    this.bus.registerSession(sessionId, rootId);

    this.#avisarConfigDoProjetoQuebrada(session, taskId, project.path);
    this.#avisarDependenciasNaoLigadas(session, taskId, worktree.dependencyWarnings);

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
      this.store.transaction(() => {
        this.store.sessions.update(sessao.id, {
          state: 'killed',
          endedAt: sessao.endedAt ?? nowIso(),
          pid: null,
        });

        // A task fica em `failed` para o pipeline não achar que ainda há trabalho.
        for (const task of this.store.tasks.list({ sessionId: sessao.id })) {
          if (!isTerminalTaskState(task.state)) {
            this.store.tasks.update(task.id, { state: 'failed' });
          }
        }
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

      if (bin === null || !imagemPareceEsperada(imagem, bin)) {
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
      const v = engine.decide(action, { workdir: session.workdir, mode: session.mode });
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
    // Cancelar o que já acabou reescrevia o desfecho: uma sessão `completed`
    // virava `killed` na auditoria, com `{ok:true}` de resposta.
    //
    // Na recursão pela subárvore, filho já terminado é normal e não é erro —
    // por isso o `visited` guarda só a raiz da chamada do usuário.
    if (isTerminalSessionState(session.state)) {
      if (visited.size === 1) this.#exigirNaoTerminal(session, 'cancelar');
      return;
    }
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
    // Sem esta checagem, pausar uma sessão `completed` a devolvia para
    // `paused` — e uma sessão pausada aceita resume, então uma conversa
    // encerrada com sucesso voltava a rodar.
    this.#exigirNaoTerminal(this.#session(sessionId), 'pausar');
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

    // Mesma correção de `start()`/`#retry()`/`#fallback()`: checa e reserva
    // numa única operação síncrona, antes de qualquer `await` desta função.
    this.#reserveSlot(sessionId, resolvedTarget);

    try {
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
    } finally {
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
    const sessions = [...this.#runs.keys()];
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

  async #launch(
    session: Session,
    task: Task,
    prompt: string,
    nativeSessionId: string | null,
  ): Promise<void> {
    const adapter = this.registry.get(session.agentId);
    const manifest = adapter.manifest;
    const gate = this.#codexGate(session.agentId, session.mode);

    const ctx: RunContext = {
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

    const handle = nativeSessionId
      ? await adapter.resume(ctx, nativeSessionId, prompt)
      : await adapter.start(ctx, prompt);

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
  #codexGate(agentId: string, mode: SessionMode): { extraArgs: string[]; aviso?: string } {
    if (agentId !== 'codex') return { extraArgs: [] };

    const comando = `${segmentoDeComando(process.execPath)} ${segmentoDeComando(cliHookEntrypoint())} hook --dialect codex`;
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
          this.#checkBudgetWarning(session, task.id, snapshot);

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

    // Checa o teto e já reserva a vaga na mesma operação síncrona — mesma
    // correção de `start()`. Sem isto, duas tentativas de retry concorrentes
    // (ex: dois filhos do mesmo fluxo falhando ao mesmo tempo) liam o mesmo
    // `#runs` antes de qualquer uma registrar a sua.
    try {
      this.#reserveSlot(session.id, agentId);
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
      this.#reserveSlot(sessionId, agentId);
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
      this.#avisarConfigDoProjetoQuebrada(replacement, task.id, project.path);
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
  /**
   * Vigilância reativa. Decisão em `avaliarVigilancia`
   * (`packages/adapters/src/guarded-actions.ts`) — aqui só os efeitos
   * (emitir alerta, abrir aprovação), que dependem de `store`/`bus`.
   */
  #watch(session: Session, task: Task, mapped: MappedEvent): 'ok' | 'flagged' | 'paused' {
    const engine = this.policyFor(session);
    const watch = watchForMode(this.config.policy.watch, session.mode);
    const veredito = avaliarVigilancia(mapped, session.workdir, session.mode, engine, watch);

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

  /**
   * Avisa na timeline quando o YAML de projeto está quebrado.
   *
   * `loadProjectOverrides`/`loadProjectContext` já caem na política global e já
   * `console.error` no log do daemon — mas isso não aparece pra quem só olha o
   * painel da sessão, exatamente onde a política "deveria" estar mais apertada
   * e não está. Chamado uma vez no nascimento da sessão, não a cada gate.
   */
  #avisarConfigDoProjetoQuebrada(session: Session, taskId: string, projectPath: string): void {
    const overrides = loadProjectOverrides(projectPath);
    const contexto = loadProjectContext(projectPath);
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
      const gate = this.#codexGate(revisorId, session.mode);
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
          const snapshot = this.#ledger(session.rootId).charge({
            usd: evento.cost.usd ?? 0,
            tokens: (evento.cost.inputTokens ?? 0) + (evento.cost.outputTokens ?? 0),
            seconds: 0,
          });
          this.#checkBudgetWarning(session, task.id, snapshot);
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

  /** Registra o que a sessão mudou no código. Lógica em `artifact-capture.ts`. */
  async #capturarMudancas(session: Session, task: Task): Promise<string[]> {
    return capturarMudancas(
      { store: this.store, artifactRoot: this.config.artifactRoot, emit: (draft) => this.#emit(draft) },
      session,
      task,
    );
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
  #assertConcurrency(agentId: string): void {
    const total = this.#runs.size + this.#reserved.size;
    if (total >= this.config.policy.maxConcurrency) {
      throw new HubError(
        'CONCURRENCY_EXCEEDED',
        `Limite de ${this.config.policy.maxConcurrency} sessões simultâneas atingido`,
        { active: total, limit: this.config.policy.maxConcurrency },
      );
    }

    const perAgent =
      [...this.#runs.values()].filter((r) => r.ctx.agentId === agentId).length +
      [...this.#reserved.values()].filter((a) => a === agentId).length;
    if (perAgent >= this.config.policy.maxConcurrencyPerAgent) {
      throw new HubError(
        'CONCURRENCY_EXCEEDED',
        `Limite de ${this.config.policy.maxConcurrencyPerAgent} sessões simultâneas para "${agentId}" atingido`,
        { agentId, active: perAgent },
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
  #reserveSlot(sessionId: string, agentId: string): void {
    this.#assertConcurrency(agentId);
    this.#reserved.set(sessionId, agentId);
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


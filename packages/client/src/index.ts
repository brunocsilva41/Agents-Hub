import type {
  AgentDiscovery,
  EventEnvelope,
  ImportKind,
  ImportResult,
} from '@agents-hub/core';
import type {
  AgentSummary,
  ApprovalSummary,
  ArtifactSummary,
  BudgetSummary,
  GraphSummary,
  HealthSummary,
  ProbeSummary,
  ProjectContextDto,
  RepoConfigStatusDto,
  ProjectFolder,
  ProjectSummary,
  SessionSummary,
  TaskSummary,
  WorkflowRunSummary,
  WorkflowValidationSummary,
} from './types.js';
import { idSegment } from './ids.js';
import type {
  AuditEntrySummary,
  AuditQuery,
  PolicyDoc,
  PolicySummary,
  ProjectPolicySummary,
} from './policy-types.js';

export * from './types.js';
export * from './ids.js';
export * from './policy-types.js';

/**
 * Como o cliente se autentica nas rotas de operador (item 1.6).
 *
 * - CLI/scripts Node: `token` lido de `<AGENTS_HUB_HOME>/operator-token` (use
 *   `readOperatorToken` de `@agents-hub/client/operator-token`). Pode ser uma
 *   função: o daemon pode nascer DEPOIS de o cliente ser criado (autostart).
 * - Navegador servido pelo daemon: sem `token` — o cookie HttpOnly vai sozinho
 *   em toda requisição de mesma origem.
 * - MCP server e hook do agente: sem token, de propósito. Nada que roda como
 *   filho de agente pode aprovar, afrouxar política ou derrubar o daemon.
 */
export interface HubClientOptions {
  token?: string | null | (() => string | null | undefined);
}

export interface BriefInput {
  agent: string;
  objective: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  artifacts?: Array<{ path: string; mode?: 'read' | 'write'; note?: string }>;
  contextRefs?: string[];
  /** Fan-in de workflow: o que os passos dos quais este depende entregaram. */
  upstream?: Array<{ step: string; agent: string; summary: string; sessionRef?: string }>;
  budget?: { usd?: number; tokens?: number; seconds?: number };
  isolation?: 'none' | 'worktree' | 'container';
  supervision?: 'supervised' | 'semi' | 'autonomous';
  labels?: Record<string, string>;
}

export interface DelegationResult {
  taskId: string;
  sessionId: string;
  agentId: string;
  state: string;
  budget: BudgetSummary;
  /** Não-nulo quando a política reteve a delegação aguardando decisão humana. */
  approval: ApprovalSummary | null;
}

export interface TaskStatus {
  task: TaskSummary;
  session: SessionSummary;
  live: boolean;
  budget: BudgetSummary;
  /** Aprovação que está segurando a task, quando há uma. */
  approval?: ApprovalSummary | null;
}

/**
 * Cliente da API do daemon.
 *
 * Único ponto de contato com o Hub para CLI, MCP server e Web UI — os três
 * consomem exatamente as mesmas rotas, o que garante por construção que
 * nenhuma superfície tenha um poder que as outras não têm (ADR 01.2).
 *
 * Todo id que entra num caminho passa por `idSegment` (ver `ids.ts`): formato
 * validado e segmento codificado. Os métodos que fazem isso são `async` de
 * propósito — id inválido vira promessa rejeitada, não exceção síncrona que
 * escaparia de um `.catch()` encadeado por quem chama.
 */
export class HubClient {
  readonly base: string;
  readonly #token: HubClientOptions['token'];

  constructor(base: string, options: HubClientOptions = {}) {
    this.base = base.replace(/\/$/, '');
    this.#token = options.token;
  }

  /** Cabeçalho de autenticação, quando há token. */
  #auth(): Record<string, string> {
    const t = typeof this.#token === 'function' ? this.#token() : this.#token;
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  // ------------------------------------------------------------------ estado
  health(): Promise<HealthSummary> {
    return this.#get('/health');
  }

  agents(): Promise<{ agents: AgentSummary[] }> {
    return this.#get('/agents');
  }

  probeAgents(): Promise<{ probes: ProbeSummary[] }> {
    return this.#post('/agents/probe', {});
  }

  // ---------------------------------------------------------------- projetos
  projects(): Promise<{ projects: ProjectSummary[] }> {
    return this.#get('/projects');
  }

  addProject(path: string, name?: string): Promise<{ project: ProjectSummary }> {
    return this.#post('/projects', { path, name });
  }

  // ------------------------------------------------- descoberta e absorção
  /** O que cada CLI já tem (só leitura, sem segredo). Cache de 30s no daemon. */
  discovery(refresh = false): Promise<{ agents: AgentDiscovery[] }> {
    return this.#get(`/discovery${refresh ? '?refresh=1' : ''}`);
  }

  discoverAgent(agentId: string, refresh = false): Promise<{ agent: AgentDiscovery }> {
    return this.#get(
      `/discovery/${encodeURIComponent(agentId)}${refresh ? '?refresh=1' : ''}`,
    );
  }

  /** `dryRun` é verdadeiro por padrão no daemon: só grava com `dryRun: false`. */
  async importFromAgent(
    projectId: string,
    body: {
      agentId: string;
      kinds: ImportKind[];
      dryRun?: boolean;
      targetAgents?: string[];
      overwrite?: boolean;
      includeEnv?: boolean;
    },
  ): Promise<ImportResult> {
    return this.#post(`/projects/${idSegment(projectId, 'prj')}/import`, body);
  }

  /** Marca/desmarca o projeto como confiável (libera `validation.command` do repo). */
  async setProjectTrusted(
    projectId: string,
    trusted: boolean,
  ): Promise<{ project: ProjectSummary; repo?: RepoConfigStatusDto }> {
    return this.#post(`/projects/${idSegment(projectId, 'prj')}/trust`, { trusted });
  }

  // ----------------------------------------------------------------- sessões
  sessions(filter: { projectId?: string; rootId?: string } = {}): Promise<{
    sessions: SessionSummary[];
  }> {
    return this.#get(`/sessions${queryOf(filter)}`);
  }

  async session(id: string): Promise<{ session: SessionSummary; live: boolean }> {
    return this.#get(`/sessions/${idSegment(id, 'ses')}`);
  }

  /**
   * `baseSessionIds`: o worktree da sessão nova parte do trabalho dessas
   * sessões (branch `hub/<id>`), em vez do HEAD do projeto.
   */
  startSession(body: {
    projectId: string;
    brief: BriefInput;
    title?: string;
    baseSessionIds?: string[];
  }): Promise<{
    session: SessionSummary;
    task: TaskSummary;
    budget: BudgetSummary;
  }> {
    return this.#post('/sessions', body);
  }

  /** Registra um agente externo como sessão-raiz para poder delegar. */
  adopt(body: {
    agentId: string;
    projectPath?: string;
    projectId?: string;
    title?: string;
    budget?: { usd?: number; tokens?: number; seconds?: number };
  }): Promise<{ session: SessionSummary }> {
    return this.#post('/sessions/adopt', body);
  }

  async detach(sessionId: string): Promise<{ ok: boolean }> {
    return this.#post(`/sessions/${idSegment(sessionId, 'ses')}/detach`, {});
  }

  /**
   * Sinal de vida de uma raiz adotada. Sem ele, o daemon encerra a raiz depois
   * do prazo (`leaseMs`) — é o que impede raiz `running` eterna quando o MCP
   * server morre sem fechar stdin.
   */
  async heartbeat(sessionId: string): Promise<{ ok: boolean; leaseMs: number | null }> {
    return this.#post(`/sessions/${idSegment(sessionId, 'ses')}/heartbeat`, {});
  }

  async delegate(sessionId: string, brief: BriefInput): Promise<DelegationResult> {
    return this.#post(`/sessions/${idSegment(sessionId, 'ses')}/delegate`, { brief });
  }

  async send(sessionId: string, text: string): Promise<{ mode: 'live' | 'resume' | 'replay' }> {
    return this.#post(`/sessions/${idSegment(sessionId, 'ses')}/send`, { text });
  }

  /**
   * `interrupted: false`: a sessão existe, mas não havia turno em andamento.
   * `state`: estado depois da interrupção (`idle` quando parou um turno).
   */
  async interrupt(
    sessionId: string,
  ): Promise<{ ok: boolean; interrupted?: boolean; state?: string }> {
    return this.#post(`/sessions/${idSegment(sessionId, 'ses')}/interrupt`, {});
  }

  async pause(sessionId: string): Promise<{ ok: boolean; state?: string }> {
    return this.#post(`/sessions/${idSegment(sessionId, 'ses')}/pause`, {});
  }

  async cancel(sessionId: string, reason?: string): Promise<{ ok: boolean }> {
    return this.#post(`/sessions/${idSegment(sessionId, 'ses')}/cancel`, { reason });
  }

  async handoff(
    sessionId: string,
    agentId: string,
    reason?: string,
  ): Promise<{ ok: boolean; session: SessionSummary }> {
    return this.#post(`/sessions/${idSegment(sessionId, 'ses')}/handoff`, { agentId, reason });
  }

  // ------------------------------------------------------------------- tasks
  async task(taskId: string): Promise<TaskStatus> {
    return this.#get(`/tasks/${idSegment(taskId, 'tsk')}`);
  }

  /** O que a sessão mudou no código, em patch unificado. */
  async diff(sessionId: string): Promise<{ diff: string | null; path?: string; message?: string }> {
    return this.#get(`/sessions/${idSegment(sessionId, 'ses')}/diff`);
  }

  async artifacts(sessionId: string): Promise<{ artifacts: ArtifactSummary[] }> {
    return this.#get(`/sessions/${idSegment(sessionId, 'ses')}/artifacts`);
  }

  async tasks(sessionId: string): Promise<{ tasks: TaskSummary[] }> {
    return this.#get(`/sessions/${idSegment(sessionId, 'ses')}/tasks`);
  }

  // -------------------------------------------------------------- aprovações
  approvals(sessionId?: string): Promise<{ approvals: ApprovalSummary[] }> {
    return this.#get(`/approvals${queryOf({ sessionId })}`);
  }

  async approval(id: string): Promise<{ approval: ApprovalSummary }> {
    return this.#get(`/approvals/${idSegment(id, 'apv')}`);
  }

  /**
   * Exige token de operador. Quem decidiu (`by`) é derivado pelo daemon da
   * origem autenticada (`cli:<usuário>` ou `web`) — não há como declarar.
   */
  async resolveApproval(
    id: string,
    decision: 'approved' | 'denied',
  ): Promise<{ approval: ApprovalSummary }> {
    return this.#post(`/approvals/${idSegment(id, 'apv')}`, { decision });
  }

  // ------------------------------------------------ política e auditoria
  /**
   * Camadas de política e o resultado efetivo. Com `projectId`, inclui a
   * camada do projeto, o que o clamp anulou e os campos de execução ignorados.
   */
  async policy(projectId?: string): Promise<{ policy: PolicySummary }> {
    return this.#get(
      `/policy${projectId === undefined ? '' : `?projectId=${idSegment(projectId, 'prj')}`}`,
    );
  }

  /**
   * Substitui a camada GLOBAL (`config.json`). Exige token. `loosened` lista
   * os campos em que a nova política é mais permissiva que a anterior.
   */
  setGlobalPolicy(layer: PolicyDoc): Promise<{
    policy: PolicySummary;
    loosened: string[];
    backup: string | null;
  }> {
    return this.#send('PUT', '/policy', { policy: layer });
  }

  /**
   * Substitui a camada do PROJETO (`.agents-hub/config.yaml`). Exige token.
   * O projeto só aperta: `clamped` lista o que não vale por afrouxar a global.
   */
  async setProjectPolicy(
    projectId: string,
    layer: PolicyDoc,
  ): Promise<{ project: ProjectPolicySummary; clamped: string[]; ignoredExecFields: string[] }> {
    return this.#send('PUT', `/projects/${idSegment(projectId, 'prj')}/policy`, { policy: layer });
  }

  /** Trilha de auditoria, mais recente primeiro. */
  async audit(query: AuditQuery = {}): Promise<{ entries: AuditEntrySummary[] }> {
    const { sessionId, projectId, ...resto } = query;
    return this.#get(
      `/audit${queryOf({
        ...resto,
        sessionId: sessionId === undefined ? undefined : idSegment(sessionId, 'ses'),
        projectId: projectId === undefined ? undefined : idSegment(projectId, 'prj'),
      })}`,
    );
  }

  // ------------------------------------------------- gate pré-execução
  /** Consultado pelo hook do agente ANTES de a ferramenta rodar. */
  gateToolCall(body: {
    sessionId?: string;
    nativeSessionId?: string;
    cwd?: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }): Promise<{
    permission: 'allow' | 'deny' | 'ask';
    decision: string;
    risk: string;
    reason: string;
    explanation: string;
    approvalId?: string | null;
    sessionId: string | null;
    agentId: string | null;
  }> {
    return this.#post('/hooks/pretooluse', body);
  }

  // ------------------------------------------------------------- manutenção
  shutdown(): Promise<{ ok: boolean }> {
    return this.#post('/shutdown', {});
  }

  sweep(): Promise<{
    sweep: {
      examined: number;
      removed: string[];
      retained: number;
      failed: Array<{ path: string; reason: string }>;
    };
  }> {
    return this.#post('/maintenance/sweep', {});
  }

  /** Backup consistente do banco (`VACUUM INTO`); `out` é caminho absoluto. */
  backup(out?: string): Promise<{ backup: { path: string; bytes: number; schemaVersion: number } }> {
    return this.#post('/maintenance/backup', out === undefined ? {} : { out });
  }

  // ------------------------------------------------------------ observação
  async events(
    sessionId: string,
    options: { since?: number; limit?: number; before?: number; tail?: boolean } = {},
  ): Promise<{ events: EventEnvelope[] }> {
    const { tail, ...rest } = options;
    return this.#get(
      `/sessions/${idSegment(sessionId, 'ses')}/events${queryOf({ ...rest, tail: tail ? 1 : undefined })}`,
    );
  }

  context(ref: string): Promise<{ ref: string; events: EventEnvelope[] }> {
    return this.#get(`/context?ref=${encodeURIComponent(ref)}`);
  }

  // ------------------------------------------------------------- projetos

  /** Pastas que compõem o projeto, principal primeiro. */
  async folders(projectId: string): Promise<{ folders: ProjectFolder[] }> {
    return this.#get(`/projects/${idSegment(projectId, 'prj')}/folders`);
  }

  async addFolder(
    projectId: string,
    folderPath: string,
    label?: string,
  ): Promise<{ folder: ProjectFolder }> {
    return this.#post(`/projects/${idSegment(projectId, 'prj')}/folders`, {
      path: folderPath,
      ...(label === undefined ? {} : { label }),
    });
  }

  async removeFolder(projectId: string, folderId: string): Promise<{ ok: true }> {
    return this.#send(
      'DELETE',
      `/projects/${idSegment(projectId, 'prj')}/folders/${idSegment(folderId, 'pfd')}`,
    );
  }

  /**
   * Memória, prompts e env por agente que o usuário configurou pelo Hub
   * (`context`), e o estado do `config.yaml` do repositório (`repo`).
   */
  async projectContext(
    projectId: string,
  ): Promise<{ context: ProjectContextDto; repo?: RepoConfigStatusDto }> {
    return this.#get(`/projects/${idSegment(projectId, 'prj')}/context`);
  }

  async saveProjectContext(
    projectId: string,
    context: ProjectContextDto,
  ): Promise<{ context: ProjectContextDto }> {
    return this.#send('PUT', `/projects/${idSegment(projectId, 'prj')}/context`, context);
  }

  async graph(rootId: string): Promise<{ graph: GraphSummary[] }> {
    return this.#get(`/graph/${idSegment(rootId, 'ses')}`);
  }

  async budget(rootId: string): Promise<{ budget: BudgetSummary }> {
    return this.#get(`/budget/${idSegment(rootId, 'ses')}`);
  }

  /**
   * Redefine o teto do fluxo (só na raiz). Exige token. Campos ausentes ficam
   * como estão; abaixo do já gasto + reservado é recusado.
   */
  async setBudget(
    rootId: string,
    limits: { usd?: number; tokens?: number; seconds?: number },
  ): Promise<{ budget: BudgetSummary }> {
    return this.#send('PUT', `/budget/${idSegment(rootId, 'ses')}`, { limits });
  }

  // --------------------------------------------------------------- workflows
  /** Valida o YAML de um workflow (sintaxe, dependências, ciclos). */
  validateWorkflow(yaml: string): Promise<WorkflowValidationSummary> {
    return this.#post('/workflows/validate', { yaml });
  }

  /** Dispara no daemon: o encadeamento não depende de quem chamou continuar ouvindo. */
  async startWorkflow(body: {
    yaml: string;
    projectId: string;
    budgetUsd?: number;
  }): Promise<{ run: WorkflowRunSummary }> {
    idSegment(body.projectId, 'prj');
    return this.#post('/workflows/runs', body);
  }

  workflowRuns(): Promise<{ runs: WorkflowRunSummary[] }> {
    return this.#get('/workflows/runs');
  }

  async workflowRun(id: string): Promise<{ run: WorkflowRunSummary }> {
    return this.#get(`/workflows/runs/${idSegment(id, 'wfr')}`);
  }

  /** URL do SSE — o navegador usa `EventSource`, o Node usa `stream()`. */
  streamUrl(filter: { sessionId?: string; rootId?: string; since?: number } = {}): string {
    return `${this.base}/events${queryOf(filter)}`;
  }

  /** Consome o SSE fora do navegador, entregando um evento por vez. */
  async *stream(
    filter: { sessionId?: string; rootId?: string; since?: number } = {},
    signal?: AbortSignal,
  ): AsyncGenerator<EventEnvelope> {
    const response = await fetch(this.streamUrl(filter), {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`falha ao abrir stream: HTTP ${response.status}`);
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          yield JSON.parse(dataLine.slice(6)) as EventEnvelope;
        } catch {
          // comentário de keep-alive ou frame parcial: ignorado de propósito
        }
      }
    }
  }

  async #get<T>(path: string): Promise<T> {
    return this.#handle(await fetch(`${this.base}${path}`, { headers: this.#auth() }));
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    return this.#handle(
      await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.#auth() },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Verbos que não são GET nem POST (hoje: DELETE e PUT). */
  async #send<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.#handle(
      await fetch(`${this.base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...this.#auth() },
        // Corpo ausente é diferente de corpo vazio: a guarda de borda só exige
        // `application/json` quando HÁ corpo.
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  async #handle<T>(response: Response): Promise<T> {
    const text = await response.text();

    // `JSON.parse` sem guarda estourava com um erro que não diz nada a quem
    // opera: "Unexpected token '<', \"<!doctype\"... is not valid JSON". Foi
    // exatamente o que aconteceu quando o proxy de desenvolvimento devolveu o
    // index.html no lugar da API — o sintoma apontava para o parser, e a causa
    // estava a três camadas de distância.
    let parsed: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new HubApiError(
          `o Hub respondeu algo que não é JSON (HTTP ${response.status}). ` +
            `Comece pelos primeiros caracteres da resposta: ${resumo(text)}`,
          'RESPOSTA_NAO_JSON',
          response.status,
        );
      }
    }

    if (!response.ok) {
      const error = parsed['error'] as
        | { code?: string; message?: string; details?: unknown }
        | undefined;
      throw new HubApiError(
        error?.message ?? text,
        error?.code ?? String(response.status),
        response.status,
        // O daemon MANDA `details` — com o caminho e a mensagem de cada campo
        // que falhou na validação — e o cliente descartava. A interface exibia
        // "Brief inválido" enquanto a resposta trazia "o objetivo precisa ser
        // descritivo". A informação útil chegava e morria aqui.
        error?.details,
      );
    }
    return parsed as T;
  }
}

/** Primeiros caracteres da resposta, em uma linha, para caber numa mensagem. */
function resumo(texto: string): string {
  const limpo = texto.replace(/\s+/g, ' ').trim();
  return limpo.length > 120 ? `${limpo.slice(0, 120)}…` : limpo;
}

/** Preserva o `code` do domínio para quem consome poder reagir a ele. */
export class HubApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** Detalhes estruturados do daemon — por campo, quando é erro de validação. */
  readonly details: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = 'HubApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function queryOf(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.size > 0 ? `?${query.toString()}` : '';
}

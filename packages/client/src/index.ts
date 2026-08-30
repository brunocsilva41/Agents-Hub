import type { EventEnvelope } from '@agents-hub/core';
import type {
  AgentSummary,
  ApprovalSummary,
  ArtifactSummary,
  BudgetSummary,
  GraphSummary,
  HealthSummary,
  ProbeSummary,
  ProjectContextDto,
  ProjectFolder,
  ProjectSummary,
  SessionSummary,
  TaskSummary,
} from './types.js';

export * from './types.js';

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
 */
export class HubClient {
  readonly base: string;

  constructor(base: string) {
    this.base = base.replace(/\/$/, '');
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

  // ----------------------------------------------------------------- sessões
  sessions(filter: { projectId?: string; rootId?: string } = {}): Promise<{
    sessions: SessionSummary[];
  }> {
    return this.#get(`/sessions${queryOf(filter)}`);
  }

  session(id: string): Promise<{ session: SessionSummary; live: boolean }> {
    return this.#get(`/sessions/${id}`);
  }

  startSession(body: { projectId: string; brief: BriefInput; title?: string }): Promise<{
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

  detach(sessionId: string): Promise<{ ok: boolean }> {
    return this.#post(`/sessions/${sessionId}/detach`, {});
  }

  delegate(sessionId: string, brief: BriefInput): Promise<DelegationResult> {
    return this.#post(`/sessions/${sessionId}/delegate`, { brief });
  }

  send(sessionId: string, text: string): Promise<{ mode: 'live' | 'resume' | 'replay' }> {
    return this.#post(`/sessions/${sessionId}/send`, { text });
  }

  interrupt(sessionId: string): Promise<{ ok: boolean }> {
    return this.#post(`/sessions/${sessionId}/interrupt`, {});
  }

  pause(sessionId: string): Promise<{ ok: boolean }> {
    return this.#post(`/sessions/${sessionId}/pause`, {});
  }

  cancel(sessionId: string, reason?: string): Promise<{ ok: boolean }> {
    return this.#post(`/sessions/${sessionId}/cancel`, { reason });
  }

  handoff(
    sessionId: string,
    agentId: string,
    reason?: string,
  ): Promise<{ ok: boolean; session: SessionSummary }> {
    return this.#post(`/sessions/${sessionId}/handoff`, { agentId, reason });
  }

  // ------------------------------------------------------------------- tasks
  task(taskId: string): Promise<TaskStatus> {
    return this.#get(`/tasks/${taskId}`);
  }

  /** O que a sessão mudou no código, em patch unificado. */
  diff(sessionId: string): Promise<{ diff: string | null; path?: string; message?: string }> {
    return this.#get(`/sessions/${sessionId}/diff`);
  }

  artifacts(sessionId: string): Promise<{ artifacts: ArtifactSummary[] }> {
    return this.#get(`/sessions/${sessionId}/artifacts`);
  }

  tasks(sessionId: string): Promise<{ tasks: TaskSummary[] }> {
    return this.#get(`/sessions/${sessionId}/tasks`);
  }

  // -------------------------------------------------------------- aprovações
  approvals(sessionId?: string): Promise<{ approvals: ApprovalSummary[] }> {
    return this.#get(`/approvals${queryOf({ sessionId })}`);
  }

  approval(id: string): Promise<{ approval: ApprovalSummary }> {
    return this.#get(`/approvals/${id}`);
  }

  resolveApproval(
    id: string,
    decision: 'approved' | 'denied',
    by?: string,
  ): Promise<{ approval: ApprovalSummary }> {
    return this.#post(`/approvals/${id}`, { decision, by });
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
    permission: 'allow' | 'deny' | 'escalate';
    decision: string;
    risk: string;
    reason: string;
    explanation: string;
    sessionId: string | null;
    agentId: string | null;
  }> {
    return this.#post('/hooks/pretooluse', body);
  }

  // ------------------------------------------------------------- manutenção
  shutdown(): Promise<{ ok: boolean }> {
    return this.#post('/shutdown', {});
  }

  sweep(): Promise<{ sweep: { examined: number; removed: string[]; kept: number } }> {
    return this.#post('/maintenance/sweep', {});
  }

  // ------------------------------------------------------------ observação
  events(
    sessionId: string,
    options: { since?: number; limit?: number } = {},
  ): Promise<{ events: EventEnvelope[] }> {
    return this.#get(`/sessions/${sessionId}/events${queryOf(options)}`);
  }

  context(ref: string): Promise<{ ref: string; events: EventEnvelope[] }> {
    return this.#get(`/context?ref=${encodeURIComponent(ref)}`);
  }

  // ------------------------------------------------------------- projetos

  /** Pastas que compõem o projeto, principal primeiro. */
  folders(projectId: string): Promise<{ folders: ProjectFolder[] }> {
    return this.#get(`/projects/${encodeURIComponent(projectId)}/folders`);
  }

  addFolder(
    projectId: string,
    folderPath: string,
    label?: string,
  ): Promise<{ folder: ProjectFolder }> {
    return this.#post(`/projects/${encodeURIComponent(projectId)}/folders`, {
      path: folderPath,
      ...(label === undefined ? {} : { label }),
    });
  }

  removeFolder(projectId: string, folderId: string): Promise<{ ok: true }> {
    return this.#send(
      'DELETE',
      `/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,
    );
  }

  /** Memória e prompts por agente do projeto. */
  projectContext(projectId: string): Promise<{ context: ProjectContextDto }> {
    return this.#get(`/projects/${encodeURIComponent(projectId)}/context`);
  }

  saveProjectContext(
    projectId: string,
    context: ProjectContextDto,
  ): Promise<{ context: ProjectContextDto }> {
    return this.#send('PUT', `/projects/${encodeURIComponent(projectId)}/context`, context);
  }

  graph(rootId: string): Promise<{ graph: GraphSummary[] }> {
    return this.#get(`/graph/${rootId}`);
  }

  budget(rootId: string): Promise<{ budget: BudgetSummary }> {
    return this.#get(`/budget/${rootId}`);
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
    return this.#handle(await fetch(`${this.base}${path}`));
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    return this.#handle(
      await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Verbos que não são GET nem POST (hoje: DELETE e PUT). */
  async #send<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.#handle(
      await fetch(`${this.base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
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

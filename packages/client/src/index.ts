import type { EventEnvelope } from '@agents-hub/core';
import type {
  AgentSummary,
  ApprovalSummary,
  BudgetSummary,
  GraphSummary,
  HealthSummary,
  ProbeSummary,
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

  // ------------------------------------------------------------------- tasks
  task(taskId: string): Promise<TaskStatus> {
    return this.#get(`/tasks/${taskId}`);
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

  async #handle<T>(response: Response): Promise<T> {
    const text = await response.text();
    const parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const error = parsed['error'] as { code?: string; message?: string } | undefined;
      throw new HubApiError(
        error?.message ?? text,
        error?.code ?? String(response.status),
        response.status,
      );
    }
    return parsed as T;
  }
}

/** Preserva o `code` do domínio para quem consome poder reagir a ele. */
export class HubApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'HubApiError';
    this.code = code;
    this.status = status;
  }
}

function queryOf(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.size > 0 ? `?${query.toString()}` : '';
}

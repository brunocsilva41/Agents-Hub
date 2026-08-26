import type { EventEnvelope } from '@agents-hub/core';

/**
 * Cliente HTTP do daemon.
 *
 * A CLI é deliberadamente burra (ADR 01.2): tudo que ela sabe fazer está
 * exposto na API, então TUI e Web UI nascem com as mesmas capacidades sem
 * reimplementar nada.
 */
export class HubClient {
  constructor(private readonly base: string) {}

  async health(): Promise<Record<string, unknown>> {
    return this.#get('/health');
  }

  async agents(): Promise<{ agents: AgentSummary[] }> {
    return this.#get('/agents');
  }

  async probeAgents(): Promise<{ probes: ProbeSummary[] }> {
    return this.#post('/agents/probe', {});
  }

  async projects(): Promise<{ projects: ProjectSummary[] }> {
    return this.#get('/projects');
  }

  async addProject(path: string, name?: string): Promise<{ project: ProjectSummary }> {
    return this.#post('/projects', { path, name });
  }

  async sessions(filter: { projectId?: string; rootId?: string } = {}): Promise<{
    sessions: SessionSummary[];
  }> {
    const query = new URLSearchParams();
    if (filter.projectId) query.set('projectId', filter.projectId);
    if (filter.rootId) query.set('rootId', filter.rootId);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.#get(`/sessions${suffix}`);
  }

  async startSession(body: {
    projectId: string;
    brief: unknown;
    title?: string;
  }): Promise<{ session: SessionSummary; task: { id: string }; budget: unknown }> {
    return this.#post('/sessions', body);
  }

  async delegate(
    sessionId: string,
    brief: unknown,
  ): Promise<{ taskId: string; sessionId: string; agentId: string }> {
    return this.#post(`/sessions/${sessionId}/delegate`, { brief });
  }

  async send(sessionId: string, text: string): Promise<{ mode: string }> {
    return this.#post(`/sessions/${sessionId}/send`, { text });
  }

  async cancel(sessionId: string, reason?: string): Promise<unknown> {
    return this.#post(`/sessions/${sessionId}/cancel`, { reason });
  }

  async interrupt(sessionId: string): Promise<unknown> {
    return this.#post(`/sessions/${sessionId}/interrupt`, {});
  }

  async graph(rootId: string): Promise<{ graph: GraphSummary[] }> {
    return this.#get(`/graph/${rootId}`);
  }

  async budget(rootId: string): Promise<{ budget: BudgetSummary }> {
    return this.#get(`/budget/${rootId}`);
  }

  /** Consome o SSE do daemon, entregando um evento por vez. */
  async *stream(filter: { sessionId?: string; rootId?: string; since?: number }): AsyncGenerator<
    EventEnvelope
  > {
    const query = new URLSearchParams();
    if (filter.sessionId) query.set('sessionId', filter.sessionId);
    if (filter.rootId) query.set('rootId', filter.rootId);
    if (typeof filter.since === 'number') query.set('since', String(filter.since));

    const response = await fetch(`${this.base}/events?${query.toString()}`, {
      headers: { Accept: 'text/event-stream' },
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
          // frame parcial ou comentário: ignorado de propósito
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
      throw new Error(`${error?.code ?? response.status}: ${error?.message ?? text}`);
    }
    return parsed as T;
  }
}

export interface AgentSummary {
  id: string;
  name: string;
  vendor: string;
  capabilities: string[];
  sessionStrategy: string;
  streamFormat: string;
  caveats: string[];
  loginHint: string;
  probe: ProbeSummary | null;
}

export interface ProbeSummary {
  agentId: string;
  installed: boolean;
  version: string | null;
  binPath: string | null;
  error: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  rootId: string;
  parentId: string | null;
  depth: number;
  state: string;
  mode: string;
  title: string | null;
  workdir: string;
  createdAt: string;
}

export interface GraphSummary {
  sessionId: string;
  agentId: string;
  title: string | null;
  state: string;
  depth: number;
  usd: number;
  tokens: number;
  children: GraphSummary[];
}

export interface BudgetSummary {
  limits: { usd: number; tokens: number; seconds: number };
  consumed: { usd: number; tokens: number; seconds: number };
  remaining: { usd: number; tokens: number; seconds: number };
  pressure: number;
  exhausted: boolean;
}

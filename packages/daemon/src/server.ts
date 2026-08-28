import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isHubError, nowIso, type EventEnvelope } from '@agents-hub/core';
import type { AgentRegistry } from '@agents-hub/adapters';
import type { InMemoryEventBus } from './bus.js';
import type { HubConfig } from './config.js';
import { guardRequest } from './guard.js';
import type { WorktreeReaper } from './reaper.js';
import type { SessionManager } from './session-manager.js';
import { serveStatic } from './static.js';

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/**
 * API HTTP + SSE do daemon.
 *
 * CLI, TUI e Web UI consomem exatamente estas rotas (ADR 01.2): nenhuma lógica
 * mora no cliente, então os três têm a mesma capacidade por construção. O MCP
 * server e o A2A server da fase 2 são tradutores para cá, não caminhos
 * paralelos.
 */
export class HubServer {
  readonly #routes: Route[] = [];
  #server: Server | null = null;
  /** Preenchido pelo `createHub`: como derrubar o Hub inteiro, não só o HTTP. */
  onShutdown: (() => Promise<void>) | null = null;

  constructor(
    private readonly config: HubConfig,
    private readonly sessions: SessionManager,
    private readonly registry: AgentRegistry,
    private readonly bus: InMemoryEventBus,
    private readonly reaper: WorktreeReaper,
  ) {
    this.#registerRoutes();
  }

  listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.#dispatch(req, res));
      server.on('error', reject);
      server.listen(this.config.port, this.config.host, () => {
        this.#server = server;
        resolve({ host: this.config.host, port: this.config.port });
      });
    });
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#server = null;
  }

  #route(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:(\w+)/g, (_m, key: string) => {
        keys.push(key);
        return '([^/]+)';
      })}$`,
    );
    this.#routes.push({ method, pattern, keys, handler });
  }

  async #dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Guarda de borda ANTES de qualquer rota: o Hub roda agentes com todo o seu
    // privilégio, e sem isto qualquer página web que você visitar conseguiria
    // dirigi-lo. Ver `guard.ts`.
    const verdict = guardRequest(req, { host: this.config.host, port: this.config.port });
    if (!verdict.ok) {
      sendJson(res, verdict.status ?? 403, {
        error: { code: 'FORBIDDEN', message: verdict.reason ?? 'requisição recusada' },
      });
      return;
    }

    // `Vary: Origin` para nenhum proxy intermediário cachear a decisão da
    // guarda e servi-la para uma origem diferente.
    res.setHeader('Vary', 'Origin');

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    for (const route of this.#routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1] ?? '');
      });

      try {
        await route.handler(req, res, params);
      } catch (err) {
        sendError(res, err);
      }
      return;
    }

    // Nenhuma rota de API bateu: pode ser a Web UI.
    if (req.method === 'GET' && serveStatic(this.config.webRoot, url.pathname, res)) return;

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Rota ${url.pathname} não existe` } });
  }

  #registerRoutes(): void {
    // ------------------------------------------------------------- saúde
    this.#route('GET', '/health', (_req, res) => {
      sendJson(res, 200, {
        ok: true,
        version: '0.1.0',
        now: nowIso(),
        home: this.config.home,
        liveSessions: this.sessions.liveCount(),
        subscribers: this.bus.subscriberCount,
      });
    });

    // ------------------------------------------------------------- agentes
    this.#route('GET', '/agents', async (_req, res) => {
      const probes = await this.registry.probeAll();
      const byId = new Map(probes.map((p) => [p.agentId, p]));
      sendJson(res, 200, {
        agents: this.registry.manifests().map((manifest) => ({
          id: manifest.id,
          name: manifest.name,
          vendor: manifest.vendor,
          description: manifest.description,
          capabilities: manifest.capabilities,
          sessionStrategy: manifest.session.strategy,
          streamFormat: manifest.stream.format,
          caveats: manifest.caveats,
          loginHint: manifest.auth.loginHint,
          probe: byId.get(manifest.id) ?? null,
        })),
      });
    });

    this.#route('POST', '/agents/probe', async (_req, res) => {
      sendJson(res, 200, { probes: await this.registry.probeAll(true) });
    });

    // ------------------------------------------------------------- projetos
    this.#route('GET', '/projects', (_req, res) => {
      sendJson(res, 200, { projects: this.sessions.listProjects() });
    });

    this.#route('POST', '/projects', async (req, res) => {
      const body = await readJson<{ path: string; name?: string }>(req);
      sendJson(res, 201, { project: this.sessions.registerProject(body.path, body.name) });
    });

    // ------------------------------------------------------------- sessões
    this.#route('GET', '/sessions', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      sendJson(res, 200, {
        sessions: this.sessions.listSessions({
          projectId: url.searchParams.get('projectId') ?? undefined,
          rootId: url.searchParams.get('rootId') ?? undefined,
        }),
      });
    });

    this.#route('POST', '/sessions', async (req, res) => {
      const body = await readJson<{
        projectId: string;
        brief: unknown;
        requesterSessionId?: string | null;
        title?: string;
      }>(req);
      const result = await this.sessions.start({
        projectId: body.projectId,
        agentId: '',
        brief: body.brief,
        requesterSessionId: body.requesterSessionId ?? null,
        title: body.title,
      });
      sendJson(res, 201, result);
    });

    /**
     * Adoção: um agente rodando fora do Hub se apresenta como sessão-raiz.
     * Registrada antes de `/sessions/:id` para "adopt" não ser lido como id.
     */
    this.#route('POST', '/sessions/adopt', async (req, res) => {
      const body = await readJson<{
        agentId: string;
        projectPath?: string;
        projectId?: string;
        title?: string;
        budget?: { usd?: number; tokens?: number; seconds?: number };
      }>(req);

      const projectId =
        body.projectId ?? this.sessions.registerProject(body.projectPath ?? process.cwd()).id;

      sendJson(res, 201, {
        session: this.sessions.adoptExternal({
          agentId: body.agentId,
          projectId,
          title: body.title,
          budget: body.budget,
        }),
      });
    });

    this.#route('POST', '/sessions/:id/detach', async (_req, res, params) => {
      await this.sessions.detach(params['id'] ?? '');
      sendJson(res, 200, { ok: true });
    });

    this.#route('GET', '/sessions/:id/tasks', (_req, res, params) => {
      sendJson(res, 200, { tasks: this.sessions.listTasks(params['id'] ?? '') });
    });

    this.#route('GET', '/tasks/:id', (_req, res, params) => {
      const task = this.sessions.getTask(params['id'] ?? '');
      const session = this.sessions.getSession(task.sessionId);
      sendJson(res, 200, {
        task,
        session,
        live: this.sessions.isLive(task.sessionId),
        budget: this.sessions.budget(session.rootId),
      });
    });

    this.#route('GET', '/context', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const ref = url.searchParams.get('ref') ?? '';
      sendJson(res, 200, this.sessions.fetchContext(ref));
    });

    this.#route('GET', '/sessions/:id', (_req, res, params) => {
      const id = params['id'] ?? '';
      sendJson(res, 200, {
        session: this.sessions.getSession(id),
        live: this.sessions.isLive(id),
      });
    });

    this.#route('GET', '/sessions/:id/events', (req, res, params) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const since = url.searchParams.get('since');
      sendJson(res, 200, {
        events: this.sessions.listEvents(
          params['id'] ?? '',
          since === null ? undefined : Number(since),
          Number(url.searchParams.get('limit') ?? 500),
        ),
      });
    });

    this.#route('POST', '/sessions/:id/send', async (req, res, params) => {
      const body = await readJson<{ text: string }>(req);
      sendJson(res, 200, await this.sessions.send(params['id'] ?? '', body.text));
    });

    this.#route('POST', '/sessions/:id/interrupt', async (_req, res, params) => {
      await this.sessions.interrupt(params['id'] ?? '');
      sendJson(res, 200, { ok: true });
    });

    this.#route('POST', '/sessions/:id/pause', async (_req, res, params) => {
      await this.sessions.pause(params['id'] ?? '');
      sendJson(res, 200, { ok: true });
    });

    this.#route('POST', '/sessions/:id/cancel', async (req, res, params) => {
      const body = await readJson<{ reason?: string }>(req).catch(() => ({ reason: undefined }));
      await this.sessions.cancel(params['id'] ?? '', body.reason);
      sendJson(res, 200, { ok: true });
    });

    /**
     * Delegação: agente A pede a B. É a mesma rota de criar sessão, com o
     * chamador preenchido — o que ativa checagem de grafo, herança de modo e
     * reserva de orçamento a partir do saldo da raiz.
     */
    this.#route('POST', '/sessions/:id/delegate', async (req, res, params) => {
      const body = await readJson<{ brief: unknown; projectId?: string }>(req);
      const requester = this.sessions.getSession(params['id'] ?? '');
      const result = await this.sessions.start({
        projectId: body.projectId ?? requester.projectId,
        agentId: '',
        brief: body.brief,
        requesterSessionId: requester.id,
      });
      sendJson(res, 201, {
        taskId: result.task.id,
        sessionId: result.session.id,
        agentId: result.session.agentId,
        state: result.task.state,
        budget: result.budget,
        // Presente quando a política reteve a delegação: sem isto, quem chamou
        // acharia que a tarefa está rodando e ficaria em polling eterno.
        approval: result.approval ?? null,
      });
    });

    // ---------------------------------------------------------- aprovações
    this.#route('GET', '/approvals', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      sendJson(res, 200, {
        approvals: this.sessions.pendingApprovals(
          url.searchParams.get('sessionId') ?? undefined,
        ),
      });
    });

    this.#route('GET', '/approvals/:id', (_req, res, params) => {
      sendJson(res, 200, { approval: this.sessions.getApproval(params['id'] ?? '') });
    });

    this.#route('POST', '/approvals/:id', async (req, res, params) => {
      const body = await readJson<{ decision: 'approved' | 'denied'; by?: string }>(req);
      if (body.decision !== 'approved' && body.decision !== 'denied') {
        sendJson(res, 422, {
          error: { code: 'INVALID_BRIEF', message: 'decision deve ser "approved" ou "denied"' },
        });
        return;
      }
      sendJson(res, 200, {
        approval: await this.sessions.resolveApproval(
          params['id'] ?? '',
          body.decision,
          body.by ?? 'você',
        ),
      });
    });

    // --------------------------------------------------------- manutenção
    /**
     * Desligamento ordenado pelo cliente.
     *
     * Só existe porque o daemon agora sobe sozinho: se ele pode nascer sem você
     * pedir, precisa poder morrer sem você caçar o PID. Aceita só de localhost
     * — a mesma restrição de todas as outras rotas.
     */
    this.#route('POST', '/shutdown', (_req, res) => {
      sendJson(res, 200, { ok: true, message: 'encerrando' });
      // Responde ANTES de derrubar: quem pediu precisa saber que foi aceito.
      setTimeout(() => void this.onShutdown?.(), 100);
    });

    this.#route('POST', '/maintenance/sweep', async (_req, res) => {
      sendJson(res, 200, { sweep: await this.reaper.sweep() });
    });

    // ------------------------------------------------------------- grafo e custo
    this.#route('GET', '/graph/:rootId', (_req, res, params) => {
      sendJson(res, 200, { graph: this.sessions.graph(params['rootId'] ?? '') });
    });

    this.#route('GET', '/budget/:rootId', (_req, res, params) => {
      sendJson(res, 200, { budget: this.sessions.budget(params['rootId'] ?? '') });
    });

    // ------------------------------------------------------------- stream SSE
    this.#route('GET', '/events', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      const rootId = url.searchParams.get('rootId') ?? undefined;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`: conectado em ${nowIso()}\n\n`);

      // Replay do que já passou: quem conecta no meio de uma sessão longa
      // precisa ver o começo, senão a timeline chega truncada.
      const since = url.searchParams.get('since');
      if (sessionId) {
        for (const past of this.sessions.listEvents(
          sessionId,
          since === null ? undefined : Number(since),
        )) {
          writeSse(res, past, true);
        }
      }

      const singleSession = sessionId !== undefined;
      const unsubscribe = this.bus.subscribe({ sessionId, rootId }, (event) =>
        writeSse(res, event, singleSession),
      );

      // Proxies e antivírus derrubam conexão ociosa; o comentário periódico
      // mantém o canal vivo sem poluir o stream de eventos.
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);

      req.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
    });
  }
}

/**
 * Escreve um evento no stream SSE.
 *
 * DELIBERADAMENTE sem o campo `event:`. Nomear o evento com o tipo parece
 * elegante, mas faz o `onmessage` do navegador ignorar tudo que não se chame
 * literalmente "message" — o cliente receberia as falas do agente e perderia
 * `turn.completed`, `delegation.*` e `error` sem nenhum sinal de erro.
 * O tipo já viaja dentro do JSON, que é onde todo consumidor o lê.
 *
 * O `id:` só é enviado no stream de UMA sessão, porque `seq` é monotônico por
 * sessão: num stream multi-sessão ele seria ambíguo e estragaria o
 * `Last-Event-ID` na reconexão.
 */
function writeSse(res: ServerResponse, event: EventEnvelope, withId: boolean): void {
  const id = withId ? `id: ${event.seq}\n` : '';
  res.write(`${id}data: ${JSON.stringify(event)}\n\n`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (isHubError(err)) {
    sendJson(res, statusFor(err.code), { error: err.toJSON() });
    return;
  }
  sendJson(res, 500, {
    error: { code: 'INTERNAL', message: (err as Error).message ?? 'erro desconhecido' },
  });
}

function statusFor(code: string): number {
  switch (code) {
    case 'AGENT_NOT_FOUND':
    case 'SESSION_NOT_FOUND':
    case 'TASK_NOT_FOUND':
    case 'PROJECT_NOT_FOUND':
      return 404;
    case 'INVALID_BRIEF':
      return 422;
    case 'POLICY_DENIED':
      return 403;
    case 'APPROVAL_REQUIRED':
      return 428;
    case 'BUDGET_EXCEEDED':
    case 'DEPTH_EXCEEDED':
    case 'CYCLE_DETECTED':
    case 'CONCURRENCY_EXCEEDED':
      return 409;
    case 'TIMEOUT':
      return 504;
    case 'AGENT_NOT_INSTALLED':
    case 'AGENT_NOT_AUTHENTICATED':
    case 'CAPABILITY_UNRESOLVED':
      return 424;
    default:
      return 400;
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 5_000_000) throw new Error('corpo da requisição maior que 5 MB');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length === 0 ? ({} as T) : (JSON.parse(raw) as T);
}

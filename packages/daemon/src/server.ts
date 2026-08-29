import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HubError, isHubError, nowIso, type EventEnvelope } from '@agents-hub/core';
import type { ZodType } from 'zod';
import type { AgentRegistry } from '@agents-hub/adapters';
import type { InMemoryEventBus } from './bus.js';
import type { HubConfig } from './config.js';
import { guardRequest } from './guard.js';
import { explainToAgent, toHookPermission } from './pretool-gate.js';
import { generateAgentCard, formatA2aTask } from './a2a.js';
import {
  A2aCreateTaskSchema,
  AdoptSessionSchema,
  ApprovalIdSchema,
  CancelSchema,
  AddFolderSchema,
  CreateProjectSchema,
  DelegateSchema,
  HandoffSessionSchema,
  ResolveApprovalSchema,
  SendMessageSchema,
  ProjectIdSchema,
  SessionIdSchema,
  PreToolGateSchema,
  StartSessionSchema,
  TaskIdSchema,
  inteiroOpcional,
} from './http-schemas.js';
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

    // ------------------------------------------------------------- A2A Protocol
    const getBaseUrl = (req: IncomingMessage): string => {
      const host = req.headers.host ?? `${this.config.host}:${this.config.port}`;
      return `http://${host}`;
    };

    this.#route('GET', '/.well-known/agent-card.json', (req, res) => {
      sendJson(res, 200, generateAgentCard(this.config, this.registry, getBaseUrl(req)));
    });

    this.#route('GET', '/a2a/agent-card.json', (req, res) => {
      sendJson(res, 200, generateAgentCard(this.config, this.registry, getBaseUrl(req)));
    });

    this.#route('POST', '/a2a/tasks', async (req, res) => {
      const body = await readBody(req, A2aCreateTaskSchema);
      const projectId =
        body.projectId ??
        this.sessions.registerProject(body.projectPath ?? process.cwd()).id;

      const result = await this.sessions.start({
        projectId,
        agentId: body.agent ?? '',
        brief: {
          agent: body.agent ?? 'cap:code-edit',
          objective: body.objective,
          acceptanceCriteria: body.acceptanceCriteria ?? [],
          constraints: body.constraints ?? [],
          budget: body.budget ?? {},
          supervision: body.supervision ?? 'semi',
          isolation: body.isolation ?? 'worktree',
        },
        title: body.title,
      });

      sendJson(res, 201, {
        task: formatA2aTask(result.task, result.session.state),
        session: result.session,
        budget: result.budget,
        approval: result.approval ?? null,
      });
    });

    this.#route('GET', '/a2a/tasks/:id', (_req, res, params) => {
      const taskId = param(params['id'], TaskIdSchema, 'id');
      const task = this.sessions.getTask(taskId);
      const session = this.sessions.getSession(task.sessionId);
      sendJson(res, 200, {
        task: formatA2aTask(task, session.state),
      });
    });

    this.#route('POST', '/a2a/tasks/:id/cancel', async (_req, res, params) => {
      const taskId = param(params['id'], TaskIdSchema, 'id');
      const task = this.sessions.getTask(taskId);
      await this.sessions.cancel(task.sessionId, 'cancelado via A2A');
      const updatedTask = this.sessions.getTask(taskId);
      const session = this.sessions.getSession(task.sessionId);
      sendJson(res, 200, {
        task: formatA2aTask(updatedTask, session.state),
      });
    });

    this.#route('GET', '/a2a/tasks/:id/events', (req, res, params) => {
      const taskId = param(params['id'], TaskIdSchema, 'id');
      const task = this.sessions.getTask(taskId);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`: conectado ao stream A2A da task ${taskId}\n\n`);

      for (const event of this.sessions.listEvents(task.sessionId)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      const unsubscribe = this.bus.subscribe({ sessionId: task.sessionId }, (event: EventEnvelope) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      req.on('close', () => {
        unsubscribe();
      });
    });

    // ------------------------------------------------------------- projetos
    this.#route('GET', '/projects', (_req, res) => {
      sendJson(res, 200, { projects: this.sessions.listProjects() });
    });

    this.#route('POST', '/projects', async (req, res) => {
      const body = await readBody(req, CreateProjectSchema);
      sendJson(res, 201, { project: this.sessions.registerProject(body.path, body.name) });
    });

    // Pastas do projeto. Um projeto agrupa N pastas; a sessão roda em UMA
    // delas, e é isso que mantém o confinamento de acesso significando algo.
    this.#route('GET', '/projects/:id/folders', (_req, res, params) => {
      sendJson(res, 200, {
        folders: this.sessions.listProjectFolders(param(params['id'], ProjectIdSchema, 'id')),
      });
    });

    this.#route('POST', '/projects/:id/folders', async (req, res, params) => {
      const body = await readBody(req, AddFolderSchema);
      sendJson(res, 201, {
        folder: this.sessions.addProjectFolder(
          param(params['id'], ProjectIdSchema, 'id'),
          body.path,
          body.label,
        ),
      });
    });

    this.#route('DELETE', '/projects/:id/folders/:folderId', (_req, res, params) => {
      this.sessions.removeProjectFolder(
        param(params['id'], ProjectIdSchema, 'id'),
        params['folderId'] ?? '',
      );
      sendJson(res, 200, { ok: true });
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
      const body = await readBody(req, StartSessionSchema);
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
      const body = await readBody(req, AdoptSessionSchema);

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

    this.#route('GET', '/sessions/:id/artifacts', (_req, res, params) => {
      sendJson(res, 200, {
        artifacts: this.sessions.listArtifacts(param(params['id'], SessionIdSchema, 'id')),
      });
    });

    /** Conteúdo do diff — o que o agente efetivamente mudou no código. */
    this.#route('GET', '/sessions/:id/diff', (_req, res, params) => {
      const sessionId = param(params['id'], SessionIdSchema, 'id');
      const diff = this.sessions
        .listArtifacts(sessionId)
        .filter((a) => a.kind === 'diff')
        .at(-1);

      if (!diff) {
        sendJson(res, 200, { diff: null, message: 'esta sessão não alterou nenhum arquivo' });
        return;
      }

      try {
        sendJson(res, 200, { diff: readFileSync(diff.path, 'utf8'), path: diff.path });
      } catch {
        // O artefato pode ter sido apagado à mão; dizer isso é melhor que 500.
        sendJson(res, 200, {
          diff: null,
          message: `o arquivo do diff não está mais em ${diff.path}`,
        });
      }
    });

    this.#route('GET', '/sessions/:id/tasks', (_req, res, params) => {
      sendJson(res, 200, { tasks: this.sessions.listTasks(params['id'] ?? '') });
    });

    this.#route('GET', '/tasks/:id', (_req, res, params) => {
      const task = this.sessions.getTask(param(params['id'], TaskIdSchema, 'id'));
      const session = this.sessions.getSession(task.sessionId);
      // A aprovação pendente viaja junto: sem ela, o agente que delegou só
      // consegue dizer "está bloqueado" sem saber POR QUÊ, e a orientação que
      // ele passa ao usuário vira chute.
      const blocking = this.sessions.pendingApprovals(session.id)[0] ?? null;
      sendJson(res, 200, {
        task,
        approval: blocking,
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
      // Query param e texto: NaN e negativo viram ausencia, senao chegariam ao
      // SQL como comparacao que nunca casa e devolveriam vazio em silencio.
      sendJson(res, 200, {
        events: this.sessions.listEvents(
          param(params['id'], SessionIdSchema, 'id'),
          inteiroOpcional(url.searchParams.get('since'), Number.MAX_SAFE_INTEGER),
          inteiroOpcional(url.searchParams.get('limit'), 5000) ?? 500,
        ),
      });
    });

    this.#route('POST', '/sessions/:id/send', async (req, res, params) => {
      const body = await readBody(req, SendMessageSchema);
      sendJson(res, 200, await this.sessions.send(param(params['id'], SessionIdSchema, 'id'), body.text));
    });

    this.#route('POST', '/sessions/:id/interrupt', async (_req, res, params) => {
      // `interrupted: false` quer dizer que a sessão existe e não havia turno
      // em andamento. Não é erro, mas quem clicou precisa saber que nada
      // aconteceu — senão o botão parece ter funcionado.
      const interrupted = await this.sessions.interrupt(
        param(params['id'], SessionIdSchema, 'id'),
      );
      sendJson(res, 200, { ok: true, interrupted });
    });

    this.#route('POST', '/sessions/:id/pause', async (_req, res, params) => {
      await this.sessions.pause(params['id'] ?? '');
      sendJson(res, 200, { ok: true });
    });

    this.#route('POST', '/sessions/:id/cancel', async (req, res, params) => {
      const body = await readBody(req, CancelSchema).catch(() => ({ reason: undefined }));
      await this.sessions.cancel(param(params['id'], SessionIdSchema, 'id'), body.reason);
      sendJson(res, 200, { ok: true });
    });

    this.#route('POST', '/sessions/:id/handoff', async (req, res, params) => {
      const body = await readBody(req, HandoffSessionSchema);
      const sessionId = param(params['id'], SessionIdSchema, 'id');
      const session = await this.sessions.handoff(sessionId, body.agentId, body.reason);
      sendJson(res, 200, { ok: true, session });
    });

    /**
     * Delegação: agente A pede a B. É a mesma rota de criar sessão, com o
     * chamador preenchido — o que ativa checagem de grafo, herança de modo e
     * reserva de orçamento a partir do saldo da raiz.
     */
    this.#route('POST', '/sessions/:id/delegate', async (req, res, params) => {
      const body = await readBody(req, DelegateSchema);
      const requester = this.sessions.getSession(param(params['id'], SessionIdSchema, 'id'));
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
      const body = await readBody(req, ResolveApprovalSchema);
      sendJson(res, 200, {
        approval: await this.sessions.resolveApproval(
          param(params['id'], ApprovalIdSchema, 'id'),
          body.decision,
          body.by ?? 'você',
        ),
      });
    });

    // ------------------------------------------------- gate pré-execução
    /**
     * Consultado pelo hook do agente ANTES de a ferramenta rodar.
     *
     * É a única prevenção real que o Hub consegue sem sandbox de sistema: aqui
     * a resposta decide se a ação acontece, ao contrário da vigilância
     * reativa, que só vê o fato consumado.
     */
    this.#route('POST', '/hooks/pretooluse', async (req, res) => {
      const body = await readBody(req, PreToolGateSchema);
      const verdict = this.sessions.gateToolCall(body);

      sendJson(res, 200, {
        permission: toHookPermission(verdict.decision),
        decision: verdict.decision,
        risk: verdict.risk,
        reason: verdict.reason,
        explanation: explainToAgent(verdict, verdict.session?.mode ?? 'semi'),
        sessionId: verdict.session?.id ?? null,
        agentId: verdict.session?.agentId ?? null,
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

/**
 * Lê e VALIDA o corpo. Erro de contrato vira 422 apontando o campo, em vez de
 * virar exceção obscura no meio do domínio.
 */
async function readBody<T>(req: IncomingMessage, schema: ZodType<T>): Promise<T> {
  const raw = await readJson<unknown>(req);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HubError('INVALID_BRIEF', 'corpo da requisição inválido', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

/** Valida um parâmetro de rota antes de ele virar consulta ao banco. */
function param<T>(valor: string | undefined, schema: ZodType<T>, nome: string): T {
  const parsed = schema.safeParse(valor ?? '');
  if (!parsed.success) {
    throw new HubError('INVALID_BRIEF', `parâmetro "${nome}" inválido`, {
      valor,
      message: parsed.error.issues[0]?.message,
    });
  }
  return parsed.data;
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

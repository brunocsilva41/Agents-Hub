import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HubError, isHubError, nowIso, type EventEnvelope } from '@agents-hub/core';
import type { ZodType } from 'zod';
import type { AgentRegistry } from '@agents-hub/adapters';
import type { InMemoryEventBus } from './bus.js';
import type { HubConfig } from './config.js';
import { guardRequest } from './guard.js';
import { decodificarSegmento, ehErroDeUrl, readJsonBody } from './http-body.js';
import { validarDiretorioDeProjeto } from './project-path.js';
import { explainToAgent, toHookPermission } from './pretool-gate.js';
import { generateApiDescriptor, formatTaskResponse } from './api-tasks.js';
import {
  CreateTaskSchema,
  AdoptSessionSchema,
  ApprovalIdSchema,
  CancelSchema,
  AddFolderSchema,
  CreateProjectSchema,
  AgentIdParamSchema,
  ImportSchema,
  ProjectTrustSchema,
  DelegateSchema,
  FolderIdSchema,
  HandoffSessionSchema,
  ResolveApprovalSchema,
  SendMessageSchema,
  ProjectContextSchema,
  ProjectIdSchema,
  SessionIdSchema,
  PreToolGateSchema,
  StartSessionSchema,
  TaskIdSchema,
  inteiroOpcional,
  parseSseSince,
} from './http-schemas.js';
import type { WorktreeReaper } from './reaper.js';
import type { AdoptedRootLeases } from './adopted-leases.js';
import type { SessionManager } from './session-manager.js';
import { serveStatic } from './static.js';
import { resumoDaFerramenta, type AuditTrail } from './audit.js';
import {
  authenticateOperator,
  markOperator,
  operatorCookieHeader,
  operatorOf,
  shouldIssueOperatorCookie,
} from './operator-auth.js';
import { registerOperatorRoutes } from './operator-routes.js';
import type { PolicyService } from './policy-service.js';
import { startSseChannel } from './sse.js';
import type { DiscoveryService, ImportService } from './absorption.js';

/**
 * Quantos eventos um replay de SSE manda antes de cortar.
 *
 * Igual ao teto padrão de `SqliteEventRepository.list` (500) — usar o mesmo
 * número aqui é o que permite detectar truncamento sem mudar a assinatura do
 * repositório: se o replay voltou exatamente `SSE_REPLAY_LIMIT` eventos, ele
 * quase certamente foi cortado, e o cliente precisa saber.
 */
const SSE_REPLAY_LIMIT = 500;

/**
 * Fila do canal SSE para as duas rotas.
 *
 * Maior que `SSE_REPLAY_LIMIT`, de propósito: o replay inteiro manda até 500
 * eventos de uma vez, de forma síncrona, ANTES de qualquer live event. Com o
 * cap padrão de `sse.ts` (200, pensado para um cliente que parou de ler
 * eventos AO VIVO), o replay de uma sessão longa se auto-classificaria como
 * "cliente lento" e derrubaria a conexão no primeiro segundo — descoberto
 * rodando este cenário de verdade, não hipótese. A margem sobre 500 é para
 * live events que cheguem durante o próprio replay.
 */
const SSE_QUEUE_CAP = SSE_REPLAY_LIMIT + 200;

/** Aviso sintético — nunca persistido — de que o replay de `/events` foi cortado. */
function truncatedReplayNotice(sessionId: string, sentCount: number): EventEnvelope {
  return {
    id: `evt_truncated_${sessionId}`,
    seq: 0,
    ts: nowIso(),
    sessionId,
    taskId: null,
    agentId: 'daemon',
    type: 'log',
    payload: { truncated: true, sentCount, sessionId },
    cost: null,
    raw: null,
  };
}

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
  /** Exige o token de operador (item 1.6) — ver `operator-auth.ts`. */
  operator: boolean;
}

/** O que o servidor precisa para as rotas de operador (itens 1.6 e 1.10). */
export interface OperatorDeps {
  /** Token de `<home>/operator-token`. */
  token: string;
  audit: AuditTrail;
  policy: PolicyService;
}

/** Quem fez, para `by`/auditoria. Só existe em rota `operator: true`. */
function quem(req: IncomingMessage): string {
  return operatorOf(req)?.by ?? 'desconhecido';
}

/**
 * API HTTP + SSE do daemon.
 *
 * CLI, TUI e Web UI consomem exatamente estas rotas (ADR 01.2): nenhuma lógica
 * mora no cliente, então os três têm a mesma capacidade por construção. O MCP
 * server e a API REST de automação externa (`/api/tasks/*`, ver `api-tasks.ts`)
 * são tradutores para cá, não caminhos paralelos.
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
    private readonly discovery: DiscoveryService,
    private readonly importer: ImportService,
    private readonly operator: OperatorDeps,
    /** Prazo das raízes adotadas (item 2.8); opcional para testes que montam o servidor à mão. */
    private readonly leases: AdoptedRootLeases | null = null,
  ) {
    this.#registerRoutes();
  }

  listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      // `.catch`: sem ele, qualquer exceção fora do `try` das rotas (URL
      // malformada, por exemplo) virava promessa rejeitada sem tratamento e
      // a conexão ficava pendurada até o cliente desistir.
      const server = createServer((req, res) => {
        this.#dispatch(req, res).catch((err: unknown) => falhaDeDespacho(res, err));
      });
      server.on('error', reject);
      server.listen(this.config.port, this.config.host, () => {
        this.#server = server;
        // `port: 0` pede ao SO uma porta livre, ligada atomicamente. A porta
        // REAL volta para a config porque a guarda valida Host/Origin contra
        // ela (e `baseUrl` a usa): ficar com 0 recusaria toda requisição.
        // Testes dependem disto — "abrir 0, ler, fechar e reabrir" é corrida
        // com qualquer outro processo da máquina.
        const endereco = server.address();
        if (endereco !== null && typeof endereco === 'object') this.config.port = endereco.port;
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

  #route(method: string, path: string, handler: Handler, opts: { operator?: boolean } = {}): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:(\w+)/g, (_m, key: string) => {
        keys.push(key);
        return '([^/]+)';
      })}$`,
    );
    this.#routes.push({ method, pattern, keys, handler, operator: opts.operator === true });
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

      // Rotas que mudam política/segurança exigem o token de operador (item
      // 1.6). Checado ANTES de ler corpo ou parâmetro: sem token, nada da
      // requisição chega ao domínio.
      if (route.operator) {
        const identidade = authenticateOperator(req, this.operator.token);
        if (!identidade) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="agents-hub"');
          sendJson(res, 401, {
            error: {
              code: 'UNAUTHORIZED',
              message:
                'esta rota exige o token de operador (Authorization: Bearer ou X-Hub-Token, ' +
                'lido de <AGENTS_HUB_HOME>/operator-token; no painel, recarregue a página)',
            },
          });
          return;
        }
        markOperator(req, identidade);
      }

      try {
        // Dentro do `try`: `decodeURIComponent('%E0')` lança URIError, e fora
        // daqui isso virava rejeição não tratada — o processo do daemon caía
        // com um GET qualquer. Segmento mal codificado é erro de quem chamou.
        const params: Record<string, string> = {};
        route.keys.forEach((key, i) => {
          params[key] = decodificarSegmento(match[i + 1] ?? '');
        });

        await route.handler(req, res, params);
      } catch (err) {
        sendError(res, err);
      }
      return;
    }

    // Nenhuma rota de API bateu: pode ser a Web UI. Carregar o documento no
    // navegador entrega o token de operador por cookie HttpOnly (item 1.6).
    if (req.method === 'GET') {
      if (shouldIssueOperatorCookie(req)) {
        res.setHeader('Set-Cookie', operatorCookieHeader(this.operator.token));
      }
      if (serveStatic(this.config.webRoot, url.pathname, res)) return;
      if (!res.headersSent) res.removeHeader('Set-Cookie');
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Rota ${url.pathname} não existe` } });
  }

  #registerRoutes(): void {
    // ------------------------------------------------------------- saúde
    this.#route('GET', '/health', (_req, res) => {
      sendJson(res, 200, {
        ok: true,
        version: '0.1.0',
        now: nowIso(),
        // `home` NÃO sai aqui: é o caminho absoluto do usuário (revela o nome
        // da conta) e nenhum cliente precisa dele — a CLI lê o próprio config.
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
          // Painel/CLI só oferecem "Modelo" para quem declara suporte: nos
          // demais o valor não chegaria ao CLI (vistoria 2026-09-25).
          model: { supported: manifest.model.supported, format: manifest.model.format },
          verified: manifest.verified,
          probe: byId.get(manifest.id) ?? null,
        })),
      });
    });

    this.#route('POST', '/agents/probe', async (_req, res) => {
      sendJson(res, 200, { probes: await this.registry.probeAll(true) });
    });

    // ------------------------------------------- descoberta e absorção
    //
    // Só leitura; a resposta nunca carrega segredo (ver `absorption.ts`).
    // Cache de 30s; `?refresh=1` força releitura (e novo probe).
    const wantsRefresh = (req: IncomingMessage): boolean => {
      const v = new URL(req.url ?? '/', 'http://local').searchParams.get('refresh');
      return v === '1' || v === 'true';
    };

    this.#route('GET', '/discovery', async (req, res) => {
      sendJson(res, 200, { agents: await this.discovery.all(wantsRefresh(req)) });
    });

    this.#route('GET', '/discovery/:agentId', async (req, res, params) => {
      const agentId = param(params['agentId'], AgentIdParamSchema, 'agentId');
      sendJson(res, 200, { agent: await this.discovery.one(agentId, wantsRefresh(req)) });
    });

    // ------------------------------------------------------- API REST de tasks
    //
    // Isto NÃO é o protocolo A2A (JSON-RPC 2.0, `message/send`, `tasks/get`,
    // `tasks/resubscribe`) — é uma API REST simples em torno dos tipos do Hub,
    // para automação externa (scripts, CI, peers que só falam HTTP+SSE). Ver
    // `docs/decisoes/02-orquestracao.md` (ADR 02.3) para o porquê de "A2A de
    // verdade" continuar em aberto, e `api-tasks.ts` para o descritor da API.
    //
    // Não existe rota de descoberta em `/.well-known/agent-card.json`: esse
    // caminho é reservado pela spec A2A para descoberta automática, e um
    // scanner que o encontrasse assumiria compatibilidade que não existe.
    const getBaseUrl = (req: IncomingMessage): string => {
      const host = req.headers.host ?? `${this.config.host}:${this.config.port}`;
      return `http://${host}`;
    };

    this.#route('GET', '/api/descriptor.json', (req, res) => {
      sendJson(res, 200, generateApiDescriptor(this.config, this.registry, getBaseUrl(req)));
    });

    this.#route('POST', '/api/tasks', async (req, res) => {
      const body = await readBody(req, CreateTaskSchema);
      const projectId =
        body.projectId ??
        this.sessions.registerProject(
          body.projectPath !== undefined
            ? validarDiretorioDeProjeto(body.projectPath, 'projectPath')
            : process.cwd(),
        ).id;

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
        task: formatTaskResponse(result.task, result.session.state),
        session: result.session,
        budget: result.budget,
        approval: result.approval ?? null,
      });
    });

    this.#route('GET', '/api/tasks/:id', (_req, res, params) => {
      const taskId = param(params['id'], TaskIdSchema, 'id');
      const task = this.sessions.getTask(taskId);
      const session = this.sessions.getSession(task.sessionId);
      sendJson(res, 200, {
        task: formatTaskResponse(task, session.state),
      });
    });

    this.#route('POST', '/api/tasks/:id/cancel', async (_req, res, params) => {
      const taskId = param(params['id'], TaskIdSchema, 'id');
      const task = this.sessions.getTask(taskId);
      await this.sessions.cancel(task.sessionId, 'cancelado via API de tasks');
      const updatedTask = this.sessions.getTask(taskId);
      const session = this.sessions.getSession(task.sessionId);
      sendJson(res, 200, {
        task: formatTaskResponse(updatedTask, session.state),
      });
    });

    this.#route('GET', '/api/tasks/:id/events', (req, res, params) => {
      const taskId = param(params['id'], TaskIdSchema, 'id');
      const task = this.sessions.getTask(taskId);

      if (!this.#acceptSseConnection(res)) return;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`: conectado ao stream de eventos da task ${taskId}\n\n`);

      // Stream de UMA sessão só (a task não muda de sessão em execução): o
      // mesmo `id:` + keep-alive + backpressure que `/events` já tinha,
      // extraído para não divergir de novo entre as duas rotas.
      let unsubscribe: () => void = () => {};
      const channel = startSseChannel(req, res, {
        withId: true,
        queueCap: SSE_QUEUE_CAP,
        onClose: () => unsubscribe(),
      });

      const past = this.sessions.listEvents(task.sessionId, undefined, SSE_REPLAY_LIMIT);
      for (const event of past) channel.send(event);
      if (past.length === SSE_REPLAY_LIMIT) {
        channel.send(truncatedReplayNotice(task.sessionId, past.length), { withId: false });
      }

      unsubscribe = this.bus.subscribe({ sessionId: task.sessionId }, (event: EventEnvelope) =>
        channel.send(event),
      );
    });

    // ------------------------------------------------------------- projetos
    this.#route('GET', '/projects', (_req, res) => {
      sendJson(res, 200, { projects: this.sessions.listProjects() });
    });

    this.#route('POST', '/projects', async (req, res) => {
      const body = await readBody(req, CreateProjectSchema);
      const dir = validarDiretorioDeProjeto(body.path);
      sendJson(res, 201, { project: this.sessions.registerProject(dir, body.name) });
    });

    // Confiança no projeto: libera `validation.command`/revisão do
    // `.agents-hub/config.yaml` do repositório (que viram processo). Mora no
    // banco do Hub, fora do repo — ver `ProjectRegistry.setTrusted`.
    this.#route(
      'POST',
      '/projects/:id/trust',
      async (req, res, params) => {
        const body = await readBody(req, ProjectTrustSchema);
        const projectId = param(params['id'], ProjectIdSchema, 'id');
        const project = this.sessions.setProjectTrusted(projectId, body.trusted);
        this.operator.audit.record({
          actor: quem(req),
          kind: 'project.trust',
          projectId,
          action: `POST /projects/${projectId}/trust`,
          decision: body.trusted ? 'trusted' : 'untrusted',
        });
        sendJson(res, 200, {
          project,
          // O que acabou de ser confiado (ou não), para a CLI mostrar.
          repo: this.sessions.getProjectRepoStatus(projectId),
        });
      },
      { operator: true },
    );

    // Pastas do projeto. Um projeto agrupa N pastas; a sessão roda em UMA
    // delas, e é isso que mantém o confinamento de acesso significando algo.
    this.#route('GET', '/projects/:id/folders', (_req, res, params) => {
      sendJson(res, 200, {
        folders: this.sessions.listProjectFolders(param(params['id'], ProjectIdSchema, 'id')),
      });
    });

    // Pastas mudam ONDE o agente pode agir (confinamento): token de operador.
    this.#route(
      'POST',
      '/projects/:id/folders',
      async (req, res, params) => {
        const body = await readBody(req, AddFolderSchema);
        const projectId = param(params['id'], ProjectIdSchema, 'id');
        const folder = this.sessions.addProjectFolder(
          projectId,
          validarDiretorioDeProjeto(body.path),
          body.label,
        );
        this.operator.audit.record({
          actor: quem(req),
          kind: 'project.folders',
          projectId,
          action: `adicionou pasta ${folder.path}`,
          decision: 'added',
        });
        sendJson(res, 201, { folder });
      },
      { operator: true },
    );

    this.#route(
      'DELETE',
      '/projects/:id/folders/:folderId',
      (req, res, params) => {
        const projectId = param(params['id'], ProjectIdSchema, 'id');
        const folderId = param(params['folderId'], FolderIdSchema, 'folderId');
        this.sessions.removeProjectFolder(projectId, folderId);
        this.operator.audit.record({
          actor: quem(req),
          kind: 'project.folders',
          projectId,
          action: `removeu pasta ${folderId}`,
          decision: 'removed',
        });
        sendJson(res, 200, { ok: true });
      },
      { operator: true },
    );

    // Memória e prompts do projeto. Vivem no daemon, e não no navegador,
    // porque precisam valer também para a sessão que um agente delega a outro.
    //
    // `context` é SÓ o que o usuário configurou pelo Hub (banco); `repo` é o
    // `.agents-hub/config.yaml` do repositório, com o estado da confiança —
    // separados para o PUT nunca promover conteúdo do repo a confiável.
    this.#route('GET', '/projects/:id/context', (_req, res, params) => {
      const projectId = param(params['id'], ProjectIdSchema, 'id');
      sendJson(res, 200, {
        context: this.sessions.getProjectContext(projectId),
        repo: this.sessions.getProjectRepoStatus(projectId),
      });
    });

    // Contexto inclui `env` do agente (provedor/BASE_URL): token de operador.
    this.#route(
      'PUT',
      '/projects/:id/context',
      async (req, res, params) => {
        const body = await readBody(req, ProjectContextSchema);
        const projectId = param(params['id'], ProjectIdSchema, 'id');
        const context = this.sessions.setProjectContext(projectId, body);
        this.operator.audit.record({
          actor: quem(req),
          kind: 'project.context',
          projectId,
          action: `PUT /projects/${projectId}/context`,
          decision: 'updated',
          detail: { envAgents: Object.keys(body.env ?? {}) },
        });
        sendJson(res, 200, { context });
      },
      { operator: true },
    );

    // Absorção: traz para o projeto o que o agente já tem (instruções, defaults
    // de modelo, ferramentas MCP). `dryRun` é verdadeiro por padrão.
    // Import lê config dos CLIs e, com `dryRun: false`, grava no projeto:
    // token de operador inclusive na prévia (ela expõe o que os CLIs têm).
    this.#route(
      'POST',
      '/projects/:id/import',
      async (req, res, params) => {
        const projectId = param(params['id'], ProjectIdSchema, 'id');
        const body = await readBody(req, ImportSchema);
        const project = this.sessions.getProject(projectId);
        // `?? true`: ausência de dryRun NUNCA pode significar "escreva".
        const dryRun = body.dryRun ?? true;
        const result = await this.importer.run(
          {
            path: project.path,
            getContext: () => this.sessions.getProjectContext(projectId),
            setContext: (ctx) => void this.sessions.setProjectContext(projectId, ctx),
          },
          { ...body, dryRun },
        );
        if (!dryRun) {
          this.operator.audit.record({
            actor: quem(req),
            kind: 'project.import',
            projectId,
            action: `importou de ${body.agentId}: ${body.kinds.join(', ')}`,
            decision: 'applied',
          });
        }
        sendJson(res, 200, result);
      },
      { operator: true },
    );

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
        body.projectId ??
        this.sessions.registerProject(
          body.projectPath !== undefined
            ? validarDiretorioDeProjeto(body.projectPath, 'projectPath')
            : process.cwd(),
        ).id;

      const session = this.sessions.adoptExternal({
        agentId: body.agentId,
        projectId,
        title: body.title,
        budget: body.budget,
      });
      this.leases?.track(session.id);
      sendJson(res, 201, { session });
    });

    this.#route('POST', '/sessions/:id/detach', async (_req, res, params) => {
      const id = param(params['id'], SessionIdSchema, 'id');
      this.leases?.forget(id);
      await this.sessions.detach(id);
      sendJson(res, 200, { ok: true });
    });

    /**
     * Sinal de vida da raiz adotada (MCP server de agente externo). Sem ele a
     * raiz expira — ver `adopted-leases.ts`.
     */
    this.#route('POST', '/sessions/:id/heartbeat', (_req, res, params) => {
      const id = param(params['id'], SessionIdSchema, 'id');
      if (!this.leases) {
        sendJson(res, 200, { ok: true, leaseMs: null });
        return;
      }
      sendJson(res, 200, { ok: true, ...this.leases.heartbeat(id) });
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
      sendJson(res, 200, {
        tasks: this.sessions.listTasks(param(params['id'], SessionIdSchema, 'id')),
      });
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
      const id = param(params['id'], SessionIdSchema, 'id');
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
          {
            // `tail=1`: os N mais recentes. `before=S`: os N anteriores a S. O
            // painel abre pelo fim e pagina para trás ao rolar para cima.
            beforeSeq: inteiroOpcional(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER),
            newest: url.searchParams.get('tail') === '1',
          },
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
      // `state` é o estado DEPOIS da interrupção (`idle` quando parou um
      // turno): quem chamou vê que a sessão segue viva e retomável por send.
      const sessionId = param(params['id'], SessionIdSchema, 'id');
      const interrupted = await this.sessions.interrupt(sessionId);
      sendJson(res, 200, { ok: true, interrupted, state: this.sessions.getSession(sessionId).state });
    });

    this.#route('POST', '/sessions/:id/pause', async (_req, res, params) => {
      const sessionId = param(params['id'], SessionIdSchema, 'id');
      await this.sessions.pause(sessionId);
      sendJson(res, 200, { ok: true, state: this.sessions.getSession(sessionId).state });
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
      sendJson(res, 200, {
        approval: this.sessions.getApproval(param(params['id'], ApprovalIdSchema, 'id')),
      });
    });

    // Decidir aprovação é o ato de operador por excelência (item 1.6): exige
    // o token, e `by` sai da origem autenticada (`cli:<usuário>`, `web`). O
    // `by` do corpo continua aceito pelo schema (clientes antigos), mas é
    // IGNORADO — texto livre tornava a auditoria falsificável.
    this.#route(
      'POST',
      '/approvals/:id',
      async (req, res, params) => {
        const body = await readBody(req, ResolveApprovalSchema);
        sendJson(res, 200, {
          approval: await this.sessions.resolveApproval(
            param(params['id'], ApprovalIdSchema, 'id'),
            body.decision,
            quem(req),
          ),
        });
      },
      { operator: true },
    );

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
      // `await` obrigatório: `gateToolCall` bloqueia esperando a decisão humana
      // quando a política manda aprovar. Responder sem esperar devolveria uma
      // Promise serializada como `{}` e o hook leria "sem permissão declarada"
      // — o gate falharia ABERTO, exatamente no caso que ele existe para pegar.
      const verdict = await this.sessions.gateToolCall(body);
      // Trilha de auditoria (item 1.10): toda decisão do gate sobre uma sessão
      // do Hub. Chamada fora de sessão do Hub não tem política aplicada.
      if (verdict.session) {
        this.operator.audit.record({
          actor: 'gate',
          kind: 'gate.decision',
          sessionId: verdict.session.id,
          projectId: verdict.session.projectId,
          approvalId: verdict.approvalId ?? null,
          action: resumoDaFerramenta(body.toolName, body.toolInput ?? {}),
          decision: verdict.decision,
          risk: verdict.risk,
          reason: verdict.reason,
          detail: { tool: body.toolName, agentId: verdict.session.agentId },
        });
      }

      sendJson(res, 200, {
        permission: toHookPermission(verdict.decision),
        decision: verdict.decision,
        risk: verdict.risk,
        reason: verdict.reason,
        // A explicação do gate diz o desfecho REAL (ninguém respondeu, humano
        // negou, humano liberou, sessão encerrada). Recalculá-la a partir só da
        // decisão transformava toda negação em "a política proíbe, não tente
        // contornar" — inclusive a falta de resposta, que não é proibição.
        explanation: verdict.explanation ?? explainToAgent(verdict, verdict.session?.mode ?? 'semi'),
        approvalId: verdict.approvalId ?? null,
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
    this.#route(
      'POST',
      '/shutdown',
      (req, res) => {
        this.operator.audit.record({ actor: quem(req), kind: 'daemon.shutdown', action: 'POST /shutdown' });
        sendJson(res, 200, { ok: true, message: 'encerrando' });
        // Responde ANTES de derrubar: quem pediu precisa saber que foi aceito.
        setTimeout(() => void this.onShutdown?.(), 100);
      },
      { operator: true },
    );

    // Apaga worktrees (checkout do trabalho do agente): token de operador.
    this.#route(
      'POST',
      '/maintenance/sweep',
      async (req, res) => {
        const sweep = await this.reaper.sweep();
        this.operator.audit.record({
          actor: quem(req),
          kind: 'maintenance.sweep',
          action: 'POST /maintenance/sweep',
          detail: { removed: sweep.removed },
        });
        sendJson(res, 200, { sweep });
      },
      { operator: true },
    );

    // Editor de política e auditoria (item 1.10) — ver `operator-routes.ts`.
    registerOperatorRoutes((method, path, handler, opts) => this.#route(method, path, handler, opts), {
      policy: this.operator.policy,
      audit: this.operator.audit,
    });

    // ------------------------------------------------------------- grafo e custo
    this.#route('GET', '/graph/:rootId', (_req, res, params) => {
      sendJson(res, 200, {
        graph: this.sessions.graph(param(params['rootId'], SessionIdSchema, 'rootId')),
      });
    });

    this.#route('GET', '/budget/:rootId', (_req, res, params) => {
      sendJson(res, 200, {
        budget: this.sessions.budget(param(params['rootId'], SessionIdSchema, 'rootId')),
      });
    });

    // ------------------------------------------------------------- stream SSE
    this.#route('GET', '/events', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      const rootId = url.searchParams.get('rootId') ?? undefined;
      // Presente-e-inválido é erro (400), não "sem filtro" — ver o
      // comentário de `parseSseSince`. Lançado ANTES do `res.writeHead`.
      const since = parseSseSince(url.searchParams.get('since'));

      if (!this.#acceptSseConnection(res)) return;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`: conectado em ${nowIso()}\n\n`);

      const singleSession = sessionId !== undefined;
      let unsubscribe: () => void = () => {};
      const channel = startSseChannel(req, res, {
        withId: singleSession,
        queueCap: SSE_QUEUE_CAP,
        onClose: () => unsubscribe(),
      });

      // Replay do que já passou: quem conecta no meio de uma sessão longa
      // precisa ver o começo, senão a timeline chega truncada. Se o replay
      // bateu no teto, o cliente precisa de um sinal — não só silêncio.
      if (sessionId) {
        const past = this.sessions.listEvents(sessionId, since, SSE_REPLAY_LIMIT);
        for (const event of past) channel.send(event);
        if (past.length === SSE_REPLAY_LIMIT) {
          channel.send(truncatedReplayNotice(sessionId, past.length), { withId: false });
        }
      }

      unsubscribe = this.bus.subscribe({ sessionId, rootId }, (event) => channel.send(event));
    });
  }

  /**
   * Teto de conexões SSE simultâneas.
   *
   * Sem isto, cada conexão aceita compete pelo mesmo processo Node (keep-alive
   * próprio, fila própria) sem limite algum. Acima do teto, 503 ANTES de
   * `res.writeHead` — o cliente recebe um erro claro em vez de uma conexão
   * que o daemon não tem como atender direito.
   */
  #acceptSseConnection(res: ServerResponse): boolean {
    if (this.bus.subscriberCount < this.config.maxSseConnections) return true;
    sendJson(res, 503, {
      error: {
        code: 'SSE_CONNECTION_LIMIT',
        message: `limite de ${this.config.maxSseConnections} conexões SSE simultâneas atingido`,
      },
    });
    return false;
  }
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
  if (ehErroDeUrl(err)) {
    sendJson(res, 400, { error: { code: 'MALFORMED_URL', message: 'URL malformada' } });
    return;
  }
  sendJson(res, 500, {
    error: { code: 'INTERNAL', message: (err as Error).message ?? 'erro desconhecido' },
  });
}

export function statusFor(code: string): number {
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
    case 'INVALID_QUERY':
    case 'INVALID_ID':
    case 'INVALID_JSON':
    case 'INVALID_PATH':
    case 'MALFORMED_URL':
      return 400;
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    case 'AGENT_NOT_INSTALLED':
    case 'AGENT_NOT_AUTHENTICATED':
    case 'CAPABILITY_UNRESOLVED':
    case 'CODEX_GATE_NOT_GUARANTEED':
      return 424;
    case 'ADAPTER_FAILURE':
      // Sempre falha de execução do adapter/processo (agente não sobe,
      // upstream HTTP não-2xx, etc.) — nunca payload inválido do chamador.
      // 502 (Bad Gateway) é o que descreve corretamente uma falha de serviço
      // upstream; cair no default 400 faz um cliente HTTP tratar isto como
      // "corrija seu payload" quando na verdade é "tente de novo depois".
      return 502;
    default:
      return 400;
  }
}

/**
 * Lê e VALIDA o corpo. Erro de contrato vira 422 apontando o campo, em vez de
 * virar exceção obscura no meio do domínio.
 */
async function readBody<T>(req: IncomingMessage, schema: ZodType<T>): Promise<T> {
  const raw = await readJsonBody(req);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HubError('INVALID_BRIEF', 'corpo da requisição inválido', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

/** Valida um parâmetro de rota antes de ele virar consulta ao banco. */
/**
 * Parâmetro de rota validado. Id malformado é 400 (`INVALID_ID`), nunca um 404
 * silencioso nem um 422 de corpo: quem mandou `../shutdown` no lugar de um id
 * precisa ouvir que o problema é o formato, não que "não achou".
 */
function param<T>(valor: string | undefined, schema: ZodType<T>, nome: string): T {
  const parsed = schema.safeParse(valor ?? '');
  if (!parsed.success) {
    throw new HubError('INVALID_ID', `parâmetro "${nome}" inválido`, {
      valor,
      message: parsed.error.issues[0]?.message,
    });
  }
  return parsed.data;
}

/**
 * Último recurso quando o despacho falha FORA do `try` das rotas: responde em
 * vez de deixar a conexão pendurada. Se o cabeçalho já saiu, só encerra.
 */
function falhaDeDespacho(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  try {
    sendError(res, err);
  } catch {
    res.destroy();
  }
}

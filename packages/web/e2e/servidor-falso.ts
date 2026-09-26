/**
 * Servidor falso do Hub para o teste e2e do painel.
 *
 * Serve o build estático (`packages/web/dist`) e responde às rotas que o
 * painel lê com dados fixos. Não sobe daemon, não toca em `~/.agents-hub` nem
 * na porta 4747, não chama CLI de agente nenhum: é o painel contra uma API de
 * mentira, na mesma origem, numa porta escolhida pelo sistema.
 *
 * Os dados foram escolhidos para estressar o layout: títulos longos, uma
 * aprovação pendente (o banner ocupa altura), sessões em vários estados e um
 * orçamento com projeção (os dois chips de taxa aparecem juntos).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const agora = Date.now();
const ha = (min: number): string => new Date(agora - min * 60_000).toISOString();

const PROJETOS = [
  { id: 'prj_alfa', name: 'alfa', path: 'C:\\projetos\\alfa', defaultBranch: 'main', createdAt: ha(600) },
  { id: 'prj_beta', name: 'beta-monorepo', path: 'C:\\projetos\\beta', defaultBranch: 'main', createdAt: ha(500) },
];

function agente(id: string, name: string, vendor: string, installed = true) {
  return {
    id,
    name,
    vendor,
    description: `${name} de teste`,
    capabilities: ['code'],
    sessionStrategy: 'resume',
    streamFormat: 'jsonl',
    caveats: [],
    loginHint: '',
    probe: {
      agentId: id,
      installed,
      version: installed ? '1.0.0' : null,
      binPath: installed ? `C:\\bin\\${id}.exe` : null,
      error: installed ? null : 'binário não encontrado',
      checkedAt: ha(1),
    },
  };
}

const AGENTES = [
  agente('claude', 'Claude Code', 'Anthropic'),
  agente('codex', 'Codex CLI', 'OpenAI'),
  agente('copilot', 'GitHub Copilot CLI', 'GitHub'),
  agente('opencode', 'OpenCode', 'SST'),
  agente('cursor', 'Cursor Agent', 'Anysphere', false),
];

function sessao(
  id: string,
  agentId: string,
  state: string,
  title: string,
  extra: { rootId?: string; parentId?: string | null; depth?: number; projectId?: string; min?: number } = {},
) {
  return {
    id,
    projectId: extra.projectId ?? 'prj_alfa',
    agentId,
    nativeSessionId: null,
    rootId: extra.rootId ?? id,
    parentId: extra.parentId ?? null,
    depth: extra.depth ?? 0,
    state,
    mode: 'semi',
    isolation: 'worktree',
    title,
    workdir: 'C:\\projetos\\alfa',
    createdAt: ha((extra.min ?? 10) + 5),
    updatedAt: ha(extra.min ?? 10),
    endedAt: state === 'completed' ? ha(extra.min ?? 10) : null,
  };
}

export const SESSOES = [
  sessao(
    'ses_raiz1',
    'claude',
    'running',
    'Refatorar o módulo de autenticação inteiro para suportar SSO com provedores externos e rotação de chaves',
    { min: 2 },
  ),
  sessao('ses_filho1', 'codex', 'waiting_approval', 'Rodar a suíte de migração do banco', {
    rootId: 'ses_raiz1',
    parentId: 'ses_raiz1',
    depth: 1,
    min: 3,
  }),
  sessao('ses_raiz2', 'copilot', 'completed', 'Escrever testes de integração para a API de pedidos', {
    min: 40,
    projectId: 'prj_beta',
  }),
  sessao('ses_raiz3', 'opencode', 'paused', 'Investigar lentidão no build', { min: 20 }),
];

const APROVACOES = [
  {
    id: 'apv_um',
    sessionId: 'ses_filho1',
    taskId: null,
    risk: 'high',
    action: 'executar: npm run migrate -- --env=producao --force',
    detail: { command: 'npm run migrate -- --env=producao --force' },
    state: 'pending',
    requestedAt: ha(1),
    resolvedAt: null,
    resolvedBy: null,
  },
];

function eventosDe(sessionId: string) {
  const s = SESSOES.find((x) => x.id === sessionId);
  if (!s) return [];
  const base = { sessionId, taskId: null, agentId: s.agentId, cost: null, raw: null };
  return [
    { ...base, id: `evt_${sessionId}_1`, seq: 1, ts: ha(9), type: 'session.started', payload: { objective: s.title } },
    { ...base, id: `evt_${sessionId}_2`, seq: 2, ts: ha(8), type: 'message', payload: { text: 'Vou começar lendo a estrutura do projeto.' } },
    { ...base, id: `evt_${sessionId}_3`, seq: 3, ts: ha(7), type: 'tool.call', payload: { name: 'bash', input: { command: 'ls -la' } } },
    { ...base, id: `evt_${sessionId}_4`, seq: 4, ts: ha(6), type: 'message', payload: { text: 'Encontrei o módulo; próximos passos: testes e refatoração.' } },
  ];
}

function grafoDe(rootId: string) {
  const no = (s: (typeof SESSOES)[number]): unknown => ({
    sessionId: s.id,
    parentId: s.parentId,
    agentId: s.agentId,
    title: s.title,
    state: s.state,
    depth: s.depth,
    usd: 0.4231,
    tokens: 48213,
    startedAt: s.createdAt,
    endedAt: s.endedAt,
    children: SESSOES.filter((c) => c.parentId === s.id).map(no),
  });
  const raiz = SESSOES.find((s) => s.id === rootId);
  return raiz ? [no(raiz)] : [];
}

const ORCAMENTO = {
  limits: { usd: 2, tokens: 500000, seconds: 3600 },
  consumed: { usd: 0.8462, tokens: 96426, seconds: 812 },
  reserved: { usd: 0.5, tokens: 0, seconds: 0 },
  remaining: { usd: 0.6538, tokens: 403574, seconds: 2788 },
  pressure: 0.67,
  exhausted: false,
  isWarning: true,
  projection: { projectedUsd: 2.4312, projectedTokens: 280000, burnRateUsdPerSec: 0.0012 },
};

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function json(res: ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

async function estatico(res: ServerResponse, caminho: string): Promise<void> {
  const relativo = caminho === '/' ? 'index.html' : caminho.replace(/^\/+/, '');
  const alvo = path.resolve(DIST, relativo);
  if (!alvo.startsWith(DIST) || !existsSync(alvo)) {
    json(res, 404, { error: { code: 'NOT_FOUND', message: caminho } });
    return;
  }
  const corpo = await readFile(alvo);
  res.writeHead(200, { 'content-type': TIPOS[path.extname(alvo)] ?? 'application/octet-stream' });
  res.end(corpo);
}

async function rotear(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;

  if (req.method === 'POST') {
    // Nenhuma ação é exercida pelo teste; responder algo plausível evita
    // toasts de erro que mudariam o layout medido.
    req.resume();
    json(res, 200, { ok: true });
    return;
  }

  if (p === '/events') {
    // SSE que só abre e fica quieto: o painel marca "conectado" e não recebe nada.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': ok\n\n');
    return;
  }
  if (p === '/sessions') return json(res, 200, { sessions: SESSOES });
  if (p === '/agents') return json(res, 200, { agents: AGENTES });
  if (p === '/approvals') return json(res, 200, { approvals: APROVACOES });
  if (p === '/projects') return json(res, 200, { projects: PROJETOS });
  if (p === '/health') return json(res, 200, { ok: true, version: '0.1.0', now: new Date().toISOString(), liveSessions: 3, subscribers: 1 });
  if (p === '/discovery') return json(res, 200, { discoveries: [] });

  let m = /^\/sessions\/(ses_[a-z0-9]+)\/events$/i.exec(p);
  if (m) return json(res, 200, { events: eventosDe(m[1]!) });
  m = /^\/sessions\/(ses_[a-z0-9]+)$/i.exec(p);
  if (m) {
    const s = SESSOES.find((x) => x.id === m![1]);
    return s ? json(res, 200, { session: s, live: true }) : json(res, 404, { error: { code: 'NOT_FOUND' } });
  }
  m = /^\/graph\/(ses_[a-z0-9]+)$/i.exec(p);
  if (m) return json(res, 200, { graph: grafoDe(m[1]!) });
  if (/^\/budget\/ses_[a-z0-9]+$/i.test(p)) return json(res, 200, { budget: ORCAMENTO });
  if (/^\/projects\/prj_[a-z0-9]+\/context$/i.test(p)) {
    return json(res, 200, { context: { memory: 'Usar TypeScript estrito.' } });
  }

  await estatico(res, p);
}

export interface ServidorFalso {
  url: string;
  fechar: () => Promise<void>;
}

export async function subirServidorFalso(): Promise<ServidorFalso> {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(
      `build do painel ausente em ${DIST} — rode \`npm run build --workspace @agents-hub/web\` antes`,
    );
  }
  const abertas = new Set<ServerResponse>();
  const server: Server = createServer((req, res) => {
    abertas.add(res);
    res.on('close', () => abertas.delete(res));
    rotear(req, res).catch((err: unknown) => {
      json(res, 500, { error: { code: 'INTERNAL', message: String(err) } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endereco = server.address();
  if (!endereco || typeof endereco === 'string') throw new Error('sem porta');
  return {
    url: `http://127.0.0.1:${endereco.port}/`,
    fechar: async () => {
      for (const res of abertas) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

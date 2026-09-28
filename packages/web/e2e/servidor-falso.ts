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
import { rotearOperacao } from './dados-operacao';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const agora = Date.now();
const ha = (min: number): string => new Date(agora - min * 60_000).toISOString();

const PROJETOS = [
  {
    id: 'prj_alfa',
    name: 'alfa',
    path: 'C:\\projetos\\alfa',
    defaultBranch: 'main',
    createdAt: ha(600),
  },
  {
    id: 'prj_beta',
    name: 'beta-monorepo',
    path: 'C:\\projetos\\beta',
    defaultBranch: 'main',
    createdAt: ha(500),
  },
];

function agente(id: string, name: string, vendor: string, installed = true, modelo = true) {
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
    model: { supported: modelo, format: modelo ? 'provider/model' : '' },
    verified: { status: 'verified', version: '1.0.0', date: '2026-09-26', notes: '' },
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
  agente('cursor', 'Cursor Agent', 'Anysphere', false, false),
];

function sessao(
  id: string,
  agentId: string,
  state: string,
  title: string,
  extra: {
    rootId?: string;
    parentId?: string | null;
    depth?: number;
    projectId?: string;
    min?: number;
    adopted?: boolean;
  } = {},
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
    adopted: extra.adopted ?? false,
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
  sessao('ses_ext1', 'claude', 'running', 'Claude Code (externo)', { min: 25, adopted: true }),
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
    {
      ...base,
      id: `evt_${sessionId}_1`,
      seq: 1,
      ts: ha(9),
      type: 'session.started',
      payload: { objective: s.title },
    },
    {
      ...base,
      id: `evt_${sessionId}_2`,
      seq: 2,
      ts: ha(8),
      type: 'message',
      payload: { text: 'Vou começar lendo a estrutura do projeto.' },
    },
    {
      ...base,
      id: `evt_${sessionId}_3`,
      seq: 3,
      ts: ha(7),
      type: 'tool.call',
      payload: { name: 'bash', input: { command: 'ls -la' } },
    },
    {
      ...base,
      id: `evt_${sessionId}_4`,
      seq: 4,
      ts: ha(6),
      type: 'message',
      payload: { text: 'Encontrei o módulo; próximos passos: testes e refatoração.' },
    },
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

/* ---------------------------------------------------------------- Segurança */

/** Toda escrita que o painel fez (método, caminho, corpo), para o teste conferir. */
export const ESCRITAS: Array<{ method: string; path: string; body: unknown }> = [];
/** Última consulta a /audit (query string), para conferir os filtros. */
export const CONSULTAS_DE_AUDITORIA: string[] = [];

const POLITICA_EFETIVA = {
  maxDepth: 3,
  risk: { read: 'allow', write: 'allow', high: 'approve', irreversible: 'approve' },
  commands: { allow: ['npm test'], deny: ['rm -rf /'] },
};

function politica(projectId: string | null) {
  return {
    global: {
      file: 'C:\\Users\\teste\\.agents-hub\\config.json',
      layer: { maxDepth: 3 },
      effective: POLITICA_EFETIVA,
    },
    project: projectId
      ? {
          projectId,
          path: 'C:\\projetos\\alfa',
          file: 'C:\\projetos\\alfa\\.agents-hub\\config.yaml',
          trusted: false,
          error: null,
          ignoredExecFields: ['validation.command'],
          clamped: ['validation.command'],
          layer: { validation: { command: 'npm test' } },
          effective: POLITICA_EFETIVA,
        }
      : null,
  };
}

const REPO = {
  path: 'C:\\projetos\\alfa\\.agents-hub\\config.yaml',
  trust: 'suspended',
  sensitiveFields: [
    'validation.command = npm run check-tudo-antes-de-cada-task-com-um-nome-bem-comprido',
    'env.claude.ANTHROPIC_BASE_URL = http://servidor-de-alguem.example.com:8080/v1/um/caminho/longo',
    'env.codex.OPENAI_API_KEY',
    'prompts.codex',
    'memory',
  ],
  warning: 'config.yaml MUDOU desde que você confiou neste projeto',
  context: {},
};

function integracoes() {
  const hook = (instalado: boolean, avisoTimeout: string | null) => ({
    modo: 'arquivo',
    arquivo: 'C:\\Users\\teste\\.claude\\settings.json',
    instalado,
    avisoTimeout,
    erro: null,
    nota: 'o hook é consultado antes de cada Bash/Write/Edit e pode bloquear a chamada',
    comando: 'hub hooks install claude --write',
    instalavelPeloPainel: true,
  });
  const mcp = (registrado: boolean, atualizado: boolean, verificado = true) => ({
    arquivo: 'C:\\Users\\teste\\.codex\\config.toml',
    precisaDeProjeto: false,
    formato: 'toml-codex',
    verificado,
    nota: null,
    registrado,
    atualizado,
    erro: null,
    comando: 'hub mcp install codex --write',
  });
  return {
    entrypoints: {
      cli: 'C:\\hub\\cli\\main.js',
      mcp: 'C:\\hub\\mcp\\main.js',
      cliExiste: true,
      mcpExiste: true,
    },
    integrations: [
      {
        agentId: 'claude',
        hook: hook(
          true,
          'hook do gate instalado com timeout 10 s (precisa de 120 s): ação que pede aprovação roda sem ela',
        ),
        mcp: mcp(false, false),
      },
      {
        agentId: 'codex',
        hook: {
          modo: 'codex-inline',
          arquivo: 'C:\\Users\\teste\\.agents-hub\\config.json',
          instalado: false,
          avisoTimeout: null,
          erro: null,
          nota: 'o Hub monta o hook a cada invocação',
          comando: 'hub hooks install codex --write',
          instalavelPeloPainel: false,
        },
        mcp: mcp(true, false),
      },
      {
        agentId: 'cursor',
        hook: {
          modo: 'nenhum',
          arquivo: null,
          instalado: false,
          avisoTimeout: null,
          erro: null,
          nota: 'sem gate pré-execução: o Hub só vigia os eventos depois que a ferramenta roda',
          comando: null,
          instalavelPeloPainel: false,
        },
        mcp: mcp(true, true, false),
      },
    ],
  };
}

const PLANO = {
  agentId: 'claude',
  tipo: 'hook',
  arquivo: 'C:\\Users\\teste\\.claude\\settings.json',
  acao: 'atualizar',
  avisos: [],
  base: 'sha256:abc',
  diff: [
    { tipo: '@', texto: '… 12 linha(s) iguais' },
    { tipo: ' ', texto: '        "hooks": [' },
    {
      tipo: '-',
      texto:
        '          { "type": "command", "command": "\\"node\\" \\"C:/hub/cli/main.js\\" hook", "timeout": 10 }',
    },
    {
      tipo: '+',
      texto:
        '          { "type": "command", "command": "\\"node\\" \\"C:/hub/cli/main.js\\" hook", "timeout": 120 }',
    },
    { tipo: ' ', texto: '        ]' },
  ],
};

function auditoria(kind: string | null) {
  const e = (p: Record<string, unknown>) => ({
    id: `aud_${Math.random().toString(36).slice(2, 8)}`,
    ts: ha(5),
    actor: 'gate',
    kind: 'gate.decision',
    sessionId: 'ses_filho1',
    projectId: 'prj_alfa',
    approvalId: null,
    action:
      'Bash: npm run migrate -- --env=producao --force --com-um-argumento-bem-comprido-para-quebrar',
    decision: 'approve',
    risk: 'high',
    reason: 'comando irreversível fora da lista de permitidos',
    detail: { tool: 'Bash' },
    ...p,
  });
  const todas = [
    e({
      kind: 'approval.resolved',
      actor: 'web',
      approvalId: 'apv_velha',
      decision: 'denied',
      ts: ha(3),
      risk: null,
    }),
    e({ kind: 'approval.requested', approvalId: 'apv_velha', ts: ha(4) }),
    e({}),
    e({
      kind: 'policy.updated',
      actor: 'cli:bruno',
      sessionId: null,
      action: 'PUT /policy (camada global)',
      decision: 'loosened',
      reason: 'afrouxa: risk.irreversible',
      risk: null,
      detail: {},
    }),
  ];
  return kind ? todas.filter((x) => x.kind === kind) : todas;
}

async function corpo(req: IncomingMessage): Promise<unknown> {
  const partes: Buffer[] = [];
  for await (const p of req) partes.push(p as Buffer);
  const texto = Buffer.concat(partes).toString('utf8');
  if (texto === '') return undefined;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

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
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
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

/**
 * O que "Agentes detectados" mostra: caminhos longos e listas cheias, para a
 * tabela de detalhes (.disc-dl) ser medida em 375 px com conteúdo de verdade.
 */
const DESCOBERTA = [
  {
    agentId: 'claude',
    installed: true,
    version: '1.0.0',
    binPath: 'C:\\Users\\teste\\AppData\\Local\\Programs\\claude-code\\bin\\claude.exe',
    auth: { state: 'present', evidence: ['~/.claude/.credentials.json'] },
    defaults: { model: 'claude-opus-5-5', provider: 'anthropic', baseUrl: 'http://127.0.0.1:11434/v1' },
    files: [],
    mcpServers: [
      { name: 'agents-hub', transport: 'stdio', source: '~/.claude.json', isHub: true },
      {
        name: 'filesystem-servidor-com-nome-comprido',
        transport: 'stdio',
        env: { FS_ROOT: '***' },
        source: 'C:\\Users\\teste\\.claude\\settings.json',
        isHub: false,
      },
    ],
    instructionFiles: [{ path: 'C:\\Users\\teste\\.claude\\CLAUDE.md', bytes: 2048 }],
    warnings: [],
  },
];

/* ------------------------------------------------ Cenários de falha/vazio */

/**
 * Cenário da vez (estados.spec.ts): quais leituras respondem 500 e se as
 * listas do índice vêm vazias. Mutável de propósito — o teste liga, confere a
 * tela, desliga e clica "Tentar de novo". `redefinirCenario()` no fim de cada
 * teste, porque o módulo é compartilhado entre os arquivos de teste.
 */
export const CENARIO: {
  /** GET cujo caminho casar responde 500. */
  falhar: RegExp | null;
  /** /sessions, /approvals, /projects e /agents devolvem listas vazias. */
  vazio: boolean;
  /** Pastas extras cujo caminho casar são recusadas (400) ao vincular. */
  recusarPasta: RegExp | null;
} = { falhar: null, vazio: false, recusarPasta: null };

/** Projetos criados pelo modal durante o teste, e cada POST /projects recebido. */
export const PROJETOS_CRIADOS: Array<{
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  createdAt: string;
}> = [];
export const PASTAS_VINCULADAS: Array<{ projectId: string; path: string }> = [];

export function redefinirCenario(): void {
  CENARIO.falhar = null;
  CENARIO.vazio = false;
  CENARIO.recusarPasta = null;
  PROJETOS_CRIADOS.length = 0;
  PASTAS_VINCULADAS.length = 0;
}

async function rotearCenario(req: IncomingMessage, res: ServerResponse, p: string): Promise<boolean> {
  if (req.method === 'GET' && CENARIO.falhar?.test(p)) {
    json(res, 500, { error: { code: 'INTERNAL', message: `falha simulada em ${p}` } });
    return true;
  }
  if (req.method === 'GET' && CENARIO.vazio) {
    const vazios: Record<string, string> = {
      '/sessions': 'sessions',
      '/approvals': 'approvals',
      '/projects': 'projects',
      '/agents': 'agents',
    };
    const chave = vazios[p];
    if (chave) {
      json(res, 200, { [chave]: [] });
      return true;
    }
  }
  if (req.method === 'POST' && p === '/projects') {
    const b = ((await corpo(req)) ?? {}) as { path?: string; name?: string };
    const projeto = {
      id: `prj_novo${PROJETOS_CRIADOS.length + 1}`,
      name: b.name ?? 'novo',
      path: String(b.path),
      defaultBranch: 'main',
      createdAt: new Date().toISOString(),
    };
    PROJETOS_CRIADOS.push(projeto);
    json(res, 201, { project: projeto });
    return true;
  }
  const m = /^\/projects\/(prj_novo[0-9]+)\/folders$/.exec(p);
  if (req.method === 'POST' && m) {
    const b = ((await corpo(req)) ?? {}) as { path?: string };
    const caminho = String(b.path);
    if (CENARIO.recusarPasta?.test(caminho)) {
      json(res, 400, {
        error: { code: 'FOLDER_OVERLAP', message: `a pasta ${caminho} sobrepõe outra já vinculada` },
      });
      return true;
    }
    PASTAS_VINCULADAS.push({ projectId: m[1]!, path: caminho });
    json(res, 201, {
      folder: {
        id: `pfd_x${PASTAS_VINCULADAS.length}`,
        projectId: m[1],
        path: caminho,
        label: null,
        isPrimary: false,
        createdAt: new Date().toISOString(),
      },
    });
    return true;
  }
  return false;
}

async function rotear(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;

  if (await rotearCenario(req, res, p)) return;

  // Aba Operação (item 6.12): rotas com resposta própria, inclusive as escritas.
  if (await rotearOperacao(req, res, p)) return;

  if (req.method === 'PUT' || req.method === 'POST') {
    const body = await corpo(req);
    ESCRITAS.push({ method: req.method, path: p + url.search, body });
    const dryRun = url.searchParams.get('dryRun') === '1';
    if (req.method === 'PUT' && p === '/policy') {
      return json(
        res,
        200,
        dryRun
          ? { dryRun: true, loosened: ['risk.irreversible'], effective: POLITICA_EFETIVA }
          : {
              policy: politica(null),
              loosened: ['risk.irreversible'],
              backup: 'C:\\Users\\teste\\.agents-hub\\config.json.bak-20260926-101010',
            },
      );
    }
    if (req.method === 'PUT' && /^\/projects\/prj_[a-z0-9]+\/policy$/i.test(p)) {
      return json(
        res,
        200,
        dryRun
          ? {
              dryRun: true,
              clamped: ['risk.irreversible'],
              ignoredExecFields: [],
              effective: POLITICA_EFETIVA,
            }
          : {
              project: politica('prj_alfa').project,
              clamped: ['risk.irreversible'],
              ignoredExecFields: [],
            },
      );
    }
    if (/^\/integrations\/[a-z0-9-]+\/(hook|mcp)$/i.test(p)) {
      const b = (body ?? {}) as { dryRun?: boolean };
      return json(
        res,
        200,
        b.dryRun === false
          ? {
              dryRun: false,
              plan: PLANO,
              backup: 'C:\\Users\\teste\\.claude\\settings.json.bak-20260926-101010',
            }
          : { dryRun: true, plan: PLANO },
      );
    }
    // O resto não é exercido pelo teste; responder algo plausível evita
    // toasts de erro que mudariam o layout medido.
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
  if (p === '/projects') return json(res, 200, { projects: [...PROJETOS, ...PROJETOS_CRIADOS] });
  if (p === '/health')
    return json(res, 200, {
      ok: true,
      version: '0.1.0',
      now: new Date().toISOString(),
      liveSessions: 3,
      subscribers: 1,
    });
  if (p === '/discovery') return json(res, 200, { agents: DESCOBERTA });

  let m = /^\/sessions\/(ses_[a-z0-9]+)\/events$/i.exec(p);
  if (m) return json(res, 200, { events: eventosDe(m[1]!) });
  m = /^\/sessions\/(ses_[a-z0-9]+)$/i.exec(p);
  if (m) {
    const s = SESSOES.find((x) => x.id === m![1]);
    return s
      ? json(res, 200, { session: s, live: true })
      : json(res, 404, { error: { code: 'NOT_FOUND' } });
  }
  m = /^\/graph\/(ses_[a-z0-9]+)$/i.exec(p);
  if (m) return json(res, 200, { graph: grafoDe(m[1]!) });
  if (/^\/budget\/ses_[a-z0-9]+$/i.test(p)) return json(res, 200, { budget: ORCAMENTO });
  // O beta falha ao carregar o contexto: exercita o estado de erro das Configurações.
  if (p === '/projects/prj_beta/context') {
    return json(res, 500, { error: { code: 'INTERNAL', message: 'falha simulada ao ler o contexto' } });
  }
  if (/^\/projects\/prj_[a-z0-9]+\/context$/i.test(p)) {
    return json(res, 200, { context: { memory: 'Usar TypeScript estrito.' }, repo: REPO });
  }
  if (p === '/policy') return json(res, 200, { policy: politica(url.searchParams.get('projectId')) });
  if (p === '/audit') {
    CONSULTAS_DE_AUDITORIA.push(url.search);
    return json(res, 200, { entries: auditoria(url.searchParams.get('kind')) });
  }
  if (p === '/integrations') return json(res, 200, integracoes());

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

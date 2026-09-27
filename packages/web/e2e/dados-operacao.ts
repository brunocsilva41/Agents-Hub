/**
 * Rotas da aba Operação no servidor falso do e2e (item 6.12).
 *
 * Respostas no formato do daemon, com textos longos (caminhos, objetivos) para
 * estressar o layout. As escritas devolvem o que o daemon devolveria, para o
 * teste ver o estado de sucesso de verdade — não um `{ok:true}` genérico.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

const agora = Date.now();
const ha = (min: number): string => new Date(agora - min * 60_000).toISOString();

function json(res: ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

async function corpoDe(req: IncomingMessage): Promise<Record<string, unknown>> {
  const partes: Buffer[] = [];
  for await (const c of req) partes.push(c as Buffer);
  const texto = Buffer.concat(partes).toString('utf8');
  try {
    return texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const PATCH = [
  'diff --git a/src/auth/provedores/sso-com-rotacao-de-chaves-e-provedores-externos.ts b/src/auth/provedores/sso-com-rotacao-de-chaves-e-provedores-externos.ts',
  'index 1111111..2222222 100644',
  '--- a/src/auth/provedores/sso-com-rotacao-de-chaves-e-provedores-externos.ts',
  '+++ b/src/auth/provedores/sso-com-rotacao-de-chaves-e-provedores-externos.ts',
  '@@ -1,4 +1,6 @@',
  " import { rotacionar } from './chaves';",
  '-export const TTL = 60;',
  '+export const TTL = 3600; // uma linha bem comprida para testar a rolagem horizontal do bloco de diff sem estourar a página',
  '+export const PROVEDORES = ["okta", "azure-ad", "google"];',
  ' export function sso() {}',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -10 +10 @@',
  '-SSO: em breve',
  '+SSO: suportado',
  '',
].join('\n');

let orcamento = {
  limits: { usd: 2, tokens: 500000, seconds: 3600 },
  consumed: { usd: 0.8462, tokens: 96426, seconds: 812 },
  reserved: { usd: 0.5, tokens: 0, seconds: 0 },
  remaining: { usd: 0.6538, tokens: 403574, seconds: 2788 },
  pressure: 0.67,
  exhausted: false,
  isWarning: true,
};

let pastas = [
  { id: 'pfd_prj_alfa', projectId: 'prj_alfa', path: 'C:\\projetos\\alfa', label: null, isPrimary: true, createdAt: ha(600) },
  {
    id: 'pfd_docs1',
    projectId: 'prj_alfa',
    path: 'C:\\projetos\\alfa-documentacao-compartilhada-com-um-nome-de-pasta-bem-comprido',
    label: 'docs',
    isPrimary: false,
    createdAt: ha(300),
  },
];

const RUN_ANTIGA = {
  id: 'wfr_antiga1',
  name: 'plano-e-execucao',
  description: null,
  projectId: 'prj_alfa',
  state: 'failed',
  budgetUsd: 3,
  batches: [['plano'], ['execucao']],
  currentBatch: null,
  steps: [
    { stepId: 'plano', agent: 'claude', dependsOn: [], state: 'completed', sessionId: 'ses_raiz1', taskId: 'tsk_a', summary: 'Plano escrito em PLANO.md', detail: null, usd: 0.42, capUsd: 1.5 },
    { stepId: 'execucao', agent: 'codex', dependsOn: ['plano'], state: 'blocked', sessionId: 'ses_filho1', taskId: 'tsk_b', summary: null, detail: 'esperando aprovação: executar: npm run migrate -- --env=producao --force', usd: 0.1, capUsd: 1.08 },
  ],
  totalUsd: 0.52,
  startedAt: ha(30),
  endedAt: ha(20),
  error: null,
};
const execucoes: Array<Record<string, unknown>> = [RUN_ANTIGA];

/** Responde às rotas da aba Operação. `true` = respondeu. */
export async function rotearOperacao(req: IncomingMessage, res: ServerResponse, p: string): Promise<boolean> {
  const m = req.method ?? 'GET';
  let r: RegExpExecArray | null;

  if (m === 'GET' && (r = /^\/sessions\/(ses_[a-z0-9]+)\/tasks$/i.exec(p))) {
    json(res, 200, {
      tasks: [
        {
          id: 'tsk_a',
          sessionId: r[1],
          requesterSessionId: null,
          state: 'failed',
          brief: {
            agent: 'claude',
            objective: 'Refatorar o módulo de autenticação inteiro para suportar SSO com provedores externos e rotação de chaves',
            acceptanceCriteria: ['testes passam'],
          },
          attempts: [
            { n: 1, agentId: 'claude', outcome: 'failed', error: null },
            { n: 2, agentId: 'codex', outcome: 'failed', error: null },
          ],
          result: {
            summary: 'Refatoração feita; a validação reprovou um teste de integração.',
            artifacts: [],
            usage: { usd: 0.4231, tokens: 48213, seconds: 312 },
            validation: { passed: false, checks: [{ name: 'npm test', passed: false, detail: '3 testes falharam em auth.spec.ts' }] },
          },
          createdAt: ha(9),
          updatedAt: ha(2),
        },
      ],
    });
    return true;
  }
  if (m === 'GET' && (r = /^\/sessions\/(ses_[a-z0-9]+)\/artifacts$/i.exec(p))) {
    json(res, 200, {
      artifacts: [
        { id: 'art_1', sessionId: r[1], taskId: 'tsk_a', kind: 'diff', path: 'C:\\Users\\alguem\\.agents-hub\\artifacts\\ses_raiz1\\alteracoes-da-sessao-completas.patch', createdAt: ha(3) },
        { id: 'art_2', sessionId: r[1], taskId: 'tsk_a', kind: 'log', path: 'C:\\Users\\alguem\\.agents-hub\\artifacts\\ses_raiz1\\validacao.log', createdAt: ha(2) },
      ],
    });
    return true;
  }
  if (m === 'GET' && /^\/sessions\/ses_[a-z0-9]+\/diff$/i.test(p)) {
    json(res, 200, { diff: PATCH, path: 'C:\\Users\\alguem\\.agents-hub\\artifacts\\ses_raiz1\\alteracoes-da-sessao-completas.patch' });
    return true;
  }
  if (m === 'PUT' && /^\/budget\/ses_[a-z0-9]+$/i.test(p)) {
    const { limits } = await corpoDe(req);
    orcamento = { ...orcamento, limits: { ...orcamento.limits, ...((limits ?? {}) as Partial<typeof orcamento.limits>) } };
    json(res, 200, { budget: orcamento });
    return true;
  }
  if (m === 'GET' && /^\/budget\/ses_[a-z0-9]+$/i.test(p) && orcamento.limits.usd !== 2) {
    // Depois de uma edição, a leitura devolve o teto novo (antes dela, o servidor falso padrão responde).
    json(res, 200, { budget: orcamento });
    return true;
  }
  if (m === 'POST' && p === '/workflows/validate') {
    const { yaml } = await corpoDe(req);
    const texto = typeof yaml === 'string' ? yaml : '';
    if (texto.includes('dependsOn: [inexistente]')) {
      json(res, 200, { valid: false, errors: ['Step "b" depende de step inexistente: "inexistente"'], workflow: null, executionOrder: [] });
    } else {
      json(res, 200, {
        valid: true,
        errors: [],
        workflow: { name: 'plano-e-execucao', description: null, steps: [{ id: 'plano', agent: 'claude', dependsOn: [] }, { id: 'execucao', agent: 'codex', dependsOn: ['plano'] }] },
        executionOrder: [['plano'], ['execucao']],
      });
    }
    return true;
  }
  if (m === 'POST' && p === '/workflows/runs') {
    const body = await corpoDe(req);
    const run = {
      ...RUN_ANTIGA,
      id: `wfr_nova${execucoes.length}`,
      projectId: body['projectId'],
      state: 'running',
      budgetUsd: body['budgetUsd'] ?? null,
      currentBatch: 0,
      steps: RUN_ANTIGA.steps.map((s, i) => ({ ...s, state: i === 0 ? 'running' : 'pending', summary: null, detail: null, usd: 0, sessionId: i === 0 ? 'ses_raiz1' : null })),
      totalUsd: 0,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    execucoes.unshift(run);
    json(res, 201, { run });
    return true;
  }
  if (m === 'GET' && p === '/workflows/runs') {
    json(res, 200, { runs: execucoes });
    return true;
  }
  if (m === 'POST' && p === '/agents/probe') {
    json(res, 200, {
      probes: ['claude', 'codex', 'copilot', 'opencode', 'cursor'].map((id) => ({
        agentId: id,
        installed: id !== 'cursor',
        version: id !== 'cursor' ? '1.0.0' : null,
        binPath: null,
        error: null,
        checkedAt: new Date().toISOString(),
      })),
    });
    return true;
  }
  if (m === 'POST' && p === '/maintenance/sweep') {
    json(res, 200, {
      sweep: {
        examined: 4,
        removed: ['C:\\projetos\\alfa\\.agents-hub\\worktrees\\ses_velha1-um-caminho-de-worktree-bem-comprido'],
        retained: 2,
        failed: [{ path: 'C:\\projetos\\beta\\.agents-hub\\worktrees\\ses_travada', reason: 'arquivo em uso por outro processo' }],
      },
    });
    return true;
  }
  if ((r = /^\/projects\/(prj_[a-z0-9]+)\/folders$/i.exec(p))) {
    if (m === 'GET') {
      json(res, 200, { folders: pastas.filter((f) => f.projectId === r![1]) });
      return true;
    }
    if (m === 'POST') {
      const body = await corpoDe(req);
      const folder = { id: `pfd_nova${pastas.length}`, projectId: r[1]!, path: String(body['path']), label: typeof body['label'] === 'string' ? body['label'] : null, isPrimary: false, createdAt: new Date().toISOString() };
      pastas = [...pastas, folder];
      json(res, 201, { folder });
      return true;
    }
  }
  if (m === 'DELETE' && (r = /^\/projects\/prj_[a-z0-9]+\/folders\/(pfd_[a-z0-9_]+)$/i.exec(p))) {
    pastas = pastas.filter((f) => f.id !== r![1]);
    json(res, 200, { ok: true });
    return true;
  }
  if (m === 'POST' && p === '/sessions/adopt') {
    const body = await corpoDe(req);
    json(res, 201, { session: { id: 'ses_adotada9', agentId: body['agentId'], projectId: body['projectId'], adopted: true, state: 'running' } });
    return true;
  }
  return false;
}

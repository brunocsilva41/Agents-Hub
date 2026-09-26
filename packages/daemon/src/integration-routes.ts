import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HubError } from '@agents-hub/core';
import type { AuditTrail } from './audit.js';
import { readJsonBody } from './http-body.js';
import { ProjectIdSchema } from './http-schemas.js';
import {
  aplicarIntegracao,
  entrypoints,
  estadoDasIntegracoes,
  planejarIntegracao,
  type IntegracoesDeps,
} from './integrations.js';
import { operatorOf } from './operator-auth.js';
import type { RouteRegistrar } from './operator-routes.js';

/**
 * Rotas de integração (hook do gate e MCP) para o painel — item 6.12 do GOAL.
 *
 * | Rota                                  | Token | Efeito                          |
 * |---------------------------------------|-------|---------------------------------|
 * | GET  /integrations[?projectId=]       | não   | estado por agente (só leitura)  |
 * | POST /integrations/:agentId/:tipo     | sim   | prévia (`dryRun`, padrão) ou    |
 * |                                       |       | gravação com o `base` da prévia |
 *
 * A prévia também exige token: ela lê a config de outras ferramentas e manda
 * um pedaço dela ao navegador (com credenciais mascaradas, mas ainda assim).
 */

const AgentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'id de agente inválido');

const CorpoSchema = z
  .object({
    projectId: ProjectIdSchema.optional(),
    /** Ausente = prévia. Gravar exige `false` explícito E o `base` da prévia. */
    dryRun: z.boolean().optional(),
    base: z.string().min(1).max(200).optional(),
  })
  .strict();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export interface IntegrationRouteDeps {
  deps: () => IntegracoesDeps;
  agentIds: () => string[];
  /** Caminho do projeto (lança PROJECT_NOT_FOUND). */
  projectPath: (projectId: string) => string;
  audit: AuditTrail;
}

export function registerIntegrationRoutes(route: RouteRegistrar, d: IntegrationRouteDeps): void {
  route('GET', '/integrations', (req, res) => {
    const q = new URL(req.url ?? '/', 'http://local').searchParams;
    const bruto = q.get('projectId');
    let projectPath: string | undefined;
    if (bruto) {
      const parsed = ProjectIdSchema.safeParse(bruto);
      if (!parsed.success) {
        throw new HubError('INVALID_QUERY', 'parâmetro "projectId" inválido', { valor: bruto });
      }
      projectPath = d.projectPath(parsed.data);
    }
    const deps = d.deps();
    sendJson(res, 200, {
      entrypoints: entrypoints(deps),
      integrations: estadoDasIntegracoes(deps, d.agentIds(), projectPath),
    });
  });

  route(
    'POST',
    '/integrations/:agentId/:tipo',
    async (req, res, params) => {
      const agent = AgentIdSchema.safeParse(params['agentId']);
      if (!agent.success) {
        throw new HubError('INVALID_QUERY', 'agente inválido', { valor: params['agentId'] });
      }
      const tipo = params['tipo'];
      if (tipo !== 'hook' && tipo !== 'mcp') {
        throw new HubError('INVALID_QUERY', 'tipo de integração inválido (hook ou mcp)', {
          valor: tipo,
        });
      }
      const parsed = CorpoSchema.safeParse(await readJsonBody(req));
      if (!parsed.success) {
        throw new HubError('INVALID_BRIEF', 'corpo da requisição inválido', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const body = parsed.data;
      const projectPath = body.projectId ? d.projectPath(body.projectId) : undefined;
      const deps = d.deps();

      // `?? true`: ausência de dryRun NUNCA pode significar "grave".
      if (body.dryRun ?? true) {
        sendJson(res, 200, {
          dryRun: true,
          plan: planejarIntegracao(deps, agent.data, tipo, projectPath),
        });
        return;
      }
      if (body.base === undefined) {
        throw new HubError(
          'INVALID_BRIEF',
          'gravar exige o "base" devolvido pela prévia — confirme o diff antes',
          { issues: [{ path: 'base', message: 'obrigatório com dryRun: false' }] },
        );
      }
      const { plano, backup } = aplicarIntegracao(deps, agent.data, tipo, body.base, projectPath);
      d.audit.record({
        actor: operatorOf(req)?.by ?? 'desconhecido',
        kind: 'integration.install',
        ...(body.projectId ? { projectId: body.projectId } : {}),
        action: `instalar ${tipo} do Hub em ${agent.data}`,
        decision: plano.acao === 'nada' ? 'unchanged' : 'written',
        reason: null,
        detail: { agentId: agent.data, tipo, arquivo: plano.arquivo, backup },
      });
      sendJson(res, 200, { dryRun: false, plan: plano, backup });
    },
    { operator: true },
  );
}

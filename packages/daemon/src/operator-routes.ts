import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { AUDIT_KINDS, HubError, type AuditFilter, type AuditKind } from '@agents-hub/core';
import type { AuditTrail } from './audit.js';
import { readJsonBody } from './http-body.js';
import { ProjectIdSchema, SessionIdSchema } from './http-schemas.js';
import { operatorOf } from './operator-auth.js';
import type { PolicyService } from './policy-service.js';

/**
 * Rotas do editor de política e da auditoria (item 1.10 do GOAL), fora de
 * `server.ts` para a mudança lá ficar pequena. As de escrita são registradas
 * com `operator: true`: o despacho do servidor exige o token ANTES de chegar
 * aqui, e `operatorOf(req)` diz quem foi.
 *
 * | Rota                         | Token | Efeito                                   |
 * |------------------------------|-------|------------------------------------------|
 * | GET  /policy[?projectId=]    | não   | camadas + política efetiva (+ projeto)   |
 * | PUT  /policy                 | sim   | substitui a camada global                |
 * | PUT  /projects/:id/policy    | sim   | substitui a camada do projeto (clamp)    |
 * | (as duas com `?dryRun=1`)    | sim   | só valida e prevê loosened/clamped       |
 * | GET  /audit                  | não   | trilha (sessionId, projectId, kind,      |
 * |                              |       | since, until, limit)                     |
 */

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;

export type RouteRegistrar = (
  method: string,
  path: string,
  handler: Handler,
  opts?: { operator?: boolean },
) => void;

const PolicyBodySchema = z.object({ policy: z.unknown() }).strict();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** `?dryRun=1` (ou `true`): prévia, nada é gravado nem auditado. */
function ehPrevia(req: IncomingMessage): boolean {
  const v = new URL(req.url ?? '/', 'http://local').searchParams.get('dryRun');
  return v === '1' || v === 'true';
}

function validar<T>(schema: z.ZodType<T>, valor: unknown, nome: string): T {
  const parsed = schema.safeParse(valor);
  if (!parsed.success) {
    throw new HubError('INVALID_QUERY', `parâmetro "${nome}" inválido`, {
      valor,
      message: parsed.error.issues[0]?.message,
    });
  }
  return parsed.data;
}

async function lerCorpoDePolitica(req: IncomingMessage): Promise<unknown> {
  const parsed = PolicyBodySchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    throw new HubError('INVALID_BRIEF', 'corpo da requisição inválido — esperado {"policy": {...}}', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data.policy;
}

/**
 * Instante do filtro de auditoria: ISO 8601 ou relativo (`30m`, `2h`, `7d`),
 * que é o que se digita na CLI. Normalizado para ISO para comparar como texto
 * com a coluna `ts`.
 */
export function instanteDoFiltro(valor: string, agora = Date.now()): string {
  const rel = /^(\d+)\s*(s|m|h|d)$/i.exec(valor.trim());
  if (rel) {
    const n = Number(rel[1]);
    const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      rel[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd'
    ];
    return new Date(agora - n * mult).toISOString();
  }
  const t = Date.parse(valor);
  if (!Number.isFinite(t)) {
    throw new HubError('INVALID_QUERY', `instante inválido: "${valor}" (use ISO 8601 ou 30m/2h/7d)`, {
      valor,
    });
  }
  return new Date(t).toISOString();
}

export function registerOperatorRoutes(
  route: RouteRegistrar,
  deps: { policy: PolicyService; audit: AuditTrail },
): void {
  const { policy, audit } = deps;

  route('GET', '/policy', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const projectId = url.searchParams.get('projectId');
    sendJson(res, 200, {
      policy: policy.view(
        projectId === null ? undefined : validar(ProjectIdSchema, projectId, 'projectId'),
      ),
    });
  });

  route(
    'PUT',
    '/policy',
    async (req, res) => {
      const layer = await lerCorpoDePolitica(req);
      if (ehPrevia(req)) {
        sendJson(res, 200, { dryRun: true, ...policy.previewGlobalLayer(layer) });
        return;
      }
      const result = policy.setGlobalLayer(layer);
      audit.record({
        actor: operatorOf(req)?.by ?? 'desconhecido',
        kind: 'policy.updated',
        action: 'PUT /policy (camada global)',
        decision: result.loosened.length > 0 ? 'loosened' : 'updated',
        reason: result.loosened.length > 0 ? `afrouxa: ${result.loosened.join(', ')}` : null,
        detail: { scope: 'global', layer: result.view.global.layer, loosened: result.loosened },
      });
      sendJson(res, 200, {
        policy: result.view,
        loosened: result.loosened,
        backup: result.backup,
      });
    },
    { operator: true },
  );

  route(
    'PUT',
    '/projects/:id/policy',
    async (req, res, params) => {
      const projectId = validar(ProjectIdSchema, params['id'], 'id');
      const layer = await lerCorpoDePolitica(req);
      if (ehPrevia(req)) {
        sendJson(res, 200, { dryRun: true, ...policy.previewProjectLayer(projectId, layer) });
        return;
      }
      const project = policy.setProjectLayer(projectId, layer);
      audit.record({
        actor: operatorOf(req)?.by ?? 'desconhecido',
        kind: 'policy.updated',
        projectId,
        action: `PUT /projects/${projectId}/policy`,
        decision: 'updated',
        reason:
          project.clamped.length > 0 ? `sem efeito pelo clamp: ${project.clamped.join(', ')}` : null,
        detail: {
          scope: 'project',
          layer: project.layer,
          clamped: project.clamped,
          ignoredExecFields: project.ignoredExecFields,
        },
      });
      sendJson(res, 200, {
        project,
        clamped: project.clamped,
        ignoredExecFields: project.ignoredExecFields,
      });
    },
    { operator: true },
  );

  route('GET', '/audit', (req, res) => {
    const q = new URL(req.url ?? '/', 'http://local').searchParams;
    const filter: AuditFilter = {};
    const sessionId = q.get('sessionId');
    if (sessionId) filter.sessionId = validar(SessionIdSchema, sessionId, 'sessionId');
    const projectId = q.get('projectId');
    if (projectId) filter.projectId = validar(ProjectIdSchema, projectId, 'projectId');
    const kind = q.get('kind');
    if (kind) {
      filter.kind = validar(
        z.enum(AUDIT_KINDS as [AuditKind, ...AuditKind[]]),
        kind,
        'kind',
      );
    }
    const since = q.get('since');
    if (since) filter.since = instanteDoFiltro(since);
    const until = q.get('until');
    if (until) filter.until = instanteDoFiltro(until);
    const limit = q.get('limit');
    if (limit !== null) {
      filter.limit = validar(z.coerce.number().int().min(1).max(5000), limit, 'limit');
    }
    sendJson(res, 200, { entries: audit.list(filter) });
  });
}

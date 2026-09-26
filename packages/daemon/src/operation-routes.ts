import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HubError } from '@agents-hub/core';
import type { AuditTrail } from './audit.js';
import { readJsonBody } from './http-body.js';
import { ProjectIdSchema, SessionIdSchema } from './http-schemas.js';
import { operatorOf } from './operator-auth.js';
import type { RouteRegistrar } from './operator-routes.js';
import type { SessionManager } from './session-manager.js';
import { validarWorkflowYaml, WORKFLOW_YAML_MAX, type WorkflowRunner } from './workflow-runs.js';

/**
 * Rotas de operação do painel (item 6.12 do GOAL), fora de `server.ts` pelo
 * mesmo motivo de `operator-routes.ts`: a mudança lá fica em uma linha.
 *
 * | Rota                          | Token | Efeito                                  |
 * |-------------------------------|-------|-----------------------------------------|
 * | PUT  /budget/:rootId          | sim   | redefine o teto do fluxo (só na raiz)   |
 * | POST /workflows/validate      | não   | valida YAML (sintaxe, deps, ciclos)     |
 * | POST /workflows/runs          | não   | dispara no daemon (como POST /sessions) |
 * | GET  /workflows/runs[/:id]    | não   | progresso por passo                     |
 *
 * Disparar workflow não exige token pela mesma razão que `POST /sessions` não
 * exige: é criar sessões, cada uma sob a política e o orçamento de sempre. O
 * teto, ao contrário, é um freio de segurança — mexer nele é do operador.
 */

const LimiteSchema = z.number().finite().positive();

const BudgetEditSchema = z
  .object({
    limits: z
      .object({
        usd: LimiteSchema.max(1_000_000).optional(),
        tokens: LimiteSchema.int().max(1_000_000_000).optional(),
        seconds: LimiteSchema.int().max(30 * 24 * 3600).optional(),
      })
      .strict()
      .refine((l) => l.usd !== undefined || l.tokens !== undefined || l.seconds !== undefined, {
        message: 'informe ao menos um de usd, tokens, seconds',
      }),
  })
  .strict();

const WorkflowYamlSchema = z.string().min(1, 'o workflow está vazio').max(WORKFLOW_YAML_MAX);

const ValidateSchema = z.object({ yaml: WorkflowYamlSchema }).strict();

const RunSchema = z
  .object({
    yaml: WorkflowYamlSchema,
    projectId: ProjectIdSchema,
    budgetUsd: z.number().finite().positive().max(1_000_000).optional(),
  })
  .strict();

const RunIdSchema = z.string().regex(/^wfr_[a-z0-9]{1,60}$/i, 'id deve começar com "wfr_"');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function corpo<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    throw new HubError('INVALID_BRIEF', 'corpo da requisição inválido', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

function parametro<T>(valor: string | undefined, schema: z.ZodType<T>, nome: string): T {
  const parsed = schema.safeParse(valor ?? '');
  if (!parsed.success) {
    throw new HubError('INVALID_ID', `parâmetro "${nome}" inválido`, {
      valor,
      message: parsed.error.issues[0]?.message,
    });
  }
  return parsed.data;
}

export function registerOperationRoutes(
  route: RouteRegistrar,
  deps: { sessions: SessionManager; audit: AuditTrail; workflows: WorkflowRunner },
): void {
  const { sessions, audit, workflows } = deps;

  route(
    'PUT',
    '/budget/:rootId',
    async (req, res, params) => {
      const rootId = parametro(params['rootId'], SessionIdSchema, 'rootId');
      const { limits } = await corpo(req, BudgetEditSchema);
      // A validação (existe, é raiz, não fica abaixo do comprometido) mora no
      // SessionManager — ler o ledger antes dela criaria um órfão para id ruim.
      const { before, budget } = sessions.setBudgetLimits(rootId, limits);
      audit.record({
        actor: operatorOf(req)?.by ?? 'desconhecido',
        kind: 'budget.updated',
        sessionId: rootId,
        action: `PUT /budget/${rootId}`,
        decision: 'updated',
        detail: { antes: before, depois: budget.limits },
      });
      sendJson(res, 200, { budget });
    },
    { operator: true },
  );

  route('POST', '/workflows/validate', async (req, res) => {
    const { yaml } = await corpo(req, ValidateSchema);
    const { parsed: _parsed, ...validacao } = validarWorkflowYaml(yaml);
    sendJson(res, 200, validacao);
  });

  route('POST', '/workflows/runs', async (req, res) => {
    const body = await corpo(req, RunSchema);
    sendJson(res, 201, {
      run: workflows.start({
        yaml: body.yaml,
        projectId: body.projectId,
        ...(body.budgetUsd === undefined ? {} : { budgetUsd: body.budgetUsd }),
      }),
    });
  });

  route('GET', '/workflows/runs', (_req, res) => {
    sendJson(res, 200, { runs: workflows.list() });
  });

  route('GET', '/workflows/runs/:id', (_req, res, params) => {
    sendJson(res, 200, { run: workflows.get(parametro(params['id'], RunIdSchema, 'id')) });
  });
}

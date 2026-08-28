import { z } from 'zod';

/**
 * Contratos de entrada da API.
 *
 * Antes disto, `readJson<T>` fazia um cast cego: um corpo malformado só
 * explodia lá dentro do `SessionManager`, com uma mensagem que não dizia o que
 * estava errado na requisição. Validar na borda transforma isso num 422 que
 * aponta o campo — e impede que dado torto chegue perto do domínio.
 */

/** Ids do Hub têm prefixo e são gerados por nós; qualquer outra coisa é ruído. */
const hubId = (prefixo: string): z.ZodString =>
  z
    .string()
    .min(1)
    .max(64)
    .regex(new RegExp(`^${prefixo}_[a-z0-9]+$`, 'i'), `id deve começar com "${prefixo}_"`);

export const SessionIdSchema = hubId('ses');
export const TaskIdSchema = hubId('tsk');
export const ApprovalIdSchema = hubId('apv');
export const ProjectIdSchema = hubId('prj');

export const BudgetInputSchema = z
  .object({
    usd: z.number().positive().max(10_000).optional(),
    tokens: z.number().int().positive().max(1_000_000_000).optional(),
    seconds: z.number().int().positive().max(86_400).optional(),
  })
  .strict();

export const CreateProjectSchema = z
  .object({
    path: z.string().min(1).max(4096),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

export const StartSessionSchema = z
  .object({
    projectId: ProjectIdSchema,
    // O Brief tem schema próprio no domínio (`parseBrief`); aqui só garantimos
    // que é objeto, para a mensagem de erro vir do lugar certo.
    brief: z.record(z.unknown()),
    requesterSessionId: SessionIdSchema.nullable().optional(),
    title: z.string().max(500).optional(),
  })
  .strict();

export const AdoptSessionSchema = z
  .object({
    agentId: z.string().min(1).max(64),
    projectPath: z.string().max(4096).optional(),
    projectId: ProjectIdSchema.optional(),
    title: z.string().max(500).optional(),
    budget: BudgetInputSchema.optional(),
  })
  .strict();

export const DelegateSchema = z
  .object({
    brief: z.record(z.unknown()),
    projectId: ProjectIdSchema.optional(),
  })
  .strict();

export const SendMessageSchema = z
  .object({
    // Limite generoso mas finito: sem teto, um cliente com bug empurra o
    // processo do agente para um prompt de megabytes.
    text: z.string().min(1).max(200_000),
  })
  .strict();

export const CancelSchema = z
  .object({ reason: z.string().max(1000).optional() })
  .strict();

export const ResolveApprovalSchema = z
  .object({
    decision: z.enum(['approved', 'denied']),
    by: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * Consulta do gate pré-execução.
 *
 * Campos em snake_case porque vêm direto do hook do agente — traduzir na CLI
 * seria mais um lugar para o contrato divergir em silêncio.
 */
export const PreToolGateSchema = z
  .object({
    /** Id da sessão do Hub, quando o hook conseguiu herdá-lo do ambiente. */
    sessionId: SessionIdSchema.optional(),
    /** Id nativo do agente (o `session_id` do Claude Code, por exemplo). */
    nativeSessionId: z.string().min(1).max(200).optional(),
    cwd: z.string().max(4096).optional(),
    toolName: z.string().min(1).max(200),
    toolInput: z.record(z.unknown()).default({}),
  })
  .strict();

/** Query params chegam como texto e podem ser lixo; NaN vira ausência. */
export function inteiroOpcional(valor: string | null, max: number): number | undefined {
  if (valor === null) return undefined;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Math.floor(n), max);
}

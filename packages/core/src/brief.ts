import { z } from 'zod';
import { HubError } from './errors.js';

/**
 * O Brief é o contrato de delegação (ADR 03.4).
 *
 * A decisão foi passar contexto por *brief explícito + referências*, nunca por
 * transcript inteiro: o agente filho começa limpo, sem herdar os becos sem
 * saída do pai, e o custo da delegação fica previsível.
 */
export const ArtifactRefSchema = z.object({
  path: z.string().min(1),
  mode: z.enum(['read', 'write']).default('read'),
  note: z.string().optional(),
});

export const BudgetRequestSchema = z.object({
  usd: z.number().positive().optional(),
  tokens: z.number().int().positive().optional(),
  seconds: z.number().int().positive().optional(),
});

export const BriefSchema = z.object({
  /**
   * Alvo da delegação: id de agente (`"codex"`) ou capability (`"cap:test-writing"`).
   * Capability só é resolvida se o roteamento por capacidade estiver habilitado.
   */
  agent: z.string().min(1),

  /** Um objetivo, no imperativo. Se precisar de "e", provavelmente são duas tasks. */
  objective: z.string().min(8, 'o objetivo precisa ser descritivo'),

  /** Como o pai valida que o filho entregou. Sem isto, não há portão de validação. */
  acceptanceCriteria: z.array(z.string().min(1)).default([]),

  constraints: z.array(z.string().min(1)).default([]),

  artifacts: z.array(ArtifactRefSchema).default([]),

  /** Ponteiros (`session:<id>#event:<seq>`), nunca conteúdo embutido. */
  contextRefs: z.array(z.string().min(1)).default([]),

  budget: BudgetRequestSchema.default({}),

  isolation: z.enum(['none', 'worktree', 'container']).default('worktree'),

  mode: z.enum(['async', 'stream']).default('async'),

  /** Sobrescreve o modo de supervisão — só é aceito se não escalar o do pai. */
  supervision: z.enum(['supervised', 'semi', 'autonomous']).optional(),

  labels: z.record(z.string()).default({}),
});

export type Brief = z.infer<typeof BriefSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type BudgetRequest = z.infer<typeof BudgetRequestSchema>;

export function parseBrief(input: unknown): Brief {
  const result = BriefSchema.safeParse(input);
  if (!result.success) {
    throw new HubError('INVALID_BRIEF', 'Brief inválido', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

/**
 * Renderiza o Brief como prompt para o agente. É a única tradução
 * Brief → texto no sistema; mantê-la em um lugar só garante que todos os
 * oito agentes recebam a tarefa exatamente com a mesma estrutura.
 */
export function renderBriefAsPrompt(brief: Brief): string {
  const lines: string[] = [`# Tarefa`, ``, brief.objective, ``];

  if (brief.acceptanceCriteria.length > 0) {
    lines.push(`## Critérios de aceite`, ``);
    for (const c of brief.acceptanceCriteria) lines.push(`- ${c}`);
    lines.push(``);
  }

  if (brief.constraints.length > 0) {
    lines.push(`## Restrições`, ``);
    for (const c of brief.constraints) lines.push(`- ${c}`);
    lines.push(``);
  }

  if (brief.artifacts.length > 0) {
    lines.push(`## Artefatos`, ``);
    for (const a of brief.artifacts) {
      lines.push(`- \`${a.path}\` (${a.mode})${a.note ? ` — ${a.note}` : ''}`);
    }
    lines.push(``);
  }

  if (brief.contextRefs.length > 0) {
    lines.push(`## Contexto disponível`, ``);
    lines.push(
      `Use a ferramenta \`hub_context_fetch\` do Agents-Hub para buscar estas referências se precisar:`,
      ``,
    );
    for (const r of brief.contextRefs) lines.push(`- ${r}`);
    lines.push(``);
  }

  lines.push(
    `## Ao terminar`,
    ``,
    `Responda com um resumo curto do que foi feito e o que ficou pendente. ` +
      `Liste os arquivos que você alterou.`,
  );

  return lines.join('\n');
}

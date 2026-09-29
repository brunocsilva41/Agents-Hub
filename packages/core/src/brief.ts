import { z } from 'zod';
import { HubError } from './errors.js';

/**
 * O Brief é o contrato de delegação (ADR 03.4).
 *
 * A decisão foi passar contexto por *brief explícito + referências*, nunca por
 * transcript inteiro: o agente filho começa limpo, sem herdar os becos sem
 * saída do pai, e o custo da delegação fica previsível.
 */
/*
 * Tetos (vistoria 2026-09-25, R09-13). O Brief chegava sem limite nenhum: um
 * objetivo de 1 MB, 10k critérios, `agent: '   '`, orçamento `Infinity` e
 * artefato `../../../etc/passwd` eram válidos. Os números batem com o teto do
 * workflow (objetivo de 50k) e ficam acima dos do `hub_agent_call` do MCP
 * (20k / 50 itens / 2000 caracteres), que é mais apertado de propósito por
 * vir de um modelo.
 */
export const LIMITE_OBJETIVO_BRIEF = 50_000;
/** Objetivo mais curto que isto não descreve tarefa; o painel usa o mesmo número. */
export const OBJETIVO_MINIMO_BRIEF = 8;
const LIMITE_ITENS = 200;
const LIMITE_ITEM = 4_000;
const item = () => z.string().trim().min(1).max(LIMITE_ITEM);

/**
 * Caminho de artefato: relativo ao diretório da sessão e sem subir dele.
 * Absoluto (`/etc/passwd`, `C:\...`, `\\servidor\x`) e `..` em qualquer
 * segmento são recusados — o agente leria o caminho como pedido do Hub.
 */
export function caminhoDeArtefatoValido(p: string): boolean {
  if (p.includes('\0')) return false;
  if (/^[\\/]/.test(p) || /^[a-zA-Z]:/.test(p)) return false;
  return !p.split(/[\\/]+/).includes('..');
}

export const ArtifactRefSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .refine(caminhoDeArtefatoValido, 'caminho de artefato precisa ser relativo ao projeto, sem ".."'),
  mode: z.enum(['read', 'write']).default('read'),
  note: z.string().max(LIMITE_ITEM).optional(),
});

export const BudgetRequestSchema = z.object({
  usd: z.number().finite().positive().optional(),
  tokens: z.number().int().positive().optional(),
  seconds: z.number().int().positive().optional(),
});

/**
 * Resultado de um passo anterior de workflow, entregue ao passo que depende dele.
 *
 * É o canal de fan-in, e ele existe separado do `objective` pelo mesmo motivo
 * que `ContextoDoProjeto`: o objetivo alimenta `objectiveHash`, que é como o
 * CallGraph detecta ciclo semântico. Concatenar aqui o resultado do passo
 * anterior faria duas execuções do mesmo passo parecerem tarefas diferentes, e
 * a detecção de ciclo passaria a deixar passar o que deveria barrar.
 *
 * Viaja o **resumo**, nunca o transcript (ADR 03.4). Quem precisar do detalhe
 * segue o `sessionRef` por `hub_context_fetch`.
 */
export const UpstreamResultSchema = z.object({
  step: z.string().min(1).max(64),
  agent: z.string().min(1).max(64),
  summary: z.string().max(20_000),
  /** Ponteiro `session:<id>` para quem quiser ir além do resumo. */
  sessionRef: z.string().min(1).max(200).optional(),
});

export const BriefSchema = z.object({
  /**
   * Alvo da delegação: id de agente (`"codex"`) ou capability (`"cap:test-writing"`).
   * Capability só é resolvida se o roteamento por capacidade estiver habilitado.
   */
  agent: z.string().trim().min(1).max(200),

  /** Um objetivo, no imperativo. Se precisar de "e", provavelmente são duas tasks. */
  objective: z
    .string()
    .trim()
    .min(OBJETIVO_MINIMO_BRIEF, 'o objetivo precisa ser descritivo')
    .max(LIMITE_OBJETIVO_BRIEF, `o objetivo passa de ${LIMITE_OBJETIVO_BRIEF} caracteres`),

  /** Como o pai valida que o filho entregou. Sem isto, não há portão de validação. */
  acceptanceCriteria: z.array(item()).max(LIMITE_ITENS).default([]),

  constraints: z.array(item()).max(LIMITE_ITENS).default([]),

  artifacts: z.array(ArtifactRefSchema).max(LIMITE_ITENS).default([]),

  /** Ponteiros (`session:<id>#event:<seq>`), nunca conteúdo embutido. */
  contextRefs: z.array(item()).max(LIMITE_ITENS).default([]),

  /** Fan-in de workflow: o que os passos dos quais este depende entregaram. */
  upstream: z.array(UpstreamResultSchema).max(LIMITE_ITENS).default([]),

  budget: BudgetRequestSchema.default({}),

  isolation: z.enum(['none', 'worktree', 'container']).default('worktree'),

  mode: z.enum(['async', 'stream']).default('async'),

  /** Sobrescreve o modo de supervisão — só é aceito se não escalar o do pai. */
  supervision: z.enum(['supervised', 'semi', 'autonomous']).optional(),

  labels: z.record(z.string()).default({}),
});

export type Brief = z.infer<typeof BriefSchema>;
export type UpstreamResult = z.infer<typeof UpstreamResultSchema>;
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
 * Contexto que vem do projeto, não da tarefa.
 *
 * Existe separado do Brief de propósito. A tentação é concatenar essas
 * diretrizes no `objective`, e a interface chegou a fazer isso — mas o
 * `objective` alimenta `objectiveHash`, que é como o CallGraph detecta ciclo
 * semântico. Misturar diretriz com objetivo faz duas tarefas iguais parecerem
 * diferentes, e a detecção de ciclo passa a deixar passar o que deveria barrar.
 */
export interface ContextoDoProjeto {
  /** Diretrizes que valem para todo agente que trabalha neste projeto. */
  memoria?: string | undefined;
  /** Instruções específicas do agente que vai executar esta tarefa. */
  instrucoesDoAgente?: string | undefined;
}

/**
 * Renderiza o Brief como prompt para o agente. É a única tradução
 * Brief → texto no sistema; mantê-la em um lugar só garante que todos os
 * nove agentes recebam a tarefa exatamente com a mesma estrutura.
 *
 * O contexto do projeto entra ANTES da tarefa: é enquadramento, e enquadramento
 * lido depois da instrução já não enquadra nada. Como todos os caminhos de
 * lançamento passam por aqui — sessão nova, delegação, retry e fallback —, as
 * diretrizes chegam também ao agente que recebeu a tarefa de outro agente, que
 * é justamente onde uma configuração guardada no navegador não chegaria.
 */
export function renderBriefAsPrompt(brief: Brief, contexto?: ContextoDoProjeto): string {
  const lines: string[] = [];

  const memoria = contexto?.memoria?.trim();
  const instrucoes = contexto?.instrucoesDoAgente?.trim();

  if (memoria || instrucoes) {
    lines.push(`# Diretrizes do projeto`, ``);
    if (memoria) lines.push(memoria, ``);
    if (instrucoes) {
      lines.push(`## Instruções para você especificamente`, ``, instrucoes, ``);
    }
    lines.push(`---`, ``);
  }

  lines.push(`# Tarefa`, ``, brief.objective, ``);

  // Vem antes dos critérios porque um objetivo como "refatorar conforme o
  // plano" é ininteligível sem o plano. Antes desta seção existir, o passo
  // dependente de um workflow começava sem saber o que o anterior tinha feito.
  if (brief.upstream.length > 0) {
    lines.push(`## O que os passos anteriores entregaram`, ``);
    for (const u of brief.upstream) {
      // O resumo é SAÍDA de outro agente: entra como citação, linha a linha,
      // para um "# Tarefa" dentro dele não virar cabeçalho do prompt (R09-13).
      lines.push(`### ${umaLinha(u.step)} (${umaLinha(u.agent)})`, ``, citar(u.summary.trim()), ``);
      if (u.sessionRef) {
        lines.push(dimRef(u.sessionRef), ``);
      }
    }
  }

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

/** Texto de terceiro como bloco de citação Markdown (`> ` em cada linha). */
function citar(texto: string): string {
  return texto
    .split(/\r?\n/)
    .map((l) => (l.length > 0 ? `> ${l}` : '>'))
    .join('\n');
}

/** Rótulo curto numa linha só (quebra de linha viraria cabeçalho novo). */
function umaLinha(texto: string): string {
  return texto.replace(/[\r\n]+/g, ' ');
}

/** Ponteiro para o detalhe, para quem tiver a tool de contexto do Hub. */
function dimRef(ref: string): string {
  return `_Detalhe completo em \`${ref}\` (tool \`hub_context_fetch\`)._`;
}

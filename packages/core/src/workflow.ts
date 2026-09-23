import { z } from 'zod';
import { HubError, isHubError } from './errors.js';
import { BriefSchema, type Brief, type UpstreamResult } from './brief.js';
import { sleep as defaultSleep } from './resilience.js';

export const WorkflowStepSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'id do step deve ser alfanumérico'),
  agent: z.string().min(1).max(64),
  objective: z.string().min(1).max(50_000),
  dependsOn: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  budget: z
    .object({
      usd: z.number().positive().optional(),
      tokens: z.number().int().positive().optional(),
      seconds: z.number().int().positive().optional(),
    })
    .default({}),
  supervision: z.enum(['supervised', 'semi', 'autonomous']).optional(),
  isolation: z.enum(['none', 'worktree', 'container']).default('worktree'),
});

export const WorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  version: z.string().default('1.0'),
  steps: z.array(WorkflowStepSchema).min(1, 'o workflow precisa ter pelo menos um step'),
});

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowInput = z.input<typeof WorkflowSchema>;

export function parseWorkflow(input: unknown): Workflow {
  const result = WorkflowSchema.safeParse(input);
  if (!result.success) {
    throw new HubError('ILLEGAL_STATE', 'Workflow inválido', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
  executionOrder: string[][]; // Batches paralelos ordenados topologicamente
}

/**
 * Valida o grafo do Workflow (DAG) e calcula os lotes de execução paralela.
 */
export function validateWorkflow(workflow: Workflow): WorkflowValidationResult {
  const errors: string[] = [];
  const stepIds = new Set<string>();
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>(); // step -> steps that depend on it

  for (const step of workflow.steps) {
    if (stepIds.has(step.id)) {
      errors.push(`Step duplicado: "${step.id}"`);
    }
    stepIds.add(step.id);
    inDegree.set(step.id, 0);
    graph.set(step.id, []);
  }

  for (const step of workflow.steps) {
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) {
        errors.push(`Step "${step.id}" depende de step inexistente: "${dep}"`);
      } else if (dep === step.id) {
        errors.push(`Step "${step.id}" depende de si mesmo (auto-referência)`);
      } else {
        graph.get(dep)!.push(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, executionOrder: [] };
  }

  // Kahn's Algorithm em níveis para identificar batches paralelos
  const executionOrder: string[][] = [];
  let currentBatch: string[] = [];

  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      currentBatch.push(id);
    }
  }

  let processedCount = 0;

  while (currentBatch.length > 0) {
    executionOrder.push(currentBatch);
    processedCount += currentBatch.length;
    const nextBatch: string[] = [];

    for (const stepId of currentBatch) {
      for (const dependent of graph.get(stepId) ?? []) {
        const remaining = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, remaining);
        if (remaining === 0) {
          nextBatch.push(dependent);
        }
      }
    }

    currentBatch = nextBatch;
  }

  if (processedCount < workflow.steps.length) {
    errors.push('Ciclo detectado no grafo de dependências do workflow (deadlock)');
    return { valid: false, errors, executionOrder: [] };
  }

  return { valid: true, errors: [], executionOrder };
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

/**
 * Por que a execução vive aqui, e não na CLI.
 *
 * Ela morava lá, e o resultado foi o defeito mais grave que a vistoria achou:
 * o laço dava `await` em `startSession`, que é **assíncrona por contrato** — o
 * `#launch` do SessionManager termina em `void this.#pump(...)`. O `await`
 * esperava a sessão *nascer*, não o passo *terminar*. Todos os passos subiam
 * praticamente juntos: o agente que devia "refatorar conforme o plano"
 * começava antes de o plano existir, e a ordenação topológica servia só para
 * escolher a ordem dos `console.log`.
 *
 * Trazer isto para o core, em forma pura com dependências injetadas, é o mesmo
 * remédio que `resilience.ts` recebeu: a lógica que mais precisa de teste é a
 * que menos precisa de processo rodando.
 */

/**
 * Só `completed` libera quem depende do passo. As outras quatro são desfechos
 * distintos de propósito: agregá-las em "não deu certo" apagaria justamente a
 * diferença entre o que falhou, o que nunca chegou a rodar e o que ainda está
 * vivo no daemon.
 */
export type WorkflowStepState =
  | 'completed'
  | 'failed'
  /** Dependência não concluiu, ou o orçamento global acabou antes da vez dele. */
  | 'skipped'
  /** Parou numa aprovação humana — a sessão continua viva, esperando decisão. */
  | 'blocked'
  /** A espera estourou. A sessão NÃO foi morta: segue rodando no daemon. */
  | 'timeout';

export interface WorkflowStepResult {
  stepId: string;
  agent: string;
  state: WorkflowStepState;
  sessionId: string | null;
  taskId: string | null;
  summary: string | null;
  /** Por que pulou, falhou ou travou. Nunca vazio quando o estado não é `completed`. */
  detail: string | null;
  usd: number;
}

export interface WorkflowRunResult {
  ok: boolean;
  steps: WorkflowStepResult[];
  totalUsd: number;
}

/** O que o executor conta ao chamador enquanto anda. */
export type WorkflowRunEvent =
  | { kind: 'batch'; index: number; total: number; steps: string[] }
  | { kind: 'started'; stepId: string; agent: string; sessionId: string; capUsd: number | null }
  | { kind: 'settled'; step: WorkflowStepResult }
  | { kind: 'skipped'; step: WorkflowStepResult };

export interface WorkflowRunDeps {
  /** Cria a sessão do passo. NÃO espera o passo terminar — nem deve. */
  start(input: {
    step: WorkflowStep;
    upstream: UpstreamResult[];
    /** Teto em dólares desta execução, já descontado do orçamento global. */
    capUsd: number | null;
  }): Promise<{ sessionId: string; taskId: string }>;

  /** Espera a tarefa chegar a estado terminal. É o `await` que faltava. */
  settle(input: { step: WorkflowStep; sessionId: string; taskId: string }): Promise<{
    state: 'completed' | 'failed' | 'blocked' | 'timeout';
    summary: string | null;
    detail: string | null;
    usd: number;
  }>;

  report?(event: WorkflowRunEvent): void;

  /**
   * Espera `ms` milissegundos entre tentativas de `deps.start` quando a
   * anterior bateu em `CONCURRENCY_EXCEEDED`. Injetável para que o teste
   * controle o tempo sem `setTimeout` real; o padrão usa o `sleep` de
   * `resilience.ts` (timer de verdade).
   */
  sleep?(ms: number): Promise<void>;
}

export interface WorkflowRunOptions {
  /**
   * Teto do workflow inteiro. Cada passo é uma sessão-raiz com ledger próprio,
   * então o Hub não tem onde aplicar um orçamento comum: quem o aplica é este
   * laço, repartindo o saldo e parando de despachar quando ele acaba.
   */
  budgetUsd?: number | undefined;

  /**
   * Quantas vezes tentar de novo um `deps.start` que recusou com
   * `CONCURRENCY_EXCEEDED` antes de desistir e marcar o passo como `failed`.
   * A vaga de concorrência é reservada de forma síncrona no SessionManager —
   * dois passos do MESMO lote que delegam ao MESMO agente competem por ela, e
   * o segundo a chegar recebe esse erro mesmo sem nenhuma tarefa ter rodado
   * ainda. É transitório: a vaga libera quando o outro passo do lote termina.
   * Padrão: 5 tentativas adicionais.
   */
  concurrencyRetryMaxAttempts?: number;

  /**
   * Base do backoff (ms) entre tentativas de `CONCURRENCY_EXCEEDED`, dobrando
   * a cada tentativa (mesmo formato de `resilience.ts#nextStep`). Padrão:
   * 200ms.
   */
  concurrencyRetryBackoffMs?: number;
}

export async function runWorkflow(
  workflow: Workflow,
  executionOrder: string[][],
  deps: WorkflowRunDeps,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult> {
  const stepMap = new Map(workflow.steps.map((s) => [s.id, s]));
  const results = new Map<string, WorkflowStepResult>();
  const report = deps.report ?? ((): void => {});
  const sleep = deps.sleep ?? defaultSleep;
  const maxTentativasConcorrencia = options.concurrencyRetryMaxAttempts ?? 5;
  const backoffBaseConcorrencia = options.concurrencyRetryBackoffMs ?? 200;
  let gastoTotal = 0;

  const registrar = (r: WorkflowStepResult): WorkflowStepResult => {
    results.set(r.stepId, r);
    return r;
  };

  for (let i = 0; i < executionOrder.length; i += 1) {
    const batch = executionOrder[i]!;
    report({ kind: 'batch', index: i, total: executionOrder.length, steps: batch });

    // 1. Quem perdeu a vez. Um passo só roda se TODAS as dependências
    //    concluíram — a checagem é local, mas a propagação é transitiva de
    //    graça: quem foi pulado também não está `completed`.
    const executaveis: WorkflowStep[] = [];
    for (const stepId of batch) {
      const step = stepMap.get(stepId)!;
      const bloqueio = step.dependsOn
        .map((dep) => results.get(dep))
        .filter((d): d is WorkflowStepResult => d !== undefined && d.state !== 'completed');

      if (bloqueio.length > 0) {
        const nomes = bloqueio.map((d) => `${d.stepId} (${d.state})`).join(', ');
        report({
          kind: 'skipped',
          step: registrar({
            stepId,
            agent: step.agent,
            state: 'skipped',
            sessionId: null,
            taskId: null,
            summary: null,
            detail: `dependência não concluiu: ${nomes}`,
            usd: 0,
          }),
        });
        continue;
      }
      executaveis.push(step);
    }

    // 2. Repartir o saldo ANTES de despachar. Feito depois, dois passos
    //    paralelos do mesmo lote poderiam gastar o teto inteiro cada um: a
    //    soma dos tetos aqui nunca passa do que sobrou.
    const saldoInicial =
      options.budgetUsd === undefined ? null : Math.max(0, options.budgetUsd - gastoTotal);
    let saldo = saldoInicial;
    const tetos = new Map<string, number | null>();
    let restantes = executaveis.length;

    for (const step of executaveis) {
      if (saldo === null) {
        tetos.set(step.id, null);
      } else {
        const pedido = step.budget.usd ?? saldo / restantes;
        const teto = Math.min(pedido, saldo);
        tetos.set(step.id, teto);
        saldo -= teto;
      }
      restantes -= 1;
    }

    // 3. Despachar e ESPERAR. É a correção: o lote inteiro chega a estado
    //    terminal antes de o próximo começar.
    await Promise.all(
      executaveis.map(async (step) => {
        const teto = tetos.get(step.id) ?? null;

        if (teto !== null && teto <= 0) {
          report({
            kind: 'skipped',
            step: registrar({
              stepId: step.id,
              agent: step.agent,
              state: 'skipped',
              sessionId: null,
              taskId: null,
              summary: null,
              detail: `orçamento do workflow esgotado (US$ ${(options.budgetUsd ?? 0).toFixed(2)})`,
              usd: 0,
            }),
          });
          return;
        }

        const upstream = upstreamDe(step, results);

        // `CONCURRENCY_EXCEEDED` nasce ANTES de qualquer tarefa existir: é a
        // reserva de vaga do SessionManager, síncrona, disputada por passos
        // do MESMO lote que delegam ao MESMO agente. Diferente de um erro
        // definitivo (agente inexistente, política negada), a vaga libera
        // sozinha quando o outro passo termina — então vale esperar e tentar
        // de novo, com um teto para não girar para sempre se a vaga nunca
        // vier (ex.: concorrência ocupada por processo externo).
        let ids: { sessionId: string; taskId: string } | null = null;
        let tentativa = 0;

        while (ids === null) {
          try {
            ids = await deps.start({ step, upstream, capUsd: teto });
          } catch (err) {
            const éConcorrencia = isHubError(err) && err.code === 'CONCURRENCY_EXCEEDED';
            if (!éConcorrencia || tentativa >= maxTentativasConcorrencia) {
              const detail = éConcorrencia
                ? `esgotou tentativas de concorrência (${tentativa + 1}/${maxTentativasConcorrencia + 1}): ${(err as Error).message}`
                : `não foi possível iniciar: ${(err as Error).message}`;
              report({
                kind: 'settled',
                step: registrar({
                  stepId: step.id,
                  agent: step.agent,
                  state: 'failed',
                  sessionId: null,
                  taskId: null,
                  summary: null,
                  detail,
                  usd: 0,
                }),
              });
              return;
            }

            const backoffMs = backoffBaseConcorrencia * 2 ** tentativa;
            tentativa += 1;
            await sleep(backoffMs);
          }
        }

        report({
          kind: 'started',
          stepId: step.id,
          agent: step.agent,
          sessionId: ids.sessionId,
          capUsd: teto,
        });

        let desfecho: Awaited<ReturnType<WorkflowRunDeps['settle']>>;
        try {
          desfecho = await deps.settle({ step, ...ids });
        } catch (err) {
          desfecho = {
            state: 'failed',
            summary: null,
            detail: `erro ao acompanhar o passo: ${(err as Error).message}`,
            usd: 0,
          };
        }

        gastoTotal += desfecho.usd;
        report({
          kind: 'settled',
          step: registrar({
            stepId: step.id,
            agent: step.agent,
            state: desfecho.state,
            sessionId: ids.sessionId,
            taskId: ids.taskId,
            summary: desfecho.summary,
            detail: desfecho.detail,
            usd: desfecho.usd,
          }),
        });
      }),
    );
  }

  const steps = workflow.steps.map(
    (s) =>
      results.get(s.id) ?? {
        stepId: s.id,
        agent: s.agent,
        state: 'skipped' as const,
        sessionId: null,
        taskId: null,
        summary: null,
        detail: 'não alcançado pela ordem de execução',
        usd: 0,
      },
  );

  return {
    ok: steps.every((s) => s.state === 'completed'),
    steps,
    totalUsd: gastoTotal,
  };
}

/**
 * O fan-in propriamente dito: o que as dependências entregaram.
 *
 * Antes disto, `stepSessions` era preenchido e nunca lido — nenhum resultado
 * chegava ao passo seguinte. Passa só o resumo; o ponteiro de sessão fica para
 * quem quiser o detalhe.
 */
function upstreamDe(step: WorkflowStep, results: Map<string, WorkflowStepResult>): UpstreamResult[] {
  const out: UpstreamResult[] = [];
  for (const dep of step.dependsOn) {
    const r = results.get(dep);
    if (!r || r.state !== 'completed' || !r.summary) continue;
    out.push({
      step: r.stepId,
      agent: r.agent,
      summary: r.summary,
      ...(r.sessionId ? { sessionRef: `session:${r.sessionId}` } : {}),
    });
  }
  return out;
}

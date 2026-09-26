import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import {
  HubError,
  isHubError,
  isTerminalTaskState,
  nowIso,
  parseWorkflow,
  runWorkflow,
  validateWorkflow,
  type Workflow,
  type WorkflowRunEvent,
  type WorkflowStepState,
} from '@agents-hub/core';

/**
 * Workflows disparados pela API (painel), executados DENTRO do daemon.
 *
 * A CLI (`hub workflow run`) conduz o laço no próprio processo, o que é certo
 * para um terminal: quem rodou está olhando. No painel isso seria errado — o
 * encadeamento morreria ao fechar a aba, com passos seguintes nunca
 * despachados. Aqui o laço é o mesmo `runWorkflow` do core; muda só quem o
 * hospeda.
 *
 * O registro é em memória, de propósito: um workflow é uma sequência de
 * sessões, e as sessões (com tarefas, custo e eventos) já são persistidas.
 * Reiniciar o daemon interrompe o ENCADEAMENTO — os passos já despachados
 * seguem como sessões comuns — e isso é dito, não escondido: a lista some e o
 * painel mostra que não há execução registrada.
 */

/** Teto do texto do workflow: YAML de pipeline, não um dump de repositório. */
export const WORKFLOW_YAML_MAX = 200_000;

/** Quantas execuções terminadas guardar para consulta. */
const RETIDAS = 20;

export type WorkflowRunState = 'running' | 'completed' | 'failed' | 'interrupted';
export type WorkflowRunStepState = 'pending' | 'running' | WorkflowStepState;

export interface WorkflowRunStepView {
  stepId: string;
  agent: string;
  dependsOn: string[];
  state: WorkflowRunStepState;
  sessionId: string | null;
  taskId: string | null;
  summary: string | null;
  detail: string | null;
  usd: number;
  capUsd: number | null;
}

export interface WorkflowRunView {
  id: string;
  name: string;
  description: string | null;
  projectId: string;
  state: WorkflowRunState;
  budgetUsd: number | null;
  batches: string[][];
  /** Lote em execução (0-based), ou `null` fora da execução. */
  currentBatch: number | null;
  steps: WorkflowRunStepView[];
  totalUsd: number;
  startedAt: string;
  endedAt: string | null;
  /** Falha do próprio executor (não de um passo). */
  error: string | null;
}

export type WorkflowValidationView =
  | {
      valid: true;
      errors: [];
      workflow: {
        name: string;
        description: string | null;
        steps: Array<{ id: string; agent: string; dependsOn: string[] }>;
      };
      executionOrder: string[][];
    }
  | { valid: false; errors: string[]; workflow: null; executionOrder: [] };

/** Lê o YAML e valida sintaxe, esquema, dependências e ciclos. Nunca lança. */
export function validarWorkflowYaml(texto: string): WorkflowValidationView & { parsed?: Workflow } {
  const invalido = (errors: string[]): WorkflowValidationView => ({
    valid: false,
    errors,
    workflow: null,
    executionOrder: [],
  });

  let bruto: unknown;
  try {
    bruto = parseYaml(texto);
  } catch (err) {
    return invalido([`YAML inválido: ${(err as Error).message.split('\n')[0]}`]);
  }
  if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return invalido(['o workflow precisa ser um objeto YAML com `name` e `steps`']);
  }

  let workflow: Workflow;
  try {
    workflow = parseWorkflow(bruto);
  } catch (err) {
    const issues = isHubError(err)
      ? (err.details['issues'] as Array<{ path: string; message: string }> | undefined)
      : undefined;
    return invalido(
      issues && issues.length > 0
        ? issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
        : [(err as Error).message],
    );
  }

  const validacao = validateWorkflow(workflow);
  if (!validacao.valid) return invalido(validacao.errors);

  return {
    valid: true,
    errors: [],
    workflow: {
      name: workflow.name,
      description: workflow.description ?? null,
      steps: workflow.steps.map((s) => ({ id: s.id, agent: s.agent, dependsOn: s.dependsOn })),
    },
    executionOrder: validacao.executionOrder,
    parsed: workflow,
  };
}

/** O pedaço do SessionManager que o executor usa — estreito para o teste. */
export interface WorkflowHost {
  start(input: {
    projectId: string;
    agentId: string;
    brief: Record<string, unknown>;
    title?: string;
  }): Promise<{ session: { id: string }; task: { id: string } }>;
  listTasks(sessionId: string): Array<{
    state: string;
    attempts: Array<{ error: string | null }>;
    result: {
      summary?: string;
      validation?: { checks: Array<{ name: string; passed: boolean }> };
    } | null;
  }>;
  pendingApprovals(sessionId?: string): Array<{ id: string; action: string }>;
  budget(rootId: string): { consumed: { usd: number } };
  getProject(projectId: string): unknown;
}

export interface WorkflowRunnerOptions {
  /** Intervalo entre consultas do estado da tarefa. */
  intervaloMs?: number;
  /** Teto de espera por passo; estourar NÃO mata a sessão. */
  esperaMaxMs?: number;
}

export class WorkflowRunner {
  readonly #runs = new Map<string, WorkflowRunView>();
  readonly #intervaloMs: number;
  readonly #esperaMaxMs: number;
  #fechado = false;
  readonly #timers = new Set<{ t: NodeJS.Timeout; resolve: () => void }>();

  constructor(
    private readonly host: WorkflowHost,
    options: WorkflowRunnerOptions = {},
  ) {
    this.#intervaloMs = options.intervaloMs ?? 2000;
    this.#esperaMaxMs = options.esperaMaxMs ?? 45 * 60 * 1000;
  }

  list(): WorkflowRunView[] {
    return [...this.#runs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((r) => structuredClone(r));
  }

  get(id: string): WorkflowRunView {
    const run = this.#runs.get(id);
    if (!run) {
      throw new HubError('TASK_NOT_FOUND', `Execução de workflow ${id} não encontrada (o registro é em memória e some quando o daemon reinicia)`, {
        runId: id,
      });
    }
    return structuredClone(run);
  }

  /**
   * Valida e dispara. Devolve assim que a execução está registrada — o laço
   * segue em segundo plano, e o progresso é lido por `get`.
   */
  start(input: { yaml: string; projectId: string; budgetUsd?: number }): WorkflowRunView {
    if (this.#fechado) throw new HubError('ILLEGAL_STATE', 'o daemon está encerrando');
    // Projeto inexistente falha AQUI (404), não como N passos falhados.
    this.host.getProject(input.projectId);

    const val = validarWorkflowYaml(input.yaml);
    if (!val.valid || !val.parsed) {
      throw new HubError('INVALID_BRIEF', 'workflow inválido', {
        issues: val.errors.map((message) => ({ path: 'yaml', message })),
      });
    }
    const workflow = val.parsed;

    const run: WorkflowRunView = {
      id: `wfr_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      name: workflow.name,
      description: workflow.description ?? null,
      projectId: input.projectId,
      state: 'running',
      budgetUsd: input.budgetUsd ?? null,
      batches: val.executionOrder,
      currentBatch: null,
      steps: workflow.steps.map((s) => ({
        stepId: s.id,
        agent: s.agent,
        dependsOn: s.dependsOn,
        state: 'pending',
        sessionId: null,
        taskId: null,
        summary: null,
        detail: null,
        usd: 0,
        capUsd: null,
      })),
      totalUsd: 0,
      startedAt: nowIso(),
      endedAt: null,
      error: null,
    };
    this.#runs.set(run.id, run);
    this.#podar();

    void this.#executar(run, workflow, input.budgetUsd);
    return structuredClone(run);
  }

  /** Para de acompanhar: os laços em espera acordam e encerram como interrompidos. */
  close(): void {
    this.#fechado = true;
    for (const timer of this.#timers) {
      clearTimeout(timer.t);
      timer.resolve();
    }
    this.#timers.clear();
  }

  async #executar(run: WorkflowRunView, workflow: Workflow, budgetUsd: number | undefined): Promise<void> {
    const passo = (id: string): WorkflowRunStepView => run.steps.find((s) => s.stepId === id)!;
    try {
      const resultado = await runWorkflow(
        workflow,
        run.batches,
        {
          start: async ({ step, upstream, capUsd }) => {
            if (this.#fechado) throw new Error('o daemon está encerrando');
            const res = await this.host.start({
              projectId: run.projectId,
              agentId: '',
              brief: {
                agent: step.agent,
                objective: step.objective,
                acceptanceCriteria: step.acceptanceCriteria,
                constraints: step.constraints,
                upstream,
                budget: {
                  ...step.budget,
                  ...(capUsd !== null ? { usd: Math.max(0.01, Math.round(capUsd * 100) / 100) } : {}),
                },
                ...(step.isolation ? { isolation: step.isolation } : {}),
                supervision: step.supervision ?? 'semi',
              },
              title: `[${workflow.name}] Step: ${step.id}`,
            });
            return { sessionId: res.session.id, taskId: res.task.id };
          },
          settle: ({ sessionId }) => this.#aguardar(sessionId),
          report: (ev: WorkflowRunEvent) => {
            switch (ev.kind) {
              case 'batch':
                run.currentBatch = ev.index;
                return;
              case 'started': {
                const s = passo(ev.stepId);
                s.state = 'running';
                s.sessionId = ev.sessionId;
                s.capUsd = ev.capUsd;
                return;
              }
              case 'skipped':
              case 'settled': {
                const s = passo(ev.step.stepId);
                s.state = ev.step.state;
                s.sessionId = ev.step.sessionId;
                s.taskId = ev.step.taskId;
                s.summary = ev.step.summary;
                s.detail = ev.step.detail;
                s.usd = ev.step.usd;
                run.totalUsd = run.steps.reduce((t, x) => t + x.usd, 0);
                return;
              }
            }
          },
        },
        budgetUsd === undefined ? {} : { budgetUsd },
      );
      run.totalUsd = resultado.totalUsd;
      run.state = this.#fechado ? 'interrupted' : resultado.ok ? 'completed' : 'failed';
    } catch (err) {
      run.state = 'failed';
      run.error = (err as Error).message;
    } finally {
      run.currentBatch = null;
      run.endedAt = nowIso();
    }
  }

  /** Espera a tarefa do passo chegar a um desfecho (mesma regra da CLI). */
  async #aguardar(sessionId: string): Promise<{
    state: 'completed' | 'failed' | 'blocked' | 'timeout';
    summary: string | null;
    detail: string | null;
    usd: number;
  }> {
    const limite = Date.now() + this.#esperaMaxMs;
    const gasto = (): number => {
      try {
        return this.host.budget(sessionId).consumed.usd;
      } catch {
        return 0;
      }
    };

    while (Date.now() < limite) {
      if (this.#fechado) {
        return { state: 'timeout', summary: null, detail: `acompanhamento interrompido: o daemon encerrou — a sessão ${sessionId} não é mais seguida por este workflow`, usd: gasto() };
      }
      const task = this.host.listTasks(sessionId)[0];
      if (!task) return { state: 'failed', summary: null, detail: 'a sessão não tem tarefa', usd: 0 };

      if (task.state === 'input_required') {
        const pendente = this.host.pendingApprovals(sessionId)[0];
        return {
          state: 'blocked',
          summary: null,
          detail: pendente
            ? `esperando aprovação: ${pendente.action}`
            : 'esperando decisão humana (veja as aprovações)',
          usd: gasto(),
        };
      }

      if (isTerminalTaskState(task.state as Parameters<typeof isTerminalTaskState>[0])) {
        const usd = gasto();
        if (task.state === 'completed') {
          return { state: 'completed', summary: task.result?.summary ?? null, detail: null, usd };
        }
        const ultima = task.attempts[task.attempts.length - 1];
        const reprovada = task.result?.validation?.checks.find((c) => !c.passed);
        return {
          state: 'failed',
          summary: task.result?.summary ?? null,
          detail:
            ultima?.error ??
            (reprovada ? `validação reprovou: ${reprovada.name}` : `tarefa terminou em ${task.state}`),
          usd,
        };
      }

      await this.#dormir(this.#intervaloMs);
    }

    return {
      state: 'timeout',
      summary: null,
      detail: `passou de ${Math.round(this.#esperaMaxMs / 60000)} min — a sessão ${sessionId} continua viva no daemon`,
      usd: gasto(),
    };
  }

  #dormir(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = {
        t: setTimeout(() => {
          this.#timers.delete(timer);
          resolve();
        }, ms),
        resolve,
      };
      // O acompanhamento não pode ser o motivo de o processo não sair.
      timer.t.unref?.();
      this.#timers.add(timer);
    });
  }

  /** Mantém as em curso e as `RETIDAS` terminadas mais recentes. */
  #podar(): void {
    const terminadas = [...this.#runs.values()]
      .filter((r) => r.state !== 'running')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const velha of terminadas.slice(RETIDAS)) this.#runs.delete(velha.id);
  }
}

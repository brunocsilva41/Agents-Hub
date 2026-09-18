import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  parseWorkflow,
  runWorkflow,
  validateWorkflow,
  type Workflow,
  type WorkflowRunEvent,
  type WorkflowStepResult,
} from '@agents-hub/core';
import type { HubClient } from './client.js';
import { bold, cyan, dim, green, red, yellow } from './render.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Estados terminais de tarefa, iguais aos que `hub start` observa. */
const TERMINAIS = new Set(['completed', 'failed', 'canceled', 'rejected']);

/**
 * Teto de espera por passo. Generoso porque um passo de workflow é uma tarefa
 * inteira de agente, não um turno — mas finito, senão um passo travado prende
 * o workflow para sempre. Estourar NÃO mata a sessão: ela continua no daemon,
 * e o relatório final diz onde ela está.
 */
const ESPERA_MAX_MS = 45 * 60 * 1000;
const INTERVALO_MS = 2000;

export async function workflowCommand(client: HubClient, args: Args): Promise<void> {
  const [subcommand, file] = args.positional;

  if (!subcommand || subcommand === 'help' || args.flags['help']) {
    console.log(`
${bold('hub workflow')} — execução de pipelines e DAGs de múltiplos agentes

${bold('Uso:')}
  hub workflow validate <arquivo.yaml>       valida sintaxe, dependências e ciclos
  hub workflow run <arquivo.yaml>            executa respeitando as dependências
      --project <caminho>                    diretório do projeto (padrão: atual)
      --budget-usd <n>                       teto em dólares do workflow inteiro
`);
    return;
  }

  if (subcommand === 'validate') {
    if (!file) {
      console.error(red('informe o caminho do arquivo de workflow'));
      process.exitCode = 1;
      return;
    }
    const result = validateFile(file);
    if (!result.valid) {
      console.error(red(`\n❌ Workflow inválido em ${file}:`));
      for (const err of result.errors) console.error(`  - ${err}`);
      process.exitCode = 1;
      return;
    }

    console.log(green(`\n✓ Workflow "${result.workflow.name}" válido!`));
    if (result.workflow.description) console.log(dim(`  ${result.workflow.description}`));
    console.log(`\n${bold('Ordem de Execução (' + result.executionOrder.length + ' níveis/batches):')}`);
    result.executionOrder.forEach((batch, idx) => {
      console.log(`  ${cyan(`Lote ${idx + 1}`)} ${dim('(paralelo)')}: ${batch.join(', ')}`);
    });
    console.log('');
    return;
  }

  if (subcommand === 'run') {
    if (!file) {
      console.error(red('informe o caminho do arquivo de workflow'));
      process.exitCode = 1;
      return;
    }

    const val = validateFile(file);
    if (!val.valid) {
      console.error(red(`\n❌ Workflow inválido em ${file}:`));
      for (const err of val.errors) console.error(`  - ${err}`);
      process.exitCode = 1;
      return;
    }

    const workflow = val.workflow;
    const projectPath =
      typeof args.flags['project'] === 'string' ? args.flags['project'] : process.cwd();
    const orcamento = lerOrcamento(args.flags['budget-usd']);
    if (orcamento instanceof Error) {
      console.error(red(orcamento.message));
      process.exitCode = 1;
      return;
    }

    const { project } = await client.addProject(projectPath);

    console.log(bold(`\n🚀 Iniciando workflow: ${workflow.name}`));
    console.log(`Projeto: ${cyan(project.name)} (${dim(project.path)})`);
    if (orcamento !== undefined) {
      console.log(`Orçamento do workflow: ${cyan(`US$ ${orcamento.toFixed(2)}`)}`);
    }
    console.log('');

    const resultado = await runWorkflow(
      workflow,
      val.executionOrder,
      {
        start: async ({ step, upstream, capUsd }) => {
          const res = await client.startSession({
            projectId: project.id,
            brief: {
              agent: step.agent,
              objective: step.objective,
              acceptanceCriteria: step.acceptanceCriteria,
              constraints: step.constraints,
              upstream,
              budget: {
                ...step.budget,
                // O teto repartido pelo executor manda: ele é o único ponto
                // onde o orçamento do workflow como um todo pode ser aplicado.
                ...(capUsd !== null ? { usd: arredondaCentavos(capUsd) } : {}),
              },
              isolation: step.isolation,
              supervision: step.supervision ?? 'semi',
            },
            title: `[${workflow.name}] Step: ${step.id}`,
          });
          return { sessionId: res.session.id, taskId: res.task.id };
        },

        settle: ({ sessionId }) => aguardarPasso(client, sessionId),

        report: (ev) => imprimir(ev, val.executionOrder.length),
      },
      orcamento === undefined ? {} : { budgetUsd: orcamento },
    );

    relatorio(resultado.steps, resultado.totalUsd, orcamento);
    if (!resultado.ok) process.exitCode = 1;
    return;
  }

  console.error(red(`subcomando de workflow desconhecido: ${subcommand}`));
  process.exitCode = 1;
}

/**
 * Espera o passo chegar a estado terminal.
 *
 * É o `await` que a versão anterior não tinha: ela dava `await` em
 * `startSession`, que devolve assim que a sessão nasce. Sem isto, `dependsOn`
 * não significa nada em tempo de execução.
 */
async function aguardarPasso(
  client: HubClient,
  sessionId: string,
): Promise<{
  state: 'completed' | 'failed' | 'blocked' | 'timeout';
  summary: string | null;
  detail: string | null;
  usd: number;
}> {
  const limite = Date.now() + ESPERA_MAX_MS;

  while (Date.now() < limite) {
    const { tasks } = await client.tasks(sessionId).catch(() => ({ tasks: [] }));
    const task = tasks[0];

    if (!task) {
      return { state: 'failed', summary: null, detail: 'a sessão não tem tarefa', usd: 0 };
    }

    // Bloqueio por decisão humana não é espera: ninguém vai destravar enquanto
    // o workflow segura o terminal. Sai e diz o que falta fazer.
    if (task.state === 'input_required') {
      const { approvals } = await client.approvals(sessionId).catch(() => ({ approvals: [] }));
      const pendente = approvals[0];
      return {
        state: 'blocked',
        summary: null,
        detail: pendente
          ? `esperando aprovação: ${pendente.action} — resolva com \`hub approve ${pendente.id}\``
          : 'esperando decisão humana (veja `hub approvals`)',
        usd: await gastoDa(client, sessionId),
      };
    }

    if (!TERMINAIS.has(task.state)) {
      await new Promise((r) => setTimeout(r, INTERVALO_MS));
      continue;
    }

    const usd = await gastoDa(client, sessionId);
    if (task.state === 'completed') {
      return { state: 'completed', summary: task.result?.summary ?? null, detail: null, usd };
    }

    const ultima = task.attempts[task.attempts.length - 1];
    const validacao = task.result?.validation;
    const reprovada = validacao?.checks.find((c) => !c.passed);
    return {
      state: 'failed',
      summary: task.result?.summary ?? null,
      detail:
        ultima?.error ??
        (reprovada ? `validação reprovou: ${reprovada.name}` : `tarefa terminou em ${task.state}`),
      usd,
    };
  }

  return {
    state: 'timeout',
    summary: null,
    detail: `passou de ${Math.round(ESPERA_MAX_MS / 60000)} min — a sessão ${sessionId} continua viva no daemon`,
    usd: await gastoDa(client, sessionId),
  };
}

/**
 * Custo do passo pelo ledger da raiz, não pelo `usage` da tarefa: o passo pode
 * ter delegado, e o que os filhos gastaram é debitado da mesma raiz.
 */
async function gastoDa(client: HubClient, sessionId: string): Promise<number> {
  const { budget } = await client
    .budget(sessionId)
    .catch(() => ({ budget: { consumed: { usd: 0 } } }) as never);
  return budget.consumed.usd;
}

function imprimir(ev: WorkflowRunEvent, totalLotes: number): void {
  switch (ev.kind) {
    case 'batch':
      console.log(`${bold(`\n--- Lote ${ev.index + 1}/${totalLotes}`)} [${ev.steps.join(', ')}] ---`);
      return;
    case 'started':
      console.log(
        `  ▶ ${cyan(ev.stepId)} em ${yellow(ev.agent)} ${dim(ev.sessionId)}` +
          (ev.capUsd !== null ? dim(` · teto US$ ${ev.capUsd.toFixed(2)}`) : ''),
      );
      return;
    case 'skipped':
      console.log(`  ${yellow('⊘')} ${cyan(ev.step.stepId)} pulado — ${ev.step.detail}`);
      return;
    case 'settled': {
      const s = ev.step;
      const marca =
        s.state === 'completed' ? green('✓') : s.state === 'blocked' ? yellow('⏸') : red('✗');
      console.log(
        `  ${marca} ${cyan(s.stepId)} ${s.state}${s.detail ? dim(` — ${s.detail}`) : ''}` +
          dim(` · US$ ${s.usd.toFixed(4)}`),
      );
      return;
    }
  }
}

function relatorio(steps: WorkflowStepResult[], totalUsd: number, orcamento?: number): void {
  const conta = (estado: string): number => steps.filter((s) => s.state === estado).length;
  const ok = conta('completed');

  console.log(bold(`\n${'─'.repeat(52)}`));
  console.log(
    `${ok === steps.length ? green('✓') : red('✗')} ${ok}/${steps.length} passos concluídos` +
      `  ${dim(`· US$ ${totalUsd.toFixed(4)}`)}` +
      (orcamento !== undefined ? dim(` de US$ ${orcamento.toFixed(2)}`) : ''),
  );

  for (const s of steps) {
    if (s.state === 'completed') continue;
    console.log(`  ${s.state === 'blocked' ? yellow('⏸') : red('✗')} ${s.stepId}: ${s.detail ?? s.state}`);
  }

  const vivos = steps.filter((s) => s.state === 'blocked' || s.state === 'timeout');
  if (vivos.length > 0) {
    console.log(
      dim(`\nSessões ainda vivas no daemon: ${vivos.map((s) => s.sessionId).join(', ')}`),
    );
  }
  console.log('');
}

/** Centavos bastam: o `usd` do orçamento precisa ser positivo, e 1e-9 não é teto. */
function arredondaCentavos(v: number): number {
  return Math.max(0.01, Math.round(v * 100) / 100);
}

function lerOrcamento(flag: string | boolean | undefined): number | undefined | Error {
  if (flag === undefined) return undefined;
  if (typeof flag === 'boolean') return new Error('--budget-usd precisa de um valor em dólares');
  const n = Number(flag);
  if (!Number.isFinite(n) || n <= 0) {
    return new Error(`--budget-usd inválido: "${flag}"`);
  }
  return n;
}

function validateFile(
  filePath: string,
): { valid: true; workflow: Workflow; executionOrder: string[][] } | { valid: false; errors: string[] } {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    return { valid: false, errors: [`Arquivo "${filePath}" não encontrado`] };
  }

  try {
    const raw = parseYaml(readFileSync(resolved, 'utf8')) as unknown;
    const workflow = parseWorkflow(raw);
    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      return { valid: false, errors: validation.errors };
    }
    return { valid: true, workflow, executionOrder: validation.executionOrder };
  } catch (err) {
    return { valid: false, errors: [(err as Error).message] };
  }
}

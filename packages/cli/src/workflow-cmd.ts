import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  parseWorkflow,
  validateWorkflow,
  type Workflow,
  type WorkflowValidationResult,
} from '@agents-hub/core';
import type { HubClient } from './client.js';
import { bold, cyan, dim, green, red, yellow } from './render.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export async function workflowCommand(client: HubClient, args: Args): Promise<void> {
  const [subcommand, file] = args.positional;

  if (!subcommand || subcommand === 'help' || args.flags['help']) {
    console.log(`
${bold('hub workflow')} — execução de pipelines e DAGs de múltiplos agentes

${bold('Uso:')}
  hub workflow validate <arquivo.yaml>       valida sintaxe, dependências e ciclos
  hub workflow run <arquivo.yaml>            executa o workflow em batches paralelos
      --project <caminho>                    diretório do projeto (padrão: atual)
      --budget-usd <n>                       orçamento global do workflow
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
    const projectPath = typeof args.flags['project'] === 'string' ? args.flags['project'] : process.cwd();
    const { project } = await client.addProject(projectPath);

    console.log(bold(`\n🚀 Iniciando workflow: ${workflow.name}`));
    console.log(`Projeto: ${cyan(project.name)} (${dim(project.path)})\n`);

    const stepMap = new Map(workflow.steps.map((s) => [s.id, s]));
    const stepSessions = new Map<string, { sessionId: string; taskId: string }>();

    for (let i = 0; i < val.executionOrder.length; i++) {
      const batch = val.executionOrder[i]!;
      console.log(`${bold(`\n--- Lote ${i + 1}/${val.executionOrder.length}`)} [${batch.join(', ')}] ---`);

      // Executa todos os steps do lote em paralelo
      await Promise.all(
        batch.map(async (stepId) => {
          const step = stepMap.get(stepId)!;
          console.log(`  ▶ Disparando step ${cyan(step.id)} no agente ${yellow(step.agent)}...`);

          const res = await client.startSession({
            projectId: project.id,
            brief: {
              agent: step.agent,
              objective: step.objective,
              acceptanceCriteria: step.acceptanceCriteria,
              constraints: step.constraints,
              budget: step.budget,
              isolation: step.isolation,
              supervision: step.supervision ?? 'semi',
            },
            title: `[${workflow.name}] Step: ${step.id}`,
          });

          stepSessions.set(step.id, { sessionId: res.session.id, taskId: res.task.id });
          console.log(`  ✓ Step ${cyan(step.id)} criado (sessão: ${dim(res.session.id)})`);
        }),
      );
    }

    console.log(green(`\n✓ Todos os ${workflow.steps.length} passos do workflow foram despachados com sucesso!`));
    console.log(`Use ${cyan('hub status')} ou o painel web em ${cyan('http://127.0.0.1:4747')} para acompanhar.\n`);
    return;
  }

  console.error(red(`subcomando de workflow desconhecido: ${subcommand}`));
  process.exitCode = 1;
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

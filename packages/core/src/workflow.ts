import { z } from 'zod';
import { HubError } from './errors.js';
import { BriefSchema, type Brief } from './brief.js';

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

import type { AgentRegistry } from '@agents-hub/adapters';
import type { HubConfig } from './config.js';
import { nowIso, type Task } from '@agents-hub/core';

/**
 * Descreve o que esta instância do Hub oferece pela API REST de automação
 * externa (`/api/tasks/*`).
 *
 * Isto NÃO é um Agent Card do protocolo A2A: não há JSON-RPC 2.0, nem
 * `message/send`, `tasks/get` ou `tasks/resubscribe`. É uma API REST simples
 * desenhada em torno dos tipos do Hub — ver `docs/decisoes/02-orquestracao.md`
 * (ADR 02.3) para o porquê de "A2A de verdade" continuar em aberto.
 */
export interface ApiDescriptor {
  name: string;
  version: string;
  description: string;
  apiVersion: string;
  url: string;
  capabilities: string[];
  skills: Array<{ id: string; name: string; description: string; capabilities: string[] }>;
  endpoints: {
    tasks: string;
    taskStatus: string;
    taskCancel: string;
    taskEvents: string;
  };
  authentication: {
    mode: 'none' | 'token';
  };
  updatedAt: string;
}

export function generateApiDescriptor(
  config: HubConfig,
  registry: AgentRegistry,
  baseUrl: string,
): ApiDescriptor {
  const manifests = registry.manifests();
  const allCapabilities = [...new Set(manifests.flatMap((m) => m.capabilities))];

  const skills = manifests.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    capabilities: m.capabilities,
  }));

  return {
    name: 'Agents-Hub',
    version: '0.1.0',
    description: 'Plano de controle onde qualquer agente de IA pode orquestrar e ser orquestrado.',
    apiVersion: '1.0',
    url: baseUrl,
    capabilities: allCapabilities,
    skills,
    endpoints: {
      tasks: `${baseUrl}/api/tasks`,
      taskStatus: `${baseUrl}/api/tasks/:id`,
      taskCancel: `${baseUrl}/api/tasks/:id/cancel`,
      taskEvents: `${baseUrl}/api/tasks/:id/events`,
    },
    authentication: {
      mode: 'none',
    },
    updatedAt: nowIso(),
  };
}

/** Formata uma Task do Hub para a resposta HTTP de `/api/tasks/*`. */
export function formatTaskResponse(task: Task, sessionState?: string): Record<string, unknown> {
  return {
    id: task.id,
    sessionId: task.sessionId,
    requesterSessionId: task.requesterSessionId,
    state: task.state,
    sessionState: sessionState ?? null,
    brief: {
      agent: task.brief.agent,
      objective: task.brief.objective,
      acceptanceCriteria: task.brief.acceptanceCriteria,
      constraints: task.brief.constraints,
      budget: task.brief.budget,
    },
    attempts: task.attempts,
    result: task.result
      ? {
          summary: task.result.summary,
          artifacts: task.result.artifacts,
          usage: task.result.usage,
          validation: task.result.validation,
        }
      : null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

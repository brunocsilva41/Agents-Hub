import type { AgentRegistry } from '@agents-hub/adapters';
import type { SessionManager } from './session-manager.js';
import type { InMemoryEventBus } from './bus.js';
import type { HubConfig } from './config.js';
import { nowIso, type Task, type TaskState } from '@agents-hub/core';

/**
 * Representação do Agent Card conforme especificação A2A v1.0.
 */
export interface AgentCard {
  name: string;
  version: string;
  description: string;
  protocolVersion: string;
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

export function generateAgentCard(
  config: HubConfig,
  registry: AgentRegistry,
  baseUrl: string,
): AgentCard {
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
    protocolVersion: '1.0',
    url: baseUrl,
    capabilities: allCapabilities,
    skills,
    endpoints: {
      tasks: `${baseUrl}/a2a/tasks`,
      taskStatus: `${baseUrl}/a2a/tasks/:id`,
      taskCancel: `${baseUrl}/a2a/tasks/:id/cancel`,
      taskEvents: `${baseUrl}/a2a/tasks/:id/events`,
    },
    authentication: {
      mode: 'none',
    },
    updatedAt: nowIso(),
  };
}

/** Formata uma Task do Hub no schema A2A */
export function formatA2aTask(task: Task, sessionState?: string): Record<string, unknown> {
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

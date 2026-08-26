import path from 'node:path';
import { AgentRegistry } from '@agents-hub/adapters';
import { createStore } from '@agents-hub/store';
import type { UnitOfWork } from '@agents-hub/core';
import { InMemoryEventBus } from './bus.js';
import { loadConfig, type HubConfig } from './config.js';
import { HubServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { WorktreeManager } from './worktree.js';

export interface Hub {
  config: HubConfig;
  store: UnitOfWork;
  registry: AgentRegistry;
  bus: InMemoryEventBus;
  sessions: SessionManager;
  server: HubServer;
  shutdown(): Promise<void>;
}

/**
 * Monta o Hub inteiro a partir da configuração — a única função que conhece
 * todas as peças. Testes montam o mesmo grafo com banco em memória, sem
 * precisar subir servidor.
 */
export function createHub(overrides: Partial<HubConfig> = {}): Hub {
  const config = loadConfig(overrides);
  const store = createStore(config.dbFile);
  const registry = AgentRegistry.fromDirectory(config.manifestsDir, {
    probeCacheFile: path.join(config.home, 'probes.json'),
  });
  const bus = new InMemoryEventBus();
  const worktrees = new WorktreeManager(config.worktreeRoot);
  const sessions = new SessionManager(config, store, registry, bus, worktrees);
  const server = new HubServer(config, sessions, registry, bus);

  return {
    config,
    store,
    registry,
    bus,
    sessions,
    server,
    async shutdown() {
      await sessions.shutdown();
      await server.close();
      store.close();
    },
  };
}

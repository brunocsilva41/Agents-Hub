import path from 'node:path';
import { AgentRegistry, createOpenCodeAdapter, type OpenCodeAdapter } from '@agents-hub/adapters';
import { createStore } from '@agents-hub/store';
import type { UnitOfWork } from '@agents-hub/core';
import { InMemoryEventBus } from './bus.js';
import { loadConfig, type HubConfig } from './config.js';
import { WorktreeReaper } from './reaper.js';
import { HubServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { WorktreeManager } from './worktree.js';

export interface Hub {
  config: HubConfig;
  store: UnitOfWork;
  registry: AgentRegistry;
  bus: InMemoryEventBus;
  sessions: SessionManager;
  reaper: WorktreeReaper;
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
  // O OpenCode é o único do conjunto com servidor próprio. Trocamos o adapter
  // de processo pelo HTTP: pelo CLI perdíamos exatamente o que ele tem de melhor
  // — id de sessão durável, custo por passo e eventos estruturados.
  let opencode: OpenCodeAdapter | null = null;
  if (registry.has('opencode')) {
    opencode = createOpenCodeAdapter(registry.get('opencode').manifest, {
      port: config.opencodePort,
    });
    registry.registerAdapter(opencode);
  }

  const bus = new InMemoryEventBus();
  const worktrees = new WorktreeManager(config.worktreeRoot);
  const sessions = new SessionManager(config, store, registry, bus, worktrees);
  const reaper = new WorktreeReaper(store, worktrees, config.retention);
  const server = new HubServer(config, sessions, registry, bus, reaper);

  reaper.start();

  return {
    config,
    store,
    registry,
    bus,
    sessions,
    reaper,
    server,
    async shutdown() {
      reaper.stop();
      await sessions.shutdown();
      // Derruba o `opencode serve` que o Hub subiu — nunca um que já existia.
      if (opencode) await opencode.close();
      await server.close();
      store.close();
    },
  };
}

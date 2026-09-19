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
  /**
   * Coloca o daemon no ar: liga a porta, reconcilia o que ficou para trás e
   * começa a recolher worktree. Nesta ordem, e a ordem é a razão de existir.
   */
  start(): Promise<{ host: string; port: number }>;
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

  const hub: Hub = {
    config,
    store,
    registry,
    bus,
    sessions,
    reaper,
    server,

    /**
     * A porta É o lock de instância — e por isso ela vem primeiro.
     *
     * Reconciliar antes de ligar a porta era o bug mais destrutivo do daemon.
     * `reconcileOnStartup` marca como `killed` toda sessão que o banco diz
     * `running`, partindo da premissa de que "quem as rodava morreu". Rodando
     * ANTES do `listen`, essa premissa é falsa sempre que já existe um daemon
     * vivo: bastava um `hub daemon` a mais — ou uma corrida do autostart —
     * para o segundo processo abrir o mesmo banco, declarar mortas as sessões
     * que o primeiro estava rodando normalmente, e só então descobrir, no
     * `listen`, que a porta estava ocupada. Ele morria; o estrago ficava. O
     * painel mostrava sessões mortas, o reaper passava a considerar os
     * worktrees delas recolhíveis, e os processos seguiam gastando token sem
     * dono.
     *
     * Ligar a porta primeiro resolve sem inventar arquivo de lock nem PID: o
     * sistema operacional já garante que só um processo segura 127.0.0.1:4747.
     * Quem perde a disputa falha em `listen` e sai sem ter tocado no banco.
     */
    async start() {
      const endereco = await server.listen();

      const reconciliado = await sessions.reconcileOnStartup();
      if (reconciliado.encerradas > 0) {
        console.error(
          `reconciliação: ${reconciliado.encerradas} sessão(ões) órfã(s) de daemon anterior encerrada(s)` +
            (reconciliado.revividas > 0
              ? `, ${reconciliado.revividas} mantida(s) aguardando sua aprovação`
              : ''),
        );
      }

      // Depois da reconciliação, nunca antes: o reaper decide o que recolher
      // olhando `endedAt`, e recolher worktree de sessão que ainda não foi
      // classificada seria apagar trabalho vivo.
      reaper.start();

      return endereco;
    },

    async shutdown() {
      reaper.stop();
      await sessions.shutdown();
      // Derruba o `opencode serve` que o Hub subiu — nunca um que já existia.
      if (opencode) await opencode.close();
      await server.close();
      store.close();
    },
  };

  // O daemon pode ser encerrado pela API (`hub stop`), já que também sabe subir
  // sozinho quando alguém precisa dele.
  server.onShutdown = async () => {
    await hub.shutdown();
    process.exit(0);
  };

  return hub;
}

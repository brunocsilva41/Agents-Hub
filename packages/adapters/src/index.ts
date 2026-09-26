export * from './types.js';
export { AsyncQueue } from './async-queue.js';
export {
  resolveBin,
  clearBinCache,
  quoteForShell,
  montarSpawn,
  escaparArgParaCmd,
  resolverShimNpm,
  type ResolvedBin,
  type SpawnMontado,
} from './bin-resolver.js';
export {
  killProcessTree,
  imagemDoProcesso,
  imagemPareceEsperada,
  horarioDeCriacaoDoProcesso,
  pidPareceReciclado,
  TOLERANCIA_RELOGIO_MS,
} from './process-tree.js';
export {
  ProcessAgentAdapter,
  montarInvocacao,
  type EntregaDoPrompt,
  type InvocacaoMontada,
} from './process-adapter.js';
export {
  guardedActionsOf,
  describeAction,
  avaliarVigilancia,
  type VigilanciaVeredito,
} from './guarded-actions.js';
export { AgentRegistry, loadManifestDir, loadManifestFile } from './registry.js';
export { resolveMapper, listMappers } from './mappers/index.js';
export {
  OpenCodeAdapter,
  createOpenCodeAdapter,
  type OpenCodeAdapterOptions,
} from './opencode/adapter.js';
export {
  SseDecoder,
  translateOpenCodeEvent,
  openCodeSessionId,
  openCodeIdleSignal,
} from './opencode/events.js';
export { discoverAgent, type DiscoverOptions } from './discovery/index.js';

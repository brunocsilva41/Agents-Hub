export * from './types.js';
export { AsyncQueue } from './async-queue.js';
export { resolveBin, clearBinCache, quoteForShell, type ResolvedBin } from './bin-resolver.js';
export {
  killProcessTree,
  imagemDoProcesso,
  imagemPareceEsperada,
  horarioDeCriacaoDoProcesso,
  pidPareceReciclado,
  TOLERANCIA_RELOGIO_MS,
} from './process-tree.js';
export { ProcessAgentAdapter } from './process-adapter.js';
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
// Parsers de config alheia reutilizados pelos instaladores (mcp/hooks) para
// ler com tolerância e reparsear a saída antes de gravar.
export { parseToml } from './discovery/toml.js';
export { parseJsonTolerant, type JsonParse } from './discovery/util.js';

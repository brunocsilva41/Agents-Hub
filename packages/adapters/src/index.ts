export * from './types.js';
export { AsyncQueue } from './async-queue.js';
export {
  resolveBin,
  clearBinCache,
  quoteForShell,
  montarSpawn,
  escaparArgParaCmd,
  resolverShimNpm,
  candidatosNoPath,
  BIN_CACHE_NEGATIVO_MS,
  type ResolvedBin,
  type SpawnMontado,
} from './bin-resolver.js';
export {
  killProcessTree,
  opcoesDeGrupo,
  imagemDoProcesso,
  imagemPareceEsperada,
  horarioDeCriacaoDoProcesso,
  pidPareceReciclado,
  TOLERANCIA_RELOGIO_MS,
} from './process-tree.js';
export {
  ProcessAgentAdapter,
  montarInvocacao,
  modeloDaRun,
  type EntregaDoPrompt,
  type InvocacaoMontada,
} from './process-adapter.js';
export {
  guardedActionsOf,
  describeAction,
  describeRequest,
  avaliarVigilancia,
  gateDecideOEvento,
  type CoberturaDoGate,
  type VigilanciaVeredito,
} from './guarded-actions.js';
// Leitura da falha de um `resume` para o daemon decidir o replay de segurança.
export { sessaoNativaInexistente } from './failure-reason.js';
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

export {
  loadConfig,
  saveConfig,
  ligarBypassDoGateCodex,
  defaultHome,
  baseUrl,
  cliHookEntrypoint,
  mcpServerEntrypoint,
  DEFAULT_RETENTION,
  DEFAULT_CODEX_GATE,
  type HubConfig,
  type RetentionPolicy,
  type CodexGateConfig,
  type GateConfig,
} from './config.js';
export { readHubEnv, type HubEnv } from './env.js';
export {
  montarConfigDoGate,
  modoExigeGate,
  TIMEOUT_PADRAO_SEC,
  type AlvoDoGate,
  type ConfigDoGate,
} from './codex-gate.js';
export { InMemoryEventBus } from './bus.js';
export { WorktreeManager, type WorktreeInfo, type ReleaseResult } from './worktree.js';
export { SessionManager, type StartSessionInput, type StartSessionResult } from './session-manager.js';
export { HubServer } from './server.js';
export { serveStatic } from './static.js';
export { WorktreeReaper, type SweepResult } from './reaper.js';
export {
  AdoptedRootLeases,
  ADOPTED_HEARTBEAT_MS,
  ADOPTED_LEASE_MS,
  isAdoptedRoot,
} from './adopted-leases.js';
export {
  loadProjectOverrides,
  ignoredExecFieldsWarning,
  loadProjectContext,
  mergeProjectPolicy,
  projectConfigPath,
  clearProjectConfigCache,
  PROJECT_CONFIG_RELATIVE,
  type ProjectPolicyOverrides,
  type LoadedProjectOverrides,
  type LoadProjectOverridesOptions,
} from './project-config.js';
export {
  evaluateRepoTrust,
  effectiveProjectContext,
  repoSensitiveContent,
  repoTrustWarning,
  type RepoTrust,
  type RepoTrustState,
} from './repo-trust.js';
export { runValidation } from './validation.js';
export { interpretarRevisao } from './review-verdict.js';
export { captureDiff, persistDiff, type DiffCapture } from './diff-capture.js';
export {
  actionsOfToolCall,
  combineVerdicts,
  ESPERA_DO_GATE_MS,
  explainToAgent,
  TETO_HTTP_DO_HOOK_MS,
  TIMEOUT_DO_HOOK_SEC,
  toHookPermission,
  type HookPermission,
  type ToolCall,
} from './pretool-gate.js';
export {
  MATCHER_DE_RISCO,
  mergeHooks,
  hookInstalado,
  avisoDeTimeoutDoHook,
  hookTargets,
  comandoDoHook,
  comandoDoHub,
  NOTA_GATE_POR_SESSAO,
  type AlvoDeHook,
  type EntradaDeHook,
} from './hooks-config.js';
export {
  caminhoDoSettingsDaSessao,
  conteudoDoSettingsDaSessao,
  gravarSettingsDaSessao,
  apagarSettingsDaSessao,
} from './session-settings.js';
export { DecisoesDoGate } from './gate-idempotencia.js';
export { guardRequest, type GuardVerdict } from './guard.js';
export { createHub, type Hub, type HubDeps } from './hub.js';
export { encerradorDoProcesso, instalarRedeDeSeguranca } from './safety-net.js';
export {
  MCP_TARGETS,
  mcpTargets,
  resolveConfigPath,
  addMcpServers,
  upsertMcpServer,
  planUpsertMcpServer,
  existingServerNames,
  jsonEntry,
  tomlSection,
  substituirServidorToml,
  type ConfigFormat,
  type McpTarget,
  type PortableMcpServer,
  type McpMergeOutcome,
  type McpUpsertOutcome,
  type McpUpsertPlan,
} from './mcp-config.js';
export {
  backupVersionado,
  carimboDeBackup,
  gravarAtomico,
  gravarComBackup,
  lerJsonDeConfig,
  lerJsonParaExibir,
  type JsonDeConfig,
} from './safe-write.js';
export { DiscoveryService, ImportService, type DiscoverFn } from './absorption.js';
export {
  ensureOperatorToken,
  operatorTokenPath,
  authenticateOperator,
  type OperatorIdentity,
  type OperatorTokenFile,
} from './operator-auth.js';
export { AuditTrail } from './audit.js';
export {
  PolicyService,
  parsePolicyLayer,
  type PolicyView,
  type PolicyLayerView,
  type ProjectPolicyView,
} from './policy-service.js';
export { instanteDoFiltro } from './operator-routes.js';
// Backup/restauração do banco (item 5.6): a CLI usa direto quando o daemon
// está parado (restaurar só pode ser assim).
export {
  backupDatabase,
  restoreDatabase,
  conferirBanco,
  backupFileName,
  type BackupResult,
  type RestoreResult,
} from '@agents-hub/store';
export {
  estadoDasIntegracoes,
  planejarIntegracao,
  aplicarIntegracao,
  HUB_MCP_SERVER_NAME,
  type IntegracoesDeps,
  type EstadoDeIntegracao,
  type PlanoDeIntegracao,
} from './integrations.js';
export { diffDeLinhas, mascararLinha, type LinhaDeDiff } from './line-diff.js';

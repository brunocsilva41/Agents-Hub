/**
 * Contrato de DESCOBERTA e ABSORÇÃO do ambiente que cada CLI já tem.
 *
 * Descobrir é só leitura. Regra inegociável: NUNCA carregar segredo. Credencial
 * aparece apenas como presença de arquivo/variável (`auth`), jamais o valor; env
 * de servidor MCP sai com valores mascarados (`env: { CHAVE: '***' }`).
 */

export type AuthState = 'present' | 'absent' | 'unknown';

export interface DiscoveredMcpServer {
  name: string;
  transport: 'stdio' | 'http' | 'sse' | 'unknown';
  command?: string;
  args?: string[];
  url?: string;
  /** Só os NOMES das variáveis importam; valores são sempre '***'. */
  env?: Record<string, string>;
  /** Arquivo de onde veio (para o usuário auditar). */
  source: string;
  /** O próprio Hub registrado no agente: não deve ser reimportado. */
  isHub: boolean;
}

export interface DiscoveredConfigFile {
  path: string;
  exists: boolean;
  role: 'settings' | 'mcp' | 'instructions' | 'auth' | 'other';
}

export interface AgentDiscovery {
  agentId: string;
  installed: boolean;
  version: string | null;
  binPath: string | null;
  auth: { state: AuthState; evidence: string[] };
  /** Modelo/provedor padrão que o CLI usa quando o Hub não diz nada. */
  defaults: { model?: string; provider?: string; baseUrl?: string };
  files: DiscoveredConfigFile[];
  mcpServers: DiscoveredMcpServer[];
  /** Arquivos de instrução global do usuário (CLAUDE.md, AGENTS.md...). */
  instructionFiles: { path: string; bytes: number }[];
  /** O que este leitor não soube ler, dito com clareza (nunca silêncio). */
  warnings: string[];
}

export type ImportKind = 'instructions' | 'env' | 'mcp';

export interface ImportPlanItem {
  kind: ImportKind;
  description: string;
  /** Para onde vai: 'project-prompt' | 'project-env' | caminho do config de outro agente. */
  target: string;
  applied: boolean;
}

export interface ImportResult {
  agentId: string;
  dryRun: boolean;
  items: ImportPlanItem[];
  skipped: { what: string; reason: string }[];
}

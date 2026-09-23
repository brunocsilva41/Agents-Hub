import type { AgentDiscovery } from '@agents-hub/core';

export interface DiscoverOptions {
  /** Diretório home do usuário; injetável para teste. Padrão: os.homedir(). */
  home?: string;
  /** Raiz do projeto, para configs de escopo de projeto (.mcp.json etc.). */
  projectDir?: string;
  /** Resultado do probe do registry; null se o binário não está instalado. */
  installed: { version: string | null; binPath: string } | null;
}

/**
 * STUB — a implementação real (um leitor por agente) é entregue pelo agente
 * de descoberta. Assinatura é o contrato: não mude sem combinar.
 */
export async function discoverAgent(
  agentId: string,
  opts: DiscoverOptions,
): Promise<AgentDiscovery> {
  return {
    agentId,
    installed: opts.installed !== null,
    version: opts.installed?.version ?? null,
    binPath: opts.installed?.binPath ?? null,
    auth: { state: 'unknown', evidence: [] },
    defaults: {},
    files: [],
    mcpServers: [],
    instructionFiles: [],
    warnings: ['leitor de descoberta ainda não implementado para este agente'],
  };
}

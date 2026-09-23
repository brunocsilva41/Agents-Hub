import os from 'node:os';
import type { AgentDiscovery } from '@agents-hub/core';
import { discoverAntigravity } from './antigravity.js';
import { discoverClaude } from './claude.js';
import { discoverCodex } from './codex.js';
import { discoverCopilot } from './copilot.js';
import { discoverCursor } from './cursor.js';
import { discoverKimi } from './kimi.js';
import { discoverMimo } from './mimo.js';
import { discoverOpenClaude } from './openclaude.js';
import { discoverOpenCode } from './opencode.js';
import { Ctx, type DiscoveryEnv } from './util.js';

export interface DiscoverOptions {
  /** Diretório home do usuário; injetável para teste. Padrão: os.homedir(). */
  home?: string;
  /** Raiz do projeto, para configs de escopo de projeto (.mcp.json etc.). */
  projectDir?: string;
  /** Resultado do probe do registry; null se o binário não está instalado. */
  installed: { version: string | null; binPath: string } | null;
  /** Variáveis de ambiente consultadas para auth; injetável para teste. Padrão: process.env. */
  env?: DiscoveryEnv;
}

const READERS: Record<string, (ctx: Ctx) => void> = {
  claude: discoverClaude,
  codex: discoverCodex,
  opencode: discoverOpenCode,
  copilot: discoverCopilot,
  antigravity: discoverAntigravity,
  kimi: discoverKimi,
  mimo: discoverMimo,
  openclaude: discoverOpenClaude,
  cursor: discoverCursor,
};

export const DISCOVERABLE_AGENTS = Object.keys(READERS);

/**
 * Descoberta SOMENTE LEITURA do ambiente que o CLI já tem. Nunca lança:
 * qualquer falha vira warning. Nunca carrega valores de credencial.
 */
export async function discoverAgent(
  agentId: string,
  opts: DiscoverOptions,
): Promise<AgentDiscovery> {
  const ctx = new Ctx(opts.home ?? os.homedir(), opts.projectDir, opts.env ?? process.env);
  const reader = READERS[agentId];
  if (!reader) {
    ctx.authCanBeAbsent = false;
    ctx.warn(`sem leitor de descoberta para o agente '${agentId}'`);
  } else {
    try {
      reader(ctx);
    } catch (e) {
      ctx.authCanBeAbsent = false;
      ctx.warn(`falha inesperada ao descobrir '${agentId}': ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ctx.build(agentId, opts.installed);
}

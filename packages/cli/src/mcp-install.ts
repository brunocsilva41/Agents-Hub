import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Registro do Hub como MCP server dentro de cada agente.
 *
 * Isto escreve em arquivos de configuração que NÃO são nossos, então o padrão
 * é imprimir o trecho e deixar você colar. `--write` só é aplicado quando você
 * pede — e sempre com merge, backup versionado (`.bak-YYYYMMDD-HHMMSS`, nunca
 * sobrescrito) e escrita atômica, nunca sobrescrevendo o arquivo.
 */

import {
  MCP_TARGETS,
  jsonEntry,
  resolveConfigPath,
  tomlSection,
  upsertMcpServer,
  type ConfigFormat,
  type McpTarget,
  type PortableMcpServer,
} from '@agents-hub/daemon';

// A tabela de alvos e o merge de servidores vivem no daemon (reutilizados por
// POST /projects/:id/import); reexportados aqui para a CLI e seus testes.
export { MCP_TARGETS, resolveConfigPath, type ConfigFormat, type McpTarget };

/** Nome sob o qual o Hub se registra em cada agente. */
export const HUB_SERVER_NAME = 'agents-hub';

export interface ServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Caminho absoluto do executável do MCP server, resolvido a partir deste build. */
export function mcpEntrypoint(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/cli/dist -> packages/cli -> packages -> raiz
  return path.resolve(here, '..', '..', 'mcp', 'dist', 'main.js');
}

export function serverSpec(agentId: string, hubUrl: string): ServerSpec {
  return {
    command: process.execPath,
    args: [mcpEntrypoint()],
    env: {
      AGENTS_HUB_URL: hubUrl,
      // Diz ao Hub QUEM está chamando quando este agente for o principal
      // externo. Sem isso, a sessão adotada apareceria no grafo como "externo".
      AGENTS_HUB_MCP_AGENT: agentId,
    },
  };
}

function portable(spec: ServerSpec): PortableMcpServer {
  return {
    name: HUB_SERVER_NAME,
    transport: 'stdio',
    command: spec.command,
    args: spec.args,
    env: spec.env,
  };
}

/**
 * Trecho para colar, no formato exato que `--write` gravaria — inclusive o
 * schema próprio do OpenCode (`type: "local"`, `command` em array,
 * `environment`, `enabled`), que rejeita a config inteira se receber o
 * formato do Claude.
 */
export function renderSnippet(target: McpTarget, spec: ServerSpec): string {
  const server = portable(spec);
  if (target.format === 'toml-codex') return tomlSection(server);
  const key = target.format === 'json-mcp' ? 'mcp' : 'mcpServers';
  return JSON.stringify({ [key]: { [HUB_SERVER_NAME]: jsonEntry(target, server) } }, null, 2);
}

export interface WriteOutcome {
  path: string;
  action: 'created' | 'merged' | 'unchanged';
  /** Backup versionado desta execução; `null` quando nada foi gravado ou o arquivo não existia. */
  backup: string | null;
  avisos: string[];
}

/**
 * Registra (ou atualiza) o Hub no config do agente.
 *
 * JSON: só a entrada `agents-hub` muda, o resto do documento é preservado; o
 * arquivo pode ser JSONC, mas lixo/sintaxe quebrada é recusado sem gravar.
 * TOML (Codex): a tabela `[mcp_servers.agents-hub]` é substituída INTEIRA,
 * sub-tabelas incluídas (`codex mcp add --env` grava `[...agents-hub.env]`),
 * e a saída é reparseada antes de ir ao disco.
 */
export function writeConfig(
  target: McpTarget,
  spec: ServerSpec,
  configPath: string,
  agora: Date = new Date(),
): WriteOutcome {
  return upsertMcpServer(target, configPath, portable(spec), agora);
}

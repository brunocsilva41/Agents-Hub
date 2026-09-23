import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Registro do Hub como MCP server dentro de cada agente.
 *
 * Isto escreve em arquivos de configuração que NÃO são nossos, então o padrão
 * é imprimir o trecho e deixar você colar. `--write` só é aplicado quando você
 * pede — e sempre com backup `.bak` e merge, nunca sobrescrevendo o arquivo.
 */

import { MCP_TARGETS, resolveConfigPath, type ConfigFormat, type McpTarget } from '@agents-hub/daemon';

// A tabela de alvos e o merge de servidores vivem no daemon (reutilizados por
// POST /projects/:id/import); reexportados aqui para a CLI e seus testes.
export { MCP_TARGETS, resolveConfigPath, type ConfigFormat, type McpTarget };

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

export function renderSnippet(target: McpTarget, spec: ServerSpec): string {
  if (target.format === 'toml-codex') {
    return [
      '[mcp_servers.agents-hub]',
      `command = ${JSON.stringify(spec.command)}`,
      `args = [${spec.args.map((a) => JSON.stringify(a)).join(', ')}]`,
      'env = { ' +
        Object.entries(spec.env)
          .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
          .join(', ') +
        ' }',
    ].join('\n');
  }

  const key = target.format === 'json-mcp' ? 'mcp' : 'mcpServers';
  return JSON.stringify({ [key]: { 'agents-hub': spec } }, null, 2);
}

export interface WriteOutcome {
  path: string;
  action: 'created' | 'merged' | 'unchanged';
  backup: string | null;
}

export function writeConfig(target: McpTarget, spec: ServerSpec, configPath: string): WriteOutcome {
  mkdirSync(path.dirname(configPath), { recursive: true });

  const existed = existsSync(configPath);
  const backup = existed ? `${configPath}.bak` : null;
  if (existed && backup) copyFileSync(configPath, backup);

  if (target.format === 'toml-codex') {
    return writeToml(configPath, spec, existed, backup);
  }
  // 'json-mcp' (OpenCode, confirmado contra o binário real) usa a chave "mcp"
  // na raiz do documento; todo o resto usa "mcpServers". Gravar sob a chave
  // errada faz o agente ignorar o servidor do Hub em silêncio — sem erro,
  // sem log, só "não conecta nunca" — então isto não é um detalhe cosmético.
  const key = target.format === 'json-mcp' ? 'mcp' : 'mcpServers';
  return writeJson(configPath, spec, existed, backup, key);
}

function writeJson(
  configPath: string,
  spec: ServerSpec,
  existed: boolean,
  backup: string | null,
  key: 'mcp' | 'mcpServers' = 'mcpServers',
): WriteOutcome {
  let doc: Record<string, unknown> = {};
  if (existed) {
    const raw = readFileSync(configPath, 'utf8').trim();
    if (raw.length > 0) {
      try {
        doc = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        // Sobrescrever um config que não conseguimos entender destruiria a
        // configuração de MCP que você já tem. Preferimos parar.
        throw new Error(
          `${configPath} não é JSON válido (${(err as Error).message}). ` +
            'Corrija o arquivo ou cole o trecho manualmente.',
        );
      }
    }
  }

  const servers = (doc[key] as Record<string, unknown> | undefined) ?? {};
  const before = JSON.stringify(servers['agents-hub'] ?? null);
  servers['agents-hub'] = spec;
  doc[key] = servers;

  if (before === JSON.stringify(spec)) {
    return { path: configPath, action: 'unchanged', backup };
  }

  writeFileSync(configPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return { path: configPath, action: existed ? 'merged' : 'created', backup };
}

function writeToml(
  configPath: string,
  spec: ServerSpec,
  existed: boolean,
  backup: string | null,
): WriteOutcome {
  const existing = existed ? readFileSync(configPath, 'utf8') : '';
  const section = renderSnippet(
    { agentId: 'codex', label: '', format: 'toml-codex', configPath, verified: true },
    spec,
  );

  if (existing.includes('[mcp_servers.agents-hub]')) {
    // Substitui só a nossa seção, preservando tudo o mais do config.toml —
    // que costuma guardar modelo, sandbox e aprovações que você ajustou.
    const replaced = existing.replace(
      /\[mcp_servers\.agents-hub\][\s\S]*?(?=\n\[|\s*$)/,
      `${section}\n`,
    );
    if (replaced === existing) return { path: configPath, action: 'unchanged', backup };
    writeFileSync(configPath, replaced, 'utf8');
    return { path: configPath, action: 'merged', backup };
  }

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
  writeFileSync(configPath, `${existing}${separator}${section}\n`, 'utf8');
  return { path: configPath, action: existed ? 'merged' : 'created', backup };
}


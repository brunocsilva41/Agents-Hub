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

export type ConfigFormat = 'json-mcp-servers' | 'toml-codex';

export interface McpTarget {
  agentId: string;
  label: string;
  format: ConfigFormat;
  /** `null` quando o caminho depende do projeto (resolvido em tempo de uso). */
  configPath: string | null;
  projectRelativePath?: string;
  /** Confirmado contra a documentação do agente, ou palpite razoável. */
  verified: boolean;
  note?: string;
}

const home = os.homedir();

export const MCP_TARGETS: McpTarget[] = [
  {
    agentId: 'claude',
    label: 'Claude Code (escopo do projeto)',
    format: 'json-mcp-servers',
    configPath: null,
    projectRelativePath: '.mcp.json',
    verified: true,
    note: 'fica versionado no repo; para escopo de usuário use `claude mcp add`',
  },
  {
    agentId: 'codex',
    label: 'OpenAI Codex CLI',
    format: 'toml-codex',
    configPath: path.join(home, '.codex', 'config.toml'),
    verified: true,
  },
  {
    agentId: 'cursor',
    label: 'Cursor',
    format: 'json-mcp-servers',
    configPath: path.join(home, '.cursor', 'mcp.json'),
    verified: true,
  },
  {
    agentId: 'opencode',
    label: 'OpenCode',
    format: 'json-mcp-servers',
    configPath: path.join(home, '.config', 'opencode', 'opencode.json'),
    verified: false,
    note: 'o OpenCode usa a chave "mcp" em vez de "mcpServers" em algumas versões — confira antes',
  },
  {
    agentId: 'copilot',
    label: 'GitHub Copilot CLI',
    format: 'json-mcp-servers',
    configPath: path.join(home, '.copilot', 'mcp-config.json'),
    verified: false,
  },
  {
    agentId: 'kimi',
    label: 'Kimi Code CLI',
    format: 'json-mcp-servers',
    configPath: path.join(home, '.kimi-code', 'mcp.json'),
    verified: false,
  },
  {
    agentId: 'mimo',
    label: 'MiMo Code',
    format: 'json-mcp-servers',
    configPath: path.join(home, '.mimo', 'mcp.json'),
    verified: false,
  },
  {
    agentId: 'antigravity',
    label: 'Antigravity CLI',
    format: 'json-mcp-servers',
    configPath: path.join(home, '.antigravity', 'mcp.json'),
    verified: false,
  },
  {
    agentId: 'openclaude',
    label: 'OpenClaude (fork do Claude Code)',
    format: 'json-mcp-servers',
    // ADICIONADO, NÃO VERIFICADO: por ser fork do Claude Code, supomos o
    // mesmo padrão de config por projeto (`.mcp.json`, chave "mcpServers").
    // Nunca foi confirmado contra o binário real — só a entrada `claude`
    // acima tem esse selo. Fase 2 já marcou 3 entradas como certas por
    // dedução e errou 3 de 3; aqui o palpite fica explícito.
    configPath: null,
    projectRelativePath: '.mcp.json',
    verified: false,
    note: 'suposição por ser fork do Claude Code — nunca confirmado contra o binário do openclaude',
  },
];

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

  return JSON.stringify({ mcpServers: { 'agents-hub': spec } }, null, 2);
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
  return writeJson(configPath, spec, existed, backup);
}

function writeJson(
  configPath: string,
  spec: ServerSpec,
  existed: boolean,
  backup: string | null,
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

  const servers = (doc['mcpServers'] as Record<string, unknown> | undefined) ?? {};
  const before = JSON.stringify(servers['agents-hub'] ?? null);
  servers['agents-hub'] = spec;
  doc['mcpServers'] = servers;

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

export function resolveConfigPath(target: McpTarget, projectPath: string): string {
  if (target.configPath) return target.configPath;
  return path.join(projectPath, target.projectRelativePath ?? '.mcp.json');
}

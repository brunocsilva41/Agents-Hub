import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Alvos de configuração MCP de cada agente e o merge de servidores neles.
 *
 * Extraído de `packages/cli/src/mcp-install.ts` para ser compartilhado entre a
 * CLI (`hub mcp install`) e o daemon (`POST /projects/:id/import`, kind `mcp`).
 * A tabela de alvos e os formatos moram só aqui; a CLI reexporta.
 *
 * Regra: config de outra ferramenta nunca é sobrescrita — merge, com backup
 * `.bak` antes de qualquer escrita, e nunca apagando entrada existente.
 */

export type ConfigFormat = 'json-mcp-servers' | 'json-mcp' | 'toml-codex';

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

/** Tabela de alvos para um diretório home (injetável, para teste). */
export function mcpTargets(home: string): McpTarget[] {
  return [
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
      // Confirmado por execução real em 2026-09-18: `opencode mcp add` gravou em
      // ~/.config/opencode/opencode.json sob a chave "mcp" (NÃO "mcpServers").
      // Gravar sob a chave errada faria o OpenCode ignorar o servidor sem erro.
      format: 'json-mcp',
      configPath: path.join(home, '.config', 'opencode', 'opencode.json'),
      verified: true,
      note: 'confirmado por round-trip real (add + list + remove) em 2026-09-18: caminho certo, chave "mcp" (não "mcpServers")',
    },
    {
      agentId: 'copilot',
      label: 'GitHub Copilot CLI',
      format: 'json-mcp-servers',
      configPath: path.join(home, '.copilot', 'mcp-config.json'),
      // Confirmado em 2026-09-18: `copilot mcp --help` cita o caminho e o
      // arquivo existe com a chave "mcpServers".
      verified: true,
      note: 'confirmado: `copilot mcp --help` cita o caminho ipsis litteris; arquivo existe no disco com chave "mcpServers"',
    },
    {
      agentId: 'kimi',
      label: 'Kimi Code CLI',
      format: 'json-mcp-servers',
      configPath: path.join(home, '.kimi-code', 'mcp.json'),
      // NÃO É SÓ "NÃO CONFIRMADO" — É PALPITE ERRADO. `kimi --help` não tem
      // comando `mcp`, e nenhum arquivo de ~/.kimi-code tem seção de MCP.
      verified: false,
      note: 'binário não expõe comando `mcp` nem seção de MCP em nenhum arquivo de ~/.kimi-code — não é "não confirmado", é ausência de mecanismo nesta versão',
    },
    {
      agentId: 'mimo',
      label: 'MiMo Code',
      format: 'json-mcp-servers',
      configPath: path.join(home, '.mimo', 'mcp.json'),
      // `mimo mcp add` não é scriptável fora de terminal interativo e o MiMo
      // parece importar config de outros agentes em vez de ter arquivo próprio.
      verified: false,
      note: '`mcp add` não é scriptável fora de terminal interativo (testado); o MiMo parece importar config de outros agentes em vez de ter arquivo próprio — mecanismo real não localizado',
    },
    {
      agentId: 'antigravity',
      label: 'Antigravity CLI',
      format: 'json-mcp-servers',
      // Confirmado por round-trip real em 2026-09-18: `agy mcp add` gravou em
      // ~/.gemini/config/mcp_config.json sob a chave "mcpServers".
      configPath: path.join(home, '.gemini', 'config', 'mcp_config.json'),
      verified: true,
      note: 'confirmado por round-trip real (add + list + remove) em 2026-09-18: caminho é ~/.gemini/config/mcp_config.json, chave "mcpServers"',
    },
    {
      agentId: 'openclaude',
      label: 'OpenClaude (fork do Claude Code)',
      format: 'json-mcp-servers',
      // Confirmado por round-trip real com `--scope project`: `.mcp.json`, chave
      // "mcpServers". O escopo PADRÃO do `openclaude mcp add` é outro (local, em
      // ~/.openclaude.json) — não afeta a escrita direta do Hub.
      configPath: null,
      projectRelativePath: '.mcp.json',
      verified: true,
      note: 'confirmado por round-trip real com --scope project: .mcp.json, chave "mcpServers". O escopo PADRÃO do `openclaude mcp add` é diferente (local, em ~/.openclaude.json) — não afeta a escrita direta do Hub, mas é uma pegadinha para quem for usar a CLI do openclaude manualmente',
    },
  ];
}

export const MCP_TARGETS: McpTarget[] = mcpTargets(os.homedir());

export function resolveConfigPath(target: McpTarget, projectPath: string): string {
  if (target.configPath) return target.configPath;
  return path.join(projectPath, target.projectRelativePath ?? '.mcp.json');
}

// ------------------------------------------------- merge de servidores alheios

/** Servidor MCP em forma portável, pronto para ser escrito em outro agente. */
export interface PortableMcpServer {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  /** Só presente quando o chamador decidiu copiar valores (includeEnv). */
  env?: Record<string, string>;
}

export interface McpMergeOutcome {
  path: string;
  added: string[];
  /** Nomes que já existiam no destino e por isso NÃO foram tocados. */
  existing: string[];
  action: 'created' | 'merged' | 'unchanged';
  backup: string | null;
}

const JSON_KEY = (target: McpTarget): 'mcp' | 'mcpServers' =>
  target.format === 'json-mcp' ? 'mcp' : 'mcpServers';

function jsonEntry(target: McpTarget, s: PortableMcpServer): Record<string, unknown> {
  if (target.format === 'json-mcp') {
    // Formato do OpenCode: comando como array, `environment`, `type` local/remote.
    if (s.transport === 'stdio') {
      return {
        type: 'local',
        command: [s.command ?? '', ...(s.args ?? [])],
        ...(s.env && Object.keys(s.env).length > 0 ? { environment: s.env } : {}),
      };
    }
    return { type: 'remote', url: s.url };
  }
  if (s.transport === 'stdio') {
    return {
      command: s.command,
      args: s.args ?? [],
      ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
    };
  }
  // Claude Code (e forks) exigem `type` para servidores remotos; os demais só `url`.
  const claudeLike = target.agentId === 'claude' || target.agentId === 'openclaude';
  return claudeLike ? { type: s.transport, url: s.url } : { url: s.url };
}

const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;
const tomlKey = (k: string): string => (BARE_TOML_KEY.test(k) ? k : JSON.stringify(k));

function tomlSection(s: PortableMcpServer): string {
  const lines = [`[mcp_servers.${tomlKey(s.name)}]`];
  if (s.transport === 'stdio') {
    lines.push(`command = ${JSON.stringify(s.command ?? '')}`);
    lines.push(`args = [${(s.args ?? []).map((a) => JSON.stringify(a)).join(', ')}]`);
  } else {
    lines.push(`url = ${JSON.stringify(s.url ?? '')}`);
  }
  if (s.env && Object.keys(s.env).length > 0) {
    lines.push(
      'env = { ' +
        Object.entries(s.env)
          .map(([k, v]) => `${tomlKey(k)} = ${JSON.stringify(v)}`)
          .join(', ') +
        ' }',
    );
  }
  return lines.join('\n');
}

/** Nomes de servidores já declarados num config.toml do Codex. */
export function tomlServerNames(text: string): Set<string> {
  const names = new Set<string>();
  const re = /^\s*\[mcp_servers\.(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))(?:\.[^\]]*)?\]\s*$/gm;
  for (const m of text.matchAll(re)) names.add(m[1] !== undefined ? m[1] : (m[2] ?? ''));
  return names;
}

/** Nomes já presentes num destino, sem escrever nada (usado pelo dry-run). */
export function existingServerNames(target: McpTarget, configPath: string): Set<string> {
  if (!existsSync(configPath)) return new Set();
  const raw = readFileSync(configPath, 'utf8');
  if (target.format === 'toml-codex') return tomlServerNames(raw);
  if (raw.trim().length === 0) return new Set();
  const doc = parseJsonDoc(configPath, raw);
  const servers = doc[JSON_KEY(target)];
  return new Set(
    servers !== null && typeof servers === 'object' ? Object.keys(servers as object) : [],
  );
}

function parseJsonDoc(configPath: string, raw: string): Record<string, unknown> {
  try {
    const doc = JSON.parse(raw) as unknown;
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('raiz não é objeto');
    return doc as Record<string, unknown>;
  } catch (err) {
    // Sobrescrever um config que não entendemos destruiria o que já existe.
    throw new Error(`${configPath} não é JSON válido (${(err as Error).message}); nada foi gravado.`);
  }
}

/**
 * Acrescenta servidores ao config de um agente.
 *
 * - nunca duplica: nome já existente no destino fica INTACTO (vai em `existing`);
 * - nunca apaga nem reordena o resto do arquivo (JSON preserva as demais chaves;
 *   TOML só recebe seções ao final);
 * - `.bak` do estado anterior é criado antes da escrita, e só se houver escrita.
 */
export function addMcpServers(
  target: McpTarget,
  configPath: string,
  servers: PortableMcpServer[],
): McpMergeOutcome {
  const existed = existsSync(configPath);
  const raw = existed ? readFileSync(configPath, 'utf8') : '';
  const present = existingServerNames(target, configPath);

  const added: string[] = [];
  const existing: string[] = [];
  const fresh: PortableMcpServer[] = [];
  for (const s of servers) {
    if (present.has(s.name) || added.includes(s.name)) existing.push(s.name);
    else {
      added.push(s.name);
      fresh.push(s);
    }
  }

  if (fresh.length === 0) {
    return { path: configPath, added, existing, action: 'unchanged', backup: null };
  }

  let next: string;
  if (target.format === 'toml-codex') {
    const sep = raw.length === 0 ? '' : raw.endsWith('\n') ? '\n' : '\n\n';
    next = `${raw}${sep}${fresh.map(tomlSection).join('\n\n')}\n`;
  } else {
    const doc = raw.trim().length > 0 ? parseJsonDoc(configPath, raw) : {};
    const key = JSON_KEY(target);
    const bucket = (doc[key] !== null && typeof doc[key] === 'object' ? doc[key] : {}) as Record<
      string,
      unknown
    >;
    for (const s of fresh) bucket[s.name] = jsonEntry(target, s);
    doc[key] = bucket;
    next = `${JSON.stringify(doc, null, 2)}\n`;
  }

  mkdirSync(path.dirname(configPath), { recursive: true });
  const backup = existed ? `${configPath}.bak` : null;
  if (backup) copyFileSync(configPath, backup);
  writeFileSync(configPath, next, 'utf8');
  return { path: configPath, added, existing, action: existed ? 'merged' : 'created', backup };
}

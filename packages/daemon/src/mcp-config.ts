import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseToml } from '@agents-hub/adapters';
import { gravarComBackup, lerJsonDeConfig } from './safe-write.js';

/**
 * Alvos de configuração MCP de cada agente e o merge de servidores neles.
 *
 * Extraído de `packages/cli/src/mcp-install.ts` para ser compartilhado entre a
 * CLI (`hub mcp install`) e o daemon (`POST /projects/:id/import`, kind `mcp`).
 * A tabela de alvos e os formatos moram só aqui; a CLI reexporta.
 *
 * Regra: config de outra ferramenta nunca é sobrescrita — merge, com backup
 * versionado (`.bak-YYYYMMDD-HHMMSS`, nunca sobrescrito) antes de qualquer
 * escrita, escrita atômica, e nunca apagando entrada existente.
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

/**
 * Entrada de um servidor no formato JSON do agente-alvo.
 *
 * OpenCode (`json-mcp`) tem schema próprio e ESTRITO: o valor precisa ser
 * `{ type: "local", command: [bin, ...args], environment, enabled }` ou
 * `{ type: "remote", url, enabled }`. Gravar o formato do Claude
 * (`command`/`args`/`env`) faz o OpenCode rejeitar a config INTEIRA
 * ("Configuration is invalid ... Expected { type: "local" } | { type: "remote" }").
 */
export function jsonEntry(target: McpTarget, s: PortableMcpServer): Record<string, unknown> {
  if (target.format === 'json-mcp') {
    if (s.transport === 'stdio') {
      return {
        type: 'local',
        command: [s.command ?? '', ...(s.args ?? [])],
        ...(s.env && Object.keys(s.env).length > 0 ? { environment: s.env } : {}),
        enabled: true,
      };
    }
    return { type: 'remote', url: s.url, enabled: true };
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

export function tomlSection(s: PortableMcpServer): string {
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
  const doc = lerJsonDeConfig(configPath).doc;
  const servers = doc[JSON_KEY(target)];
  return new Set(servers !== null && typeof servers === 'object' ? Object.keys(servers) : []);
}

/** Bucket de servidores (`mcp`/`mcpServers`) de um doc JSON, recusando tipo estranho. */
function jsonBucket(
  configPath: string,
  doc: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const atual = doc[key];
  if (atual === undefined || atual === null) return {};
  if (typeof atual !== 'object' || Array.isArray(atual)) {
    throw new Error(`${configPath}: a chave "${key}" não é um objeto; nada foi gravado.`);
  }
  return atual as Record<string, unknown>;
}

/** Lê um config.toml para editar; recusa (sem gravar) o que não parseia. */
function lerTomlDeConfig(configPath: string, raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  try {
    return parseToml(raw);
  } catch (err) {
    throw new Error(
      `${configPath} não é TOML válido (${(err as Error).message}). ` +
        'Nada foi gravado: corrija o arquivo (ou cole o trecho manualmente) e rode de novo.',
    );
  }
}

/** Reparseia o TOML que vamos gravar: saída que o Codex recusaria nunca vai ao disco. */
function tomlGeradoOuFalha(configPath: string, next: string): Record<string, unknown> {
  try {
    return parseToml(next);
  } catch (err) {
    throw new Error(
      `a edição de ${configPath} geraria TOML inválido (${(err as Error).message}); nada foi gravado.`,
    );
  }
}

function servidoresToml(doc: Record<string, unknown>): Record<string, unknown> {
  const s = doc['mcp_servers'];
  return s !== null && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

/** Cópia do doc TOML sem o servidor `name` — para provar que o resto ficou intacto. */
function semServidor(doc: Record<string, unknown>, name: string): Record<string, unknown> {
  const copia = structuredClone(doc);
  const servers = servidoresToml(copia);
  delete servers[name];
  if ('mcp_servers' in copia && Object.keys(servers).length === 0) delete copia['mcp_servers'];
  return copia;
}

/** Valor que `tomlSection(s)` produz depois de parseado. */
function tomlEntry(s: PortableMcpServer): Record<string, unknown> {
  return {
    ...(s.transport === 'stdio'
      ? { command: s.command ?? '', args: s.args ?? [] }
      : { url: s.url ?? '' }),
    ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
  };
}

/** Separa um caminho de chave TOML (`a."b.c".d`) em segmentos; `null` se não for chave. */
function segmentosDeChave(texto: string): string[] | null {
  const out: string[] = [];
  const s = texto.trim();
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      let seg = '';
      while (j < s.length && s[j] !== c) {
        if (c === '"' && s[j] === '\\') {
          seg += s[j + 1] ?? '';
          j += 2;
        } else seg += s[j++];
      }
      if (j >= s.length) return null;
      out.push(seg);
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      out.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) break;
    if (s[i] !== '.') return null;
    i++;
  }
  return out.length > 0 ? out : null;
}

const CABECALHO_TOML = /^\s*(\[\[?)([^[\]]*?)(\]\]?)\s*(#.*)?$/;

/**
 * Remove do texto TOML TODAS as tabelas do servidor `name` — a principal
 * `[mcp_servers.<name>]` e as sub-tabelas (`[mcp_servers.<name>.env]`, que é
 * como `codex mcp add --env` grava) — e põe `section` no lugar da primeira.
 * O resto do arquivo (comentários, ordem, outros servidores) fica byte a byte.
 *
 * Substituir só até o próximo `[` deixava a sub-tabela `.env` antiga junto
 * com o `env = {...}` novo: chave duplicada, e o Codex parava de iniciar.
 */
export function substituirServidorToml(text: string, name: string, section: string): string {
  const linhas = text.split('\n');
  const saida: string[] = [];
  let removendo = false;
  let inserido = false;
  let multilinha: string | null = null;

  for (const linha of linhas) {
    let cabecalho: string[] | null = null;
    if (multilinha === null) {
      const m = CABECALHO_TOML.exec(linha.replace(/\r$/, ''));
      if (m && (m[1] === '[' ? m[3] === ']' : m[3] === ']]')) cabecalho = segmentosDeChave(m[2] ?? '');
    }

    if (cabecalho) {
      if (cabecalho[0] === 'mcp_servers' && cabecalho[1] === name) {
        removendo = true;
        if (!inserido) {
          saida.push(...section.split('\n'), '');
          inserido = true;
        }
        continue;
      }
      removendo = false;
    }

    if (!removendo) saida.push(linha);

    // Acompanha strings multilinha para não confundir `[x]` dentro delas com cabeçalho.
    for (const delim of ['"""', "'''"]) {
      const n = linha.split(delim).length - 1;
      if (multilinha === delim) {
        if (n % 2 === 1) multilinha = null;
      } else if (multilinha === null && n % 2 === 1) {
        multilinha = delim;
      }
    }
  }

  let resultado = saida.join('\n');
  if (!inserido) {
    const sep = resultado.length === 0 ? '' : resultado.endsWith('\n') ? '\n' : '\n\n';
    return `${resultado}${sep}${section}\n`;
  }
  // A seção removida podia ser a última: sem linhas em branco sobrando no fim.
  resultado = resultado.replace(/\n+$/, '');
  return `${resultado}\n`;
}

export interface McpUpsertOutcome {
  path: string;
  action: 'created' | 'merged' | 'unchanged';
  /** Backup versionado criado nesta execução (`null` se nada foi gravado ou o arquivo não existia). */
  backup: string | null;
  avisos: string[];
}

/**
 * O que `upsertMcpServer` gravaria, sem gravar: o texto atual e o novo (ou
 * `null` quando já está correto). É a prévia que o painel mostra como diff
 * antes de o operador confirmar (item 6.12 do GOAL). Lança, sem gravar nada,
 * nos mesmos casos em que a escrita recusaria.
 */
export interface McpUpsertPlan {
  path: string;
  existed: boolean;
  /** Conteúdo atual do arquivo (vazio se não existe). */
  raw: string;
  /** Conteúdo que seria gravado; `null` = nada a mudar. */
  next: string | null;
  avisos: string[];
}

export function planUpsertMcpServer(
  target: McpTarget,
  configPath: string,
  server: PortableMcpServer,
): McpUpsertPlan {
  const existed = existsSync(configPath);
  const raw = existed ? readFileSync(configPath, 'utf8') : '';
  const base = { path: configPath, existed, raw };

  if (target.format === 'toml-codex') {
    const antes = lerTomlDeConfig(configPath, raw);
    const esperado = tomlEntry(server);
    if (isDeepStrictEqual(servidoresToml(antes)[server.name], esperado)) {
      return { ...base, next: null, avisos: [] };
    }
    const next = substituirServidorToml(raw, server.name, tomlSection(server));
    const depois = tomlGeradoOuFalha(configPath, next);
    // Prova de que só o nosso servidor mudou e de que ficou exatamente como pedido.
    if (
      !isDeepStrictEqual(servidoresToml(depois)[server.name], esperado) ||
      !isDeepStrictEqual(semServidor(depois, server.name), semServidor(antes, server.name))
    ) {
      throw new Error(
        `${configPath}: o servidor "${server.name}" está declarado de um jeito que não sei ` +
          'substituir com segurança (ex.: tabela inline ou chaves pontuadas). Nada foi gravado; ' +
          'edite à mão com o trecho de `hub mcp show codex`.',
      );
    }
    return { ...base, next, avisos: [] };
  }

  const lido = lerJsonDeConfig(configPath);
  const doc = lido.doc;
  const key = JSON_KEY(target);
  const bucket = jsonBucket(configPath, doc, key);
  const entrada = jsonEntry(target, server);
  if (isDeepStrictEqual(bucket[server.name], entrada)) {
    return { ...base, next: null, avisos: lido.avisos };
  }
  bucket[server.name] = entrada;
  doc[key] = bucket;
  return {
    ...base,
    next: `${JSON.stringify(doc, null, 2)}
`,
    avisos: lido.avisos,
  };
}

/**
 * Cria ou SUBSTITUI um servidor (o do próprio Hub) no config de um agente.
 *
 * Diferente de `addMcpServers` (que nunca toca em nome existente), aqui a
 * entrada com o mesmo nome é trocada inteira — é assim que `hub mcp install`
 * atualiza caminho/porta. Todo o resto do arquivo é preservado, a saída é
 * reparseada antes de gravar e nada é escrito quando já está correto.
 */
export function upsertMcpServer(
  target: McpTarget,
  configPath: string,
  server: PortableMcpServer,
  agora: Date = new Date(),
): McpUpsertOutcome {
  const plano = planUpsertMcpServer(target, configPath, server);
  if (plano.next === null) {
    return { path: configPath, action: 'unchanged', backup: null, avisos: plano.avisos };
  }
  const backup = gravarComBackup(configPath, plano.next, agora);
  return {
    path: configPath,
    action: plano.existed ? 'merged' : 'created',
    backup,
    avisos: plano.avisos,
  };
}

/**
 * Acrescenta servidores ao config de um agente.
 *
 * - nunca duplica: nome já existente no destino fica INTACTO (vai em `existing`);
 * - nunca apaga nem reordena o resto do arquivo (JSON preserva as demais chaves;
 *   TOML só recebe seções ao final);
 * - backup versionado do estado anterior antes da escrita, só se houver
 *   escrita, e nunca sobrescrevendo um backup existente.
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
    lerTomlDeConfig(configPath, raw);
    const sep = raw.length === 0 ? '' : raw.endsWith('\n') ? '\n' : '\n\n';
    next = `${raw}${sep}${fresh.map(tomlSection).join('\n\n')}\n`;
    tomlGeradoOuFalha(configPath, next);
  } else {
    const doc = lerJsonDeConfig(configPath).doc;
    const key = JSON_KEY(target);
    const bucket = jsonBucket(configPath, doc, key);
    for (const s of fresh) bucket[s.name] = jsonEntry(target, s);
    doc[key] = bucket;
    next = `${JSON.stringify(doc, null, 2)}\n`;
  }

  const backup = gravarComBackup(configPath, next);
  return { path: configPath, added, existing, action: existed ? 'merged' : 'created', backup };
}

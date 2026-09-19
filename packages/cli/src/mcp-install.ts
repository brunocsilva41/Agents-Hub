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
    // Confirmado por execução real nesta máquina em 2026-09-18: `opencode mcp
    // add hub-verify-test --url http://localhost:1234` respondeu 'MCP server
    // "hub-verify-test" added to C:\Users\...\.config\opencode\opencode.json'
    // — caminho batia com o palpite anterior — e a entrada gravada usava a
    // chave "mcp" na raiz do JSON, NÃO "mcpServers". O formato antigo
    // ('json-mcp-servers') gravaria a chave errada e o OpenCode simplesmente
    // ignoraria o servidor do Hub sem erro nenhum. Corrigido com o formato
    // dedicado abaixo. Entrada de teste removida ao final da verificação.
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
    // Confirmado por duas fontes independentes em 2026-09-18: `copilot mcp
    // --help` documenta textualmente "User ~/.copilot/mcp-config.json" como
    // fonte de config, e o arquivo já existe no disco desta máquina com uma
    // entrada real sob a chave "mcpServers".
    verified: true,
    note: 'confirmado: `copilot mcp --help` cita o caminho ipsis litteris; arquivo existe no disco com chave "mcpServers"',
  },
  {
    agentId: 'kimi',
    label: 'Kimi Code CLI',
    format: 'json-mcp-servers',
    configPath: path.join(home, '.kimi-code', 'mcp.json'),
    // NÃO É SÓ "NÃO CONFIRMADO" — É PALPITE ERRADO. `kimi --help` (raiz e
    // todos os subcomandos) não tem NENHUM comando `mcp`; `~/.kimi-code/`
    // existe nesta máquina (config.toml, workspaces.json, tui.toml, local.toml)
    // e nenhum desses arquivos tem seção de MCP; `~/.kimi-code/mcp.json` não
    // existe. Não há evidência de que esta versão do Kimi Code aceite ser
    // host de MCP servers externos.
    verified: false,
    note: 'binário não expõe comando `mcp` nem seção de MCP em nenhum arquivo de ~/.kimi-code — não é "não confirmado", é ausência de mecanismo nesta versão',
  },
  {
    agentId: 'mimo',
    label: 'MiMo Code',
    format: 'json-mcp-servers',
    configPath: path.join(home, '.mimo', 'mcp.json'),
    // `mimo mcp add <nome> <comando>` e `mimo mcp add <nome> -- <comando>`
    // testados ao vivo: os dois só reimprimem o help, sem gravar nada — o
    // wizard parece exigir terminal interativo, não scriptável por args.
    // `mimo mcp list` funciona e mostra que o MiMo IMPORTA config de outros
    // agentes (`universal-ai-tools ... claude:~\.claude.json`) em vez de ter
    // um arquivo próprio previsível; `~/.mimo/mcp.json` não existe no disco
    // (o diretório `~/.mimo` nem existe — `~/.mimocode` existe mas só tem um
    // checkout de código-fonte, não config de runtime).
    verified: false,
    note: '`mcp add` não é scriptável fora de terminal interativo (testado); o MiMo parece importar config de outros agentes em vez de ter arquivo próprio — mecanismo real não localizado',
  },
  {
    agentId: 'antigravity',
    label: 'Antigravity CLI',
    format: 'json-mcp-servers',
    // Confirmado por round-trip real em 2026-09-18: `agy mcp add hub-verify-
    // test2 echo hello` gravou em `~/.gemini/config/mcp_config.json` (não
    // `~/.antigravity/mcp.json`, o palpite anterior — esse caminho nem
    // existe) sob a chave "mcpServers". `agy mcp list`/`remove` confirmaram
    // e a entrada de teste foi removida ao final.
    configPath: path.join(home, '.gemini', 'config', 'mcp_config.json'),
    verified: true,
    note: 'confirmado por round-trip real (add + list + remove) em 2026-09-18: caminho é ~/.gemini/config/mcp_config.json, chave "mcpServers"',
  },
  {
    agentId: 'openclaude',
    label: 'OpenClaude (fork do Claude Code)',
    format: 'json-mcp-servers',
    // Confirmado por round-trip real em 2026-09-18: `openclaude mcp add
    // --scope project <nome> <comando>` gravou `.mcp.json` no diretório
    // corrente com exatamente a forma esperada (chave "mcpServers", mesmo
    // formato do Claude Code). RESSALVA que a verificação também revelou:
    // o escopo PADRÃO de `openclaude mcp add` (sem `--scope`) NÃO é
    // "project" — é "local", que grava dentro de `~/.openclaude.json`,
    // chaveado por diretório de projeto, não em `.mcp.json`. Isso não afeta
    // o Hub (que escreve o arquivo `.mcp.json` diretamente, sem chamar
    // `openclaude mcp add`), mas documentar porque é exatamente o tipo de
    // suposição-por-semelhança-com-Claude que já errou 3 de 3 antes.
    configPath: null,
    projectRelativePath: '.mcp.json',
    verified: true,
    note: 'confirmado por round-trip real com --scope project: .mcp.json, chave "mcpServers". O escopo PADRÃO do `openclaude mcp add` é diferente (local, em ~/.openclaude.json) — não afeta a escrita direta do Hub, mas é uma pegadinha para quem for usar a CLI do openclaude manualmente',
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

export function resolveConfigPath(target: McpTarget, projectPath: string): string {
  if (target.configPath) return target.configPath;
  return path.join(projectPath, target.projectRelativePath ?? '.mcp.json');
}

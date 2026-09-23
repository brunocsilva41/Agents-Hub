import type { AgentDiscovery, ImportKind, ImportResult } from '@agents-hub/core';
import type { HubClient } from './client.js';
import { bold, dim, green, red, yellow } from './render.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const NEWLINE = String.fromCharCode(10);
const ALL_KINDS: ImportKind[] = ['instructions', 'env', 'mcp'];

// ------------------------------------------------------------------ parsing

/** `--kinds a,b`: valida cada item; erro claro em vez de ignorar em silêncio. */
export function parseKinds(flag: string | boolean | undefined): ImportKind[] | Error | undefined {
  if (flag === undefined) return undefined;
  if (typeof flag === 'boolean') return new Error('--kinds precisa de um valor: instructions,env,mcp');
  const kinds: ImportKind[] = [];
  for (const raw of flag.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!(ALL_KINDS as string[]).includes(raw)) {
      return new Error(`kind desconhecido "${raw}" (válidos: ${ALL_KINDS.join(', ')})`);
    }
    if (!kinds.includes(raw as ImportKind)) kinds.push(raw as ImportKind);
  }
  return kinds.length > 0 ? kinds : new Error('--kinds vazio');
}

/** `--to a,b` -> lista sem duplicatas. */
export function parseTargets(flag: string | boolean | undefined): string[] | Error | undefined {
  if (flag === undefined) return undefined;
  if (typeof flag === 'boolean') return new Error('--to precisa de uma lista: --to codex,cursor');
  const list = [...new Set(flag.split(',').map((s) => s.trim()).filter(Boolean))];
  return list.length > 0 ? list : new Error('--to vazio');
}

export interface ImportPlanRequest {
  agentId: string;
  kinds: ImportKind[];
  dryRun: boolean;
  targetAgents?: string[];
  overwrite?: boolean;
  includeEnv?: boolean;
}

/**
 * Argumentos de `hub import` -> corpo da requisição.
 *
 * Sem `--write` é dry-run. Sem `--kinds`, o padrão é `instructions,env` — e
 * `mcp` só entra junto quando há `--to`, porque compartilhar ferramentas grava
 * em config de OUTROS agentes e exige dizer quais.
 */
export function buildImportRequest(args: Args): ImportPlanRequest | Error {
  const agentId = args.positional[0];
  if (!agentId) return new Error('uso: hub import <agentId> [--project <caminho>] [--kinds ...] [--to a,b] [--write]');

  const kindsParsed = parseKinds(args.flags['kinds']);
  if (kindsParsed instanceof Error) return kindsParsed;
  const targets = parseTargets(args.flags['to']);
  if (targets instanceof Error) return targets;

  const kinds: ImportKind[] = kindsParsed ?? (targets ? ALL_KINDS : ['instructions', 'env']);
  if (kinds.includes('mcp') && !targets) {
    return new Error('kind "mcp" exige --to <agente1,agente2> (para quais agentes compartilhar as ferramentas)');
  }

  return {
    agentId,
    kinds,
    dryRun: args.flags['write'] !== true,
    ...(targets ? { targetAgents: targets } : {}),
    ...(args.flags['overwrite'] === true ? { overwrite: true } : {}),
    ...(args.flags['include-env'] === true ? { includeEnv: true } : {}),
  };
}

// ---------------------------------------------------------------- renderização

function authLabel(d: AgentDiscovery): string {
  return { present: 'presente', absent: 'ausente', unknown: '?' }[d.auth.state];
}

/** Tabela legível de `hub discover`. Sem cor no conteúdo das células (largura estável). */
export function renderDiscoveryTable(list: AgentDiscovery[]): string {
  const header = ['AGENTE', 'INSTALADO', 'VERSÃO', 'AUTH', 'MODELO PADRÃO', 'MCP', 'INSTRUÇÕES'];
  const rows = list.map((d) => [
    d.agentId,
    d.installed ? 'sim' : 'não',
    d.version ?? '-',
    authLabel(d),
    d.defaults.model ?? '-',
    String(d.mcpServers.filter((s) => !s.isHub).length),
    d.instructionFiles.length > 0 ? `${d.instructionFiles.length} arquivo(s)` : '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  const out = [bold(line(header)), ...rows.map(line)];
  const warnings = list.flatMap((d) => d.warnings.map((w) => `${d.agentId}: ${w}`));
  if (warnings.length > 0) {
    out.push('', dim('avisos:'), ...warnings.map((w) => `  ${yellow('⚠')} ${dim(w)}`));
  }
  return out.join(NEWLINE);
}

/** Detalhe de um agente (`hub discover --agent <id>`). */
export function renderDiscoveryDetail(d: AgentDiscovery): string {
  const out = [
    `${bold(d.agentId)} ${d.installed ? green('instalado') : red('não instalado')}${d.version ? ` ${dim(d.version)}` : ''}`,
    `  auth:         ${authLabel(d)}${d.auth.evidence.length > 0 ? dim(` (${d.auth.evidence.join('; ')})`) : ''}`,
    `  modelo:       ${d.defaults.model ?? '-'}${d.defaults.provider ? dim(` (${d.defaults.provider})`) : ''}`,
    `  baseUrl:      ${d.defaults.baseUrl ?? '-'}`,
    `  instruções:   ${d.instructionFiles.length === 0 ? '-' : d.instructionFiles.map((f) => `${f.path} (${f.bytes} B)`).join(', ')}`,
    `  servidores MCP (${d.mcpServers.length}):`,
  ];
  for (const s of d.mcpServers) {
    const alvo = s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : (s.url ?? '');
    const env = s.env && Object.keys(s.env).length > 0 ? dim(` env: ${Object.keys(s.env).join(',')}`) : '';
    out.push(`    - ${s.name}${s.isHub ? dim(' (Hub)') : ''} [${s.transport}] ${dim(alvo)}${env}`);
  }
  if (d.mcpServers.length === 0) out.push(`    ${dim('(nenhum)')}`);
  for (const w of d.warnings) out.push(`  ${yellow('⚠')} ${dim(w)}`);
  return out.join(NEWLINE);
}

/** Plano (dry-run) ou resultado (`--write`) de `hub import`. */
export function renderImportResult(r: ImportResult, cmdToApply?: string): string {
  const out: string[] = [
    r.dryRun ? bold(`plano de importação de ${r.agentId} ${dim('(dry-run)')}`) : bold(`importação de ${r.agentId}`),
  ];
  if (r.items.length === 0) out.push(`  ${dim('(nada a importar)')}`);
  for (const item of r.items) {
    const mark = r.dryRun ? dim('○') : item.applied ? green('✓') : yellow('–');
    out.push(`  ${mark} ${bold(item.kind.padEnd(12))} ${item.description}`);
    out.push(`      ${dim('→ ' + item.target)}`);
  }
  if (r.skipped.length > 0) {
    out.push('', dim('não importado:'));
    for (const s of r.skipped) out.push(`  ${yellow('⚠')} ${s.what}: ${dim(s.reason)}`);
  }
  if (r.dryRun && r.items.length > 0 && cmdToApply) {
    out.push('', `${dim('nada foi gravado. para aplicar:')} ${bold(cmdToApply)}`);
  }
  return out.join(NEWLINE);
}

// ------------------------------------------------------------------ comandos

export async function discoverCommand(client: HubClient, args: Args): Promise<void> {
  const agent = typeof args.flags['agent'] === 'string' ? args.flags['agent'] : undefined;
  const refresh = args.flags['refresh'] === true;

  if (agent !== undefined) {
    const { agent: d } = await client.discoverAgent(agent, refresh);
    console.log(args.flags['json'] === true ? JSON.stringify(d, null, 2) : renderDiscoveryDetail(d));
    return;
  }
  const { agents } = await client.discovery(refresh);
  console.log(args.flags['json'] === true ? JSON.stringify(agents, null, 2) : renderDiscoveryTable(agents));
}

export async function importCommand(
  client: HubClient,
  args: Args,
  resolveProjectId: (flag: string | boolean | undefined) => Promise<string>,
): Promise<void> {
  const req = buildImportRequest(args);
  if (req instanceof Error) {
    console.error(red(req.message));
    process.exitCode = 1;
    return;
  }

  const projectFlag = args.flags['project'];
  const projectId = await resolveProjectId(projectFlag);
  const result = await client.importFromAgent(projectId, req);

  if (args.flags['json'] === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const apply = ['hub import', req.agentId, ...(typeof projectFlag === 'string' ? ['--project', projectFlag] : []), '--kinds', req.kinds.join(',')]
    .concat(req.targetAgents ? ['--to', req.targetAgents.join(',')] : [])
    .concat(req.overwrite ? ['--overwrite'] : [], req.includeEnv ? ['--include-env'] : [], ['--write'])
    .join(' ');
  console.log(renderImportResult(result, apply));
}

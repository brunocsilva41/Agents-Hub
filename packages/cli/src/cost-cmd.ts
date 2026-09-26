import path from 'node:path';
import { chaveDeCaminho } from './project-resolve.js';
import type { GraphSummary, HubClient, ProjectSummary } from './client.js';
import { flagOn, flagString, imprimirJson, instanteDe, type Args } from './cmd-util.js';
import { bold, cyan, dim, formatTokens } from './render.js';

interface Soma {
  usd: number;
  tokens: number;
  sessions: number;
}

export interface CostReport {
  /** ISO; `null` = desde sempre (`--all`). */
  since: string | null;
  projectId: string | null;
  total: Soma & { flows: number };
  byAgent: Array<Soma & { agentId: string }>;
  byProject: Array<Soma & { projectId: string; name: string | null }>;
  byDay: Array<Soma & { day: string }>;
  topFlows: Array<{ rootId: string; title: string | null; agentId: string; usd: number; tokens: number; createdAt: string }>;
}

function vazio(): Soma {
  return { usd: 0, tokens: 0, sessions: 0 };
}

function acumular<K>(mapa: Map<K, Soma>, chave: K, usd: number, tokens: number): void {
  const s = mapa.get(chave) ?? vazio();
  s.usd += usd;
  s.tokens += tokens;
  s.sessions += 1;
  mapa.set(chave, s);
}

function achatar(nodes: GraphSummary[]): GraphSummary[] {
  return nodes.flatMap((n) => [n, ...achatar(n.children)]);
}

/** `--project` aceita id, caminho ou nome — e NÃO registra nada (é leitura). */
function resolverProjeto(projects: ProjectSummary[], ref: string): ProjectSummary {
  // Caminho comparado pela chave canônica (8.3 → longo, caixa no Windows),
  // o mesmo critério do registro de projetos (item 5.5).
  const caminho = chaveDeCaminho(ref);
  const achado =
    projects.find((p) => p.id === ref) ??
    projects.find((p) => chaveDeCaminho(p.path) === caminho) ??
    projects.find((p) => p.name === ref);
  if (!achado) throw new Error(`projeto "${ref}" não está registrado (veja: hub projects)`);
  return achado;
}

/**
 * Relatório agregado de custo. Unidade é o FLUXO (sessão-raiz e o que ela
 * delegou): o filtro `--since` olha quando a raiz foi criada, e o custo de
 * cada sessão vem do grafo do fluxo — a mesma fonte de `hub graph`/`budget`,
 * então os números batem com o que o resto da CLI mostra.
 */
export async function coletarCusto(
  client: HubClient,
  opts: { since: string | null; projectRef?: string },
): Promise<CostReport> {
  const { projects } = await client.projects();
  const projeto = opts.projectRef ? resolverProjeto(projects, opts.projectRef) : null;
  const { sessions } = await client.sessions(projeto ? { projectId: projeto.id } : {});
  const projetoDe = new Map(sessions.map((s) => [s.id, s.projectId]));
  const raizes = sessions.filter(
    (s) => s.parentId === null && (opts.since === null || s.createdAt >= opts.since),
  );

  const porAgente = new Map<string, Soma>();
  const porProjeto = new Map<string, Soma>();
  const porDia = new Map<string, Soma>();
  const total: Soma = vazio();
  const fluxos: CostReport['topFlows'] = [];

  for (const raiz of raizes) {
    const { graph } = await client.graph(raiz.id);
    let fluxoUsd = 0;
    let fluxoTokens = 0;
    for (const no of achatar(graph)) {
      acumular(porAgente, no.agentId, no.usd, no.tokens);
      acumular(porProjeto, projetoDe.get(no.sessionId) ?? raiz.projectId, no.usd, no.tokens);
      acumular(porDia, (no.startedAt || raiz.createdAt).slice(0, 10), no.usd, no.tokens);
      total.usd += no.usd;
      total.tokens += no.tokens;
      total.sessions += 1;
      fluxoUsd += no.usd;
      fluxoTokens += no.tokens;
    }
    fluxos.push({
      rootId: raiz.id,
      title: raiz.title,
      agentId: raiz.agentId,
      usd: fluxoUsd,
      tokens: fluxoTokens,
      createdAt: raiz.createdAt,
    });
  }

  const nomes = new Map(projects.map((p) => [p.id, p.name]));
  const porUsd = <T extends { usd: number }>(a: T, b: T): number => b.usd - a.usd;
  return {
    since: opts.since,
    projectId: projeto?.id ?? null,
    total: { ...total, flows: raizes.length },
    byAgent: [...porAgente].map(([agentId, s]) => ({ agentId, ...s })).sort(porUsd),
    byProject: [...porProjeto]
      .map(([projectId, s]) => ({ projectId, name: nomes.get(projectId) ?? null, ...s }))
      .sort(porUsd),
    byDay: [...porDia].map(([day, s]) => ({ day, ...s })).sort((a, b) => a.day.localeCompare(b.day)),
    topFlows: fluxos.sort(porUsd).slice(0, 10),
  };
}

function linha(rotulo: string, s: Soma, largura: number): string {
  return `  ${rotulo.padEnd(largura)} US$ ${s.usd.toFixed(4).padStart(10)}  ${formatTokens(s.tokens).padStart(7)} tok  ${dim(`${s.sessions} sessão(ões)`)}`;
}

/** `hub cost [--since 7d | --all] [--project X] [--json]`. */
export async function costCommand(client: HubClient, args: Args): Promise<CostReport> {
  const sinceFlag = flagString(args, 'since');
  const since = flagOn(args, 'all') ? null : instanteDe(sinceFlag ?? '7d');
  const report = await coletarCusto(client, { since, projectRef: flagString(args, 'project') });

  if (flagOn(args, 'json')) {
    imprimirJson(report);
    return report;
  }

  const periodo = since === null ? 'desde sempre' : `desde ${since.slice(0, 16).replace('T', ' ')} (UTC)`;
  console.log(`${bold('custo')} ${dim(periodo)}${report.projectId ? dim(` · projeto ${report.projectId}`) : ''}`);
  console.log(
    `${bold(`US$ ${report.total.usd.toFixed(4)}`)} · ${formatTokens(report.total.tokens)} tokens · ` +
      `${report.total.flows} fluxo(s), ${report.total.sessions} sessão(ões)`,
  );
  if (report.total.flows === 0) {
    console.log(dim('nenhum fluxo no período. amplie com --since 30d ou --all.'));
    return report;
  }
  console.log(`\n${dim('por agente')}`);
  for (const a of report.byAgent) console.log(linha(a.agentId, a, 22));
  console.log(`\n${dim('por projeto')}`);
  for (const p of report.byProject) console.log(linha(p.name ?? p.projectId, p, 22));
  console.log(`\n${dim('por dia')}`);
  for (const d of report.byDay) console.log(linha(d.day, d, 22));
  console.log(`\n${dim('fluxos mais caros')}`);
  for (const f of report.topFlows.slice(0, 5)) {
    console.log(`  ${bold(f.rootId)} ${cyan(f.agentId)} US$ ${f.usd.toFixed(4)} ${dim(f.title ?? '')}`);
  }
  console.log(dim('\ncusto informado pelos próprios agentes; o Copilot fatura em créditos, não em dólares.'));
  return report;
}

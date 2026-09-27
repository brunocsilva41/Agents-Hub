import { dataHoraLocal, rotuloDoFuso } from './hora.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { EventEnvelope } from '@agents-hub/core';
import type {
  ArtifactSummary,
  BudgetSummary,
  GraphSummary,
  HubClient,
  SessionSummary,
  TaskSummary,
} from './client.js';
import { flagOn, flagString, NEWLINE, required, semCor, type Args } from './cmd-util.js';
import { renderEvent } from './render.js';
import { bold, dim, green } from './render.js';

/** O que `hub export` junta de uma sessão — o mesmo objeto vira JSON ou Markdown. */
export interface SessionExport {
  exportedAt: string;
  session: SessionSummary;
  live: boolean;
  cost: {
    /** Só esta sessão (sem os filhos). */
    session: { usd: number; tokens: number };
    /** Esta sessão + as que ela delegou. */
    subtree: { usd: number; tokens: number };
    /** O fluxo inteiro (raiz), contra o orçamento. */
    flow: BudgetSummary;
  };
  tasks: TaskSummary[];
  graph: GraphSummary | null;
  artifacts: ArtifactSummary[];
  diff: string | null;
  events: Array<Omit<EventEnvelope, 'raw'> & { raw?: unknown }>;
}

function acharNo(nodes: GraphSummary[], id: string): GraphSummary | null {
  for (const n of nodes) {
    if (n.sessionId === id) return n;
    const achado = acharNo(n.children, id);
    if (achado) return achado;
  }
  return null;
}

function somar(n: GraphSummary): { usd: number; tokens: number } {
  return n.children.reduce(
    (acc, c) => {
      const s = somar(c);
      return { usd: acc.usd + s.usd, tokens: acc.tokens + s.tokens };
    },
    { usd: n.usd, tokens: n.tokens },
  );
}

/** Todos os eventos da sessão, página a página (o daemon devolve no máximo 5000 por vez). */
async function todosOsEventos(client: HubClient, sessionId: string): Promise<EventEnvelope[]> {
  const todos: EventEnvelope[] = [];
  let desde = 0;
  for (;;) {
    const { events } = await client.events(sessionId, { since: desde, limit: 5000 });
    todos.push(...events);
    if (events.length < 5000) return todos;
    desde = events.at(-1)!.seq;
  }
}

export async function coletarExport(
  client: HubClient,
  sessionId: string,
  opts: { raw?: boolean } = {},
): Promise<SessionExport> {
  const { session, live } = await client.session(sessionId);
  const [{ tasks }, eventos, { artifacts }, { diff }, { graph }, { budget }] = await Promise.all([
    client.tasks(sessionId),
    todosOsEventos(client, sessionId),
    client.artifacts(sessionId),
    client.diff(sessionId),
    client.graph(session.rootId),
    client.budget(session.rootId),
  ]);
  const no = acharNo(graph, sessionId);
  return {
    exportedAt: new Date().toISOString(),
    session,
    live,
    cost: {
      session: { usd: no?.usd ?? 0, tokens: no?.tokens ?? 0 },
      subtree: no ? somar(no) : { usd: 0, tokens: 0 },
      flow: budget,
    },
    tasks,
    graph: no,
    artifacts,
    diff,
    // `raw` é o evento original do agente, na íntegra: volumoso e às vezes
    // com conteúdo de ferramenta que não se quer num arquivo compartilhado.
    events: opts.raw === true ? eventos : eventos.map(({ raw: _raw, ...resto }) => resto),
  };
}

function usd(n: number): string {
  return `US$ ${n.toFixed(4)}`;
}

/** Markdown legível, sem cor, pensado para colar num PR ou numa issue. */
export function renderExportMarkdown(dados: SessionExport): string {
  const s = dados.session;
  const l: string[] = [];
  l.push(`# Sessão ${s.id}${s.title ? ` — ${s.title}` : ''}`, '');
  l.push(`- agente: ${s.agentId}`);
  l.push(`- estado: ${s.state}${dados.live ? ' (viva)' : ''}`);
  l.push(`- projeto: ${s.projectId}`);
  l.push(`- modo: ${s.mode} · isolamento: ${s.isolation}`);
  l.push(`- fluxo (raiz): ${s.rootId}${s.parentId ? ` · pai: ${s.parentId}` : ''}`);
  l.push(`- criada: ${s.createdAt}${s.endedAt ? ` · encerrada: ${s.endedAt}` : ''}`);
  l.push(`- workdir: ${s.workdir}`);
  l.push(`- exportado em: ${dados.exportedAt}`, '');

  const f = dados.cost.flow;
  l.push('## Custo', '');
  l.push(`- esta sessão: ${usd(dados.cost.session.usd)} · ${dados.cost.session.tokens} tokens`);
  l.push(`- com as delegadas: ${usd(dados.cost.subtree.usd)} · ${dados.cost.subtree.tokens} tokens`);
  l.push(
    `- fluxo inteiro: ${usd(f.consumed.usd)} de ${usd(f.limits.usd)} · ${f.consumed.tokens} tokens · ` +
      `${Math.round(f.pressure * 100)}% do orçamento${f.exhausted ? ' (esgotado)' : ''}`,
  );
  l.push('');

  if (dados.tasks.length > 0) {
    l.push('## Tarefas', '');
    for (const t of dados.tasks) {
      l.push(`### ${t.id} — ${t.state}`, '', t.brief.objective, '');
      if (t.result?.summary) l.push(`Resumo: ${t.result.summary}`, '');
      for (const c of t.result?.validation?.checks ?? []) {
        l.push(`- [${c.passed ? 'x' : ' '}] validação: ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      }
      if (t.result?.validation) l.push('');
    }
  }

  l.push(`## Timeline (${dados.events.length} eventos)`, '');
  if (dados.events.length === 0) {
    l.push('_(nenhum evento)_', '');
  } else {
    // A linha do evento traz a hora LOCAL (R07-18): a data também, e o fuso
    // fica dito uma vez, porque o arquivo pode ser lido em outra máquina.
    l.push(`_horários na hora local de quem exportou (${rotuloDoFuso(new Date(dados.events[0]!.ts).getTimezoneOffset())})_`, '');
    l.push('```text');
    for (const e of dados.events) {
      // Data completa na frente: a linha do terminal só traz a hora.
      l.push(`${dataHoraLocal(e.ts).slice(0, 10)} ${semCor(renderEvent({ ...e, raw: null } as EventEnvelope))}`);
    }
    l.push('```', '');
  }

  l.push('## Diff', '');
  if (dados.diff) {
    // Cerca mais longa que qualquer sequência de crases dentro do patch.
    const maior = Math.max(2, ...(dados.diff.match(/`+/g) ?? []).map((m) => m.length));
    const cerca = '`'.repeat(maior + 1);
    l.push(`${cerca}diff`, dados.diff.replace(/\s+$/, ''), cerca, '');
  } else {
    l.push('_(esta sessão não alterou nenhum arquivo)_', '');
  }

  if (dados.artifacts.length > 0) {
    l.push('## Artefatos', '');
    for (const a of dados.artifacts) l.push(`- ${a.kind}: ${a.path} (${a.createdAt})`);
    l.push('');
  }
  return l.join(NEWLINE);
}

/**
 * `hub export <sessionId> [--format md|json] [--out arquivo] [--raw]` —
 * timeline, custo, tarefas e diff num arquivo só. Sem `--out`, imprime no
 * stdout (pipe-friendly). Não sobrescreve arquivo existente sem `--force`.
 */
export async function exportCommand(client: HubClient, args: Args): Promise<void> {
  const sessionId = required(args.positional[0], 'sessionId');
  const out = flagString(args, 'out');
  const formato = flagString(args, 'format') ?? (out && /\.json$/i.test(out) ? 'json' : 'md');
  if (formato !== 'md' && formato !== 'json') {
    throw new Error(`--format inválido: "${formato}" (use md ou json)`);
  }

  const dados = await coletarExport(client, sessionId, { raw: flagOn(args, 'raw') });
  const texto = formato === 'json' ? JSON.stringify(dados, null, 2) : renderExportMarkdown(dados);

  if (out === undefined) {
    console.log(texto);
    return;
  }
  const destino = path.resolve(out);
  if (existsSync(destino) && !flagOn(args, 'force')) {
    throw new Error(`${destino} já existe — use outro --out ou --force para sobrescrever`);
  }
  mkdirSync(path.dirname(destino), { recursive: true });
  writeFileSync(destino, texto.endsWith(NEWLINE) ? texto : texto + NEWLINE, 'utf8');
  console.log(`${green('exportado')} ${bold(destino)} ${dim(`(${formato}, ${dados.events.length} eventos)`)}`);
}

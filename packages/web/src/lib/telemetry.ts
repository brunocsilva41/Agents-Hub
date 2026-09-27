/**
 * Métricas da aba Telemetria, com as MESMAS definições do resto do painel.
 *
 * A vistoria (2026-09-25, 03, BAIXO "Telemetria rasa e inconsistente") achou
 * "Ativas" contando só rodando/aguardando enquanto a pílula "ao vivo" e a lista
 * contavam também pausada/ociosa, taxa de conclusão sobre o total (sessão em
 * andamento contava como fracasso) e nenhum custo. Aqui:
 *
 * - "ao vivo" é `isLiveState`, a mesma função da pílula do topo e da lista;
 * - a taxa é sobre o que TERMINOU, e sem nada terminado não há taxa (`null`);
 * - custo e tokens vêm do `/graph/:rootId` do daemon — a única rota que expõe
 *   custo POR SESSÃO (e portanto por agente). Nenhuma rota nova.
 *
 * O daemon guarda o custo acumulado de cada sessão, não uma série no tempo:
 * o custo de uma sessão conta no período em que ela COMEÇOU (`startedAt`). A
 * tela diz isso.
 */
import { isLiveState } from './sessionControls.js';

export type Periodo = '24h' | '7d' | '30d' | 'tudo';

export const PERIODOS: ReadonlyArray<{ id: Periodo; rotulo: string }> = [
  { id: '24h', rotulo: 'Últimas 24 h' },
  { id: '7d', rotulo: 'Últimos 7 dias' },
  { id: '30d', rotulo: 'Últimos 30 dias' },
  { id: 'tudo', rotulo: 'Tudo' },
];

const HORA = 3_600_000;
const DIA = 24 * HORA;
const DURACAO: Record<Exclude<Periodo, 'tudo'>, number> = { '24h': DIA, '7d': 7 * DIA, '30d': 30 * DIA };

/** Início do período em ms, ou `null` para "tudo". */
export function inicioDoPeriodo(periodo: Periodo, agora: number): number | null {
  return periodo === 'tudo' ? null : agora - DURACAO[periodo];
}

function dentro(iso: string, desde: number | null): boolean {
  if (desde === null) return true;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= desde;
}

export interface SessaoMinima {
  state: string;
  createdAt: string;
}

export interface ResumoDeSessoes {
  /** Sessões criadas no período. */
  total: number;
  /** Ao vivo AGORA (qualquer período): mesma conta da pílula do topo. */
  aoVivo: number;
  concluidas: number;
  falharam: number;
  encerradas: number;
  /** Terminadas no período (concluída, falhou ou encerrada). */
  terminadas: number;
  /** Concluídas ÷ terminadas; `null` sem nenhuma terminada. */
  taxaDeConclusao: number | null;
}

export function resumoDeSessoes(
  sessions: readonly SessaoMinima[],
  periodo: Periodo,
  agora: number,
): ResumoDeSessoes {
  const desde = inicioDoPeriodo(periodo, agora);
  const noPeriodo = sessions.filter((s) => dentro(s.createdAt, desde));
  const conta = (estado: string): number => noPeriodo.filter((s) => s.state === estado).length;
  const concluidas = conta('completed');
  const terminadas = noPeriodo.filter((s) => !isLiveState(s.state)).length;
  return {
    total: noPeriodo.length,
    aoVivo: sessions.filter((s) => isLiveState(s.state)).length,
    concluidas,
    falharam: conta('failed'),
    encerradas: conta('killed'),
    terminadas,
    taxaDeConclusao: terminadas > 0 ? concluidas / terminadas : null,
  };
}

/** Nó do `/graph`: o que a telemetria usa dele. */
export interface NoDeCusto {
  sessionId: string;
  agentId: string;
  usd: number;
  tokens: number;
  startedAt: string;
  children: NoDeCusto[];
}

/** Todos os nós da árvore, em pré-ordem, sem repetir sessão. */
export function achatarGrafo<N extends NoDeCusto>(nos: readonly N[]): N[] {
  const vistos = new Set<string>();
  const saida: N[] = [];
  const visitar = (no: N): void => {
    if (vistos.has(no.sessionId)) return;
    vistos.add(no.sessionId);
    saida.push(no);
    for (const filho of no.children) visitar(filho as N);
  };
  for (const no of nos) visitar(no);
  return saida;
}

/**
 * Fluxos que PODEM ter sessão começada no período: o `updatedAt` de um fluxo é
 * o da sessão mais recente, que nunca é anterior ao começo de nenhuma. Os
 * outros não precisam de `/graph` para esta tela.
 */
export function fluxosDoPeriodo<F extends { updatedAt: string }>(
  flows: readonly F[],
  periodo: Periodo,
  agora: number,
): F[] {
  const desde = inicioDoPeriodo(periodo, agora);
  return flows.filter((f) => dentro(f.updatedAt, desde));
}

export interface CustoDoAgente {
  agentId: string;
  usd: number;
  tokens: number;
  sessoes: number;
}

/** Custo e tokens por agente, das sessões começadas no período; maior custo primeiro. */
export function custoPorAgente(
  nos: readonly NoDeCusto[],
  periodo: Periodo,
  agora: number,
): CustoDoAgente[] {
  const desde = inicioDoPeriodo(periodo, agora);
  const por = new Map<string, CustoDoAgente>();
  for (const no of achatarGrafo(nos)) {
    if (!dentro(no.startedAt, desde)) continue;
    const linha = por.get(no.agentId) ?? { agentId: no.agentId, usd: 0, tokens: 0, sessoes: 0 };
    linha.usd += no.usd;
    linha.tokens += no.tokens;
    linha.sessoes += 1;
    por.set(no.agentId, linha);
  }
  return [...por.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens || a.agentId.localeCompare(b.agentId));
}

export interface FaixaDeCusto {
  /** Início da faixa (ms). */
  inicio: number;
  fim: number;
  usd: number;
  tokens: number;
}

/**
 * Custo no tempo em faixas iguais: 24 de 1 h, 7 ou 30 de 1 dia; "tudo" em 12
 * faixas do começo da primeira sessão até agora. Faixas contadas para trás a
 * partir de agora — sem alinhar ao relógio, que dependeria do fuso.
 */
export function custoNoTempo(nos: readonly NoDeCusto[], periodo: Periodo, agora: number): FaixaDeCusto[] {
  const todos = achatarGrafo(nos).filter((n) => Number.isFinite(Date.parse(n.startedAt)));
  let desde = inicioDoPeriodo(periodo, agora);
  let n = periodo === '24h' ? 24 : periodo === '7d' ? 7 : periodo === '30d' ? 30 : 12;
  if (desde === null) {
    if (todos.length === 0) return [];
    desde = Math.min(...todos.map((x) => Date.parse(x.startedAt)));
    if (desde >= agora) n = 1;
  }
  const passo = Math.max(1, (agora - desde) / n);
  const faixas: FaixaDeCusto[] = Array.from({ length: n }, (_, i) => ({
    inicio: desde! + i * passo,
    fim: desde! + (i + 1) * passo,
    usd: 0,
    tokens: 0,
  }));
  for (const no of todos) {
    const t = Date.parse(no.startedAt);
    if (t < desde || t > agora) continue;
    const i = Math.min(n - 1, Math.floor((t - desde) / passo));
    faixas[i]!.usd += no.usd;
    faixas[i]!.tokens += no.tokens;
  }
  return faixas;
}

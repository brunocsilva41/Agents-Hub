import type { EventEnvelope } from '@agents-hub/core';

/**
 * Timeline de UMA sessão: o que já chegou (histórico + ao vivo), sem duplicata
 * e em ordem de `seq`.
 *
 * Lógica pura, sem React: é o que permite testar a mescla que antes estava
 * espalhada em `setEvents` — e que perdia histórico em dois pontos. (1) O SSE
 * global grava eventos da sessão antes de alguém abri-la; o cache deixava de
 * estar vazio e o histórico nunca era buscado. (2) Quando era buscado, a
 * resposta SUBSTITUÍA o array e descartava o que o SSE tinha trazido durante a
 * requisição.
 */

/** Teto de eventos guardados por sessão enquanto só chegam ao vivo. */
export const MAX_LIVE_EVENTS = 3000;

/** Tamanho de cada página de histórico pedida ao daemon. */
export const HISTORY_PAGE = 500;

/**
 * Junta duas listas da MESMA sessão por `seq` (a identidade de um evento dentro
 * da sessão). Em caso de repetição fica a versão de `incoming` — é a mais nova
 * que se tem. O resultado sai ordenado por `seq`.
 *
 * Caminho rápido para o caso comum (tudo de `incoming` depois do fim de
 * `existing`, ou tudo antes do começo): concatena sem mapa nem ordenação.
 */
export function mergeBySeq(
  existing: readonly EventEnvelope[],
  incoming: readonly EventEnvelope[],
): EventEnvelope[] {
  if (incoming.length === 0) return existing as EventEnvelope[];
  if (existing.length === 0) return sortedCopy(incoming);

  const sortedIncoming = sortedCopy(incoming);
  const firstIn = sortedIncoming[0] as EventEnvelope;
  const lastIn = sortedIncoming[sortedIncoming.length - 1] as EventEnvelope;
  const firstEx = existing[0] as EventEnvelope;
  const lastEx = existing[existing.length - 1] as EventEnvelope;

  if (firstIn.seq > lastEx.seq) return [...existing, ...sortedIncoming];
  if (lastIn.seq < firstEx.seq) return [...sortedIncoming, ...existing];

  const bySeq = new Map<number, EventEnvelope>();
  for (const event of existing) bySeq.set(event.seq, event);
  for (const event of sortedIncoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function sortedCopy(list: readonly EventEnvelope[]): EventEnvelope[] {
  for (let i = 1; i < list.length; i += 1) {
    if ((list[i] as EventEnvelope).seq <= (list[i - 1] as EventEnvelope).seq) {
      const bySeq = new Map<number, EventEnvelope>();
      for (const event of list) bySeq.set(event.seq, event);
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    }
  }
  return [...list];
}

/**
 * Um evento que chegou pelo SSE.
 *
 * Devolve a MESMA referência quando é duplicado (reconexão reenvia o fim da
 * fila) — quem chama usa isso para não disparar render à toa. `trimmed` diz se
 * o teto cortou o começo: aí a timeline passa a ter "mais antigos" no servidor.
 */
export function appendLive(
  existing: readonly EventEnvelope[],
  event: EventEnvelope,
  cap = MAX_LIVE_EVENTS,
): { events: EventEnvelope[]; trimmed: boolean } {
  const last = existing[existing.length - 1];
  let next: EventEnvelope[];
  if (!last || event.seq > last.seq) {
    next = [...existing, event];
  } else {
    // Fora de ordem ou repetido: a busca de trás para frente acha o duplicado
    // nas primeiras comparações, porque o que volta é sempre o fim da fila.
    for (let i = existing.length - 1; i >= 0; i -= 1) {
      if ((existing[i] as EventEnvelope).seq === event.seq) {
        return { events: existing as EventEnvelope[], trimmed: false };
      }
    }
    next = mergeBySeq(existing, [event]);
  }
  if (next.length > cap) return { events: next.slice(next.length - cap), trimmed: true };
  return { events: next, trimmed: false };
}

/** Situação do histórico de uma sessão no painel. */
export interface HistoryState {
  /** `loading` só na primeira busca; depois fica `ready` mesmo recarregando. */
  status: 'idle' | 'loading' | 'ready' | 'failed';
  /** Há eventos mais antigos no daemon que ainda não foram pedidos. */
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  /** A última busca de página anterior falhou (o botão oferece tentar de novo). */
  olderFailed: boolean;
  /** Falhas seguidas da busca atual (zera no sucesso). */
  failures: number;
  /** Quando a próxima tentativa automática acontece (epoch ms), ou `null`. */
  nextRetryAt: number | null;
}

export const INITIAL_HISTORY: HistoryState = {
  status: 'idle',
  hasMoreBefore: false,
  loadingOlder: false,
  olderFailed: false,
  failures: 0,
  nextRetryAt: null,
};

/**
 * Uma página pedida "pelo fim" ou "antes de X" que veio cheia provavelmente
 * não é a última. Uma que veio com menos que o pedido é, com certeza.
 */
export function pageHasMore(received: number, requested = HISTORY_PAGE): boolean {
  return received >= requested;
}

/** Menor `seq` carregado — o cursor da próxima página para trás. */
export function oldestSeq(events: readonly EventEnvelope[]): number | null {
  return events.length > 0 ? (events[0] as EventEnvelope).seq : null;
}

/** Maior `seq` carregado — de onde repor o buraco depois de uma reconexão. */
export function newestSeq(events: readonly EventEnvelope[]): number | null {
  return events.length > 0 ? (events[events.length - 1] as EventEnvelope).seq : null;
}

/** Tentativas automáticas antes de desistir e pedir um clique. */
export const MAX_AUTO_RETRIES = 5;

/**
 * Espera antes da tentativa `failures` + 1: 1 s, 2 s, 4 s, 8 s, 16 s (teto de
 * 30 s). `null` quando já passou do limite automático — daí em diante só o
 * botão "tentar de novo" dispara nova busca, para não martelar um daemon fora.
 */
export function retryDelayMs(failures: number): number | null {
  if (failures < 1) return 0;
  if (failures > MAX_AUTO_RETRIES) return null;
  return Math.min(30_000, 1000 * 2 ** (failures - 1));
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HubError, type EventEnvelope } from '@agents-hub/core';

/**
 * Canal SSE compartilhado por `/events` e `/api/tasks/:id/events`.
 *
 * Antes desta extração as duas rotas divergiam na origem: só `/events` tinha
 * keep-alive e `id:`, e nenhuma das duas tratava erro de escrita ou cliente
 * lento. Consertar as duas em paralelo é como a divergência nasceu da
 * primeira vez — por isso a lógica mora aqui uma vez só, e as rotas só
 * decidem O QUE mandar, não COMO manter o canal vivo.
 */

/** Proxies e antivírus derrubam conexão ociosa; o ping periódico evita isso. */
export const SSE_KEEPALIVE_MS = 20_000;

/**
 * Fila local por conexão antes de desistir de um cliente lento.
 *
 * O bus é síncrono — `publish` chama o handler de cada assinante direto, sem
 * fila própria. Sem este teto, um cliente que não lê o socket (aba em
 * background, rede ruim) faria a fila crescer para sempre na heap do daemon
 * enquanto a sessão que ele observa continua produzindo eventos.
 */
export const SSE_QUEUE_CAP = 200;

export interface SseChannel {
  /**
   * Enfileira ou escreve um evento. `withId` pode ser sobrescrito por
   * evento — usado pelo aviso sintético de truncamento, que não tem `seq`
   * real e não deve interferir no `Last-Event-ID` da reconexão. `id` troca o
   * `seq` por um id explícito — usado pelo stream da task, onde o `seq` sozinho
   * seria ambíguo entre sessões (ver `formatarCursorDaTask`).
   */
  send(event: EventEnvelope, opts?: SseSendOptions): void;
  /** Encerra o canal: limpa o timer, larga a fila e chama `onClose` uma vez. */
  close(): void;
  /**
   * Fim normal do stream: entrega o que ainda está na fila e só então fecha a
   * resposta. `close()` larga a fila — certo para cliente que caiu ou ficou
   * lento demais, errado para "acabou": o cliente perderia o final.
   */
  end(): void;
  readonly closed: boolean;
}

export interface SseSendOptions {
  withId?: boolean;
  /** Id explícito do evento; tem precedência sobre `withId`. */
  id?: string;
}

export interface SseChannelOptions {
  /** Envia `id: <seq>` em cada evento — só faz sentido em stream de UMA sessão. */
  withId: boolean;
  /** Chamado no fechamento: fechar socket, erro de escrita, ou fila estourada. */
  onClose?: () => void;
  keepAliveMs?: number;
  queueCap?: number;
}

function formatSseEvent(event: EventEnvelope, id: string | null): string {
  const linhaId = id !== null ? `id: ${id}\n` : '';
  return `${linhaId}data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Abre o canal: cabeçalhos SSE devem já ter sido escritos por quem chama
 * (`res.writeHead`) — este helper só cuida do ciclo de vida da conexão daqui
 * para frente.
 */
export function startSseChannel(
  req: IncomingMessage,
  res: ServerResponse,
  opts: SseChannelOptions,
): SseChannel {
  const keepAliveMs = opts.keepAliveMs ?? SSE_KEEPALIVE_MS;
  const queueCap = opts.queueCap ?? SSE_QUEUE_CAP;

  const queue: EventEnvelope[] = [];
  const queueIds: Array<string | null> = [];
  let draining = false;
  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    res.removeListener('drain', onDrain);
    queue.length = 0;
    queueIds.length = 0;
    opts.onClose?.();
  };

  /**
   * Único ponto que toca `res.write`.
   *
   * Cheque de `writableEnded`/`destroyed` ANTES de escrever: entre o `close`
   * do socket e o próximo tick de um timer (ou o próximo evento do bus), a
   * conexão pode já estar morta sem que `req.on('close')` tenha disparado
   * ainda — escrever nela lançaria. `try/catch` cobre o que o cheque não
   * pega (ex.: conexão derrubada no meio da própria chamada a `write`).
   */
  const writeChunk = (chunk: string): boolean => {
    if (closed) return false;
    if (res.writableEnded || res.destroyed) {
      cleanup();
      return false;
    }
    try {
      return res.write(chunk);
    } catch {
      cleanup();
      return false;
    }
  };

  const flush = (): void => {
    while (queue.length > 0) {
      const event = queue[0] as EventEnvelope;
      const id = queueIds[0] as string | null;
      const ok = writeChunk(formatSseEvent(event, id));
      if (closed) return;
      if (!ok) {
        draining = true;
        return;
      }
      queue.shift();
      queueIds.shift();
    }
    draining = false;
  };

  const onDrain = (): void => {
    draining = false;
    flush();
  };
  res.on('drain', onDrain);

  const send = (event: EventEnvelope, sendOpts: SseSendOptions = {}): void => {
    if (closed) return;
    const withId = sendOpts.withId ?? opts.withId;
    const id = sendOpts.id ?? (withId ? String(event.seq) : null);

    if (draining || queue.length > 0) {
      if (queue.length >= queueCap) {
        // Cliente lento demais para acompanhar: encerra em vez de deixar a
        // fila crescer sem limite na heap do daemon.
        cleanup();
        try {
          res.end();
        } catch {
          // já pode estar fechado; não há o que fazer.
        }
        return;
      }
      queue.push(event);
      queueIds.push(id);
      return;
    }

    const ok = writeChunk(formatSseEvent(event, id));
    if (!closed && !ok) draining = true;
  };

  const keepAlive = setInterval(() => {
    writeChunk(': ping\n\n');
  }, keepAliveMs);
  // Um ping periódico não deve, sozinho, impedir o processo de sair.
  keepAlive.unref?.();

  const end = (): void => {
    if (closed) return;
    // A fila já é limitada pelo teto; escrever tudo de uma vez só deixa o
    // resto no buffer do próprio socket, que o Node entrega antes do `end`.
    while (queue.length > 0 && !closed) {
      writeChunk(formatSseEvent(queue.shift() as EventEnvelope, queueIds.shift() as string | null));
    }
    if (closed) return;
    cleanup();
    try {
      res.end();
    } catch {
      // já pode estar fechado; não há o que fazer.
    }
  };

  req.on('close', cleanup);

  return {
    send,
    close: cleanup,
    end,
    get closed(): boolean {
      return closed;
    },
  };
}

// ------------------------------------------------ reconexão do stream da task

/**
 * Posição de reconexão do stream de UMA task: o último `seq` entregue de cada
 * sessão por onde a task passou.
 *
 * Um `seq` só não serve: ele é por sessão, e a task troca de sessão num
 * fallback — `id: 7` poderia ser o 7 da original ou o 7 do substituto. Um par
 * `sessão:seq` só também não: a original ainda pode emitir (o fim dela chega
 * depois do primeiro evento do substituto), e reconectar a partir do último
 * par visto perderia esse resto. Por isso o id carrega o ponto de TODAS as
 * sessões: `ses_a:12,ses_b:5`. Dentro de uma sessão os eventos saem sempre em
 * ordem de `seq`, então "tudo com `seq` maior que o do cursor" é exatamente o
 * que falta, sem repetir nem pular.
 */
export type CursorDaTask = Map<string, number>;

const ENTRADA_DO_CURSOR = /^(ses_[a-z0-9]{1,60}):(\d{1,15})$/i;

/** Serializa na ordem em que as sessões apareceram — estável entre eventos. */
export function formatarCursorDaTask(cursor: ReadonlyMap<string, number>): string {
  return [...cursor].map(([sessao, seq]) => `${sessao}:${seq}`).join(',');
}

function cursorInvalido(valor: string, motivo: string): HubError {
  return new HubError('INVALID_QUERY', `Last-Event-ID inválido: ${motivo}`, { valor });
}

/**
 * Lê o `Last-Event-ID` da reconexão.
 *
 * Ausente ou vazio é "sem cursor" (replay desde o começo): é o que o
 * `EventSource` manda quando nunca recebeu um id. Presente-e-malformado é 400,
 * pelo mesmo motivo do `since` de `/events` (`parseSseSince`): cair em replay
 * completo em silêncio entregaria duplicado a um cliente que acha que pediu
 * só o que faltava. Sessão que não é da task também é 400 — o id veio de outro
 * stream, e usá-lo aqui misturaria posições que não se referem a esta task.
 */
export function lerCursorDaTask(
  valor: string | undefined,
  sessoesDaTask: readonly string[],
): CursorDaTask {
  const cursor: CursorDaTask = new Map();
  if (valor === undefined || valor.trim() === '') return cursor;
  const permitidas = new Set(sessoesDaTask);
  for (const entrada of valor.split(',')) {
    const casou = ENTRADA_DO_CURSOR.exec(entrada);
    if (!casou) throw cursorInvalido(valor, `esperado "ses_<id>:<seq>[,...]", veio "${entrada}"`);
    const sessao = casou[1] as string;
    if (cursor.has(sessao)) throw cursorInvalido(valor, `sessão ${sessao} repetida`);
    if (!permitidas.has(sessao)) throw cursorInvalido(valor, `sessão ${sessao} não é desta task`);
    cursor.set(sessao, Number(casou[2]));
  }
  return cursor;
}

/**
 * Intercala as timelines das sessões da task por `ts`, sem nunca inverter a
 * ordem de `seq` dentro de uma sessão.
 *
 * Um `sort` por `ts` do conjunto todo inverteria dois eventos da mesma sessão
 * se o relógio voltasse entre eles — e o cursor, que guarda o MAIOR `seq`
 * entregue, passaria a pular o evento que saiu depois do maior. Mesclar
 * listas já ordenadas preserva a ordem interna de cada uma por construção.
 */
export function intercalarTimelines(timelines: readonly EventEnvelope[][]): EventEnvelope[] {
  const posicoes = timelines.map(() => 0);
  const saida: EventEnvelope[] = [];
  for (;;) {
    let escolhida = -1;
    for (let i = 0; i < timelines.length; i += 1) {
      const candidato = timelines[i]?.[posicoes[i] as number];
      if (!candidato) continue;
      const atual = escolhida >= 0 ? timelines[escolhida]?.[posicoes[escolhida] as number] : undefined;
      if (!atual || candidato.ts < atual.ts) escolhida = i;
    }
    if (escolhida < 0) return saida;
    saida.push(timelines[escolhida]?.[posicoes[escolhida] as number] as EventEnvelope);
    posicoes[escolhida] = (posicoes[escolhida] as number) + 1;
  }
}

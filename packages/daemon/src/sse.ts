import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventEnvelope } from '@agents-hub/core';

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
   * real e não deve interferir no `Last-Event-ID` da reconexão.
   */
  send(event: EventEnvelope, opts?: { withId?: boolean }): void;
  /** Encerra o canal: limpa o timer, larga a fila e chama `onClose` uma vez. */
  close(): void;
  readonly closed: boolean;
}

export interface SseChannelOptions {
  /** Envia `id: <seq>` em cada evento — só faz sentido em stream de UMA sessão. */
  withId: boolean;
  /** Chamado no fechamento: fechar socket, erro de escrita, ou fila estourada. */
  onClose?: () => void;
  keepAliveMs?: number;
  queueCap?: number;
}

function formatSseEvent(event: EventEnvelope, withId: boolean): string {
  const id = withId ? `id: ${event.seq}\n` : '';
  return `${id}data: ${JSON.stringify(event)}\n\n`;
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
  const queueWithId: boolean[] = [];
  let draining = false;
  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    res.removeListener('drain', onDrain);
    queue.length = 0;
    queueWithId.length = 0;
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
      const withId = queueWithId[0] as boolean;
      const ok = writeChunk(formatSseEvent(event, withId));
      if (closed) return;
      if (!ok) {
        draining = true;
        return;
      }
      queue.shift();
      queueWithId.shift();
    }
    draining = false;
  };

  const onDrain = (): void => {
    draining = false;
    flush();
  };
  res.on('drain', onDrain);

  const send = (event: EventEnvelope, sendOpts: { withId?: boolean } = {}): void => {
    if (closed) return;
    const withId = sendOpts.withId ?? opts.withId;

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
      queueWithId.push(withId);
      return;
    }

    const ok = writeChunk(formatSseEvent(event, withId));
    if (!closed && !ok) draining = true;
  };

  const keepAlive = setInterval(() => {
    writeChunk(': ping\n\n');
  }, keepAliveMs);
  // Um ping periódico não deve, sozinho, impedir o processo de sair.
  keepAlive.unref?.();

  req.on('close', cleanup);

  return {
    send,
    close: cleanup,
    get closed(): boolean {
      return closed;
    },
  };
}

import type { IncomingMessage } from 'node:http';
import { HubError } from '@agents-hub/core';

/**
 * Leitura do corpo HTTP e decodificação da URL — as duas bordas por onde um
 * cliente mal-formado transformava erro DELE em 500 ou em conexão pendurada.
 *
 * - JSON malformado virava `500 INTERNAL` com a mensagem crua do parser;
 *   agora é `400 INVALID_JSON`.
 * - Corpo acima do limite virava `500` DEPOIS de ler 5 MB; agora é
 *   `413 PAYLOAD_TOO_LARGE`, recusado pelo `Content-Length` declarado antes de
 *   ler um byte, e cortado no primeiro pedaço que passa do limite quando o
 *   tamanho não foi declarado (chunked). O excedente nunca vai para memória.
 * - `%` malformado fazia `decodeURIComponent` lançar fora de qualquer `try`,
 *   e a conexão ficava pendurada; agora é `400 MALFORMED_URL`.
 */

/** Teto de corpo aceito pelo daemon. */
export const LIMITE_CORPO_BYTES = 5_000_000;

function corpoGrande(limite: number): HubError {
  return new HubError(
    'PAYLOAD_TOO_LARGE',
    `corpo da requisição maior que ${Math.round(limite / 1_000_000)} MB`,
    { limiteBytes: limite },
  );
}

/**
 * Lê o corpo e devolve o JSON parseado (`{}` para corpo vazio).
 *
 * Em 413 o resto do corpo é descartado sem ser guardado (`descartarResto`) e
 * o cliente recebe o 413 inteiro antes de a conexão seguir ou cair.
 */
export function readJsonBody(
  req: IncomingMessage,
  limite: number = LIMITE_CORPO_BYTES,
): Promise<unknown> {
  const declarado = Number(primeiro(req.headers['content-length']) ?? NaN);
  if (Number.isFinite(declarado) && declarado > limite) {
    descartarResto(req);
    return Promise.reject(corpoGrande(limite));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const parar = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limite) {
        // Para de acumular aqui: nada além deste pedaço entra na memória.
        parar();
        chunks.length = 0;
        descartarResto(req);
        reject(corpoGrande(limite));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      parar();
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        // A mensagem do parser não sai: ela é detalhe interno e às vezes
        // ecoa pedaços do próprio corpo.
        reject(new HubError('INVALID_JSON', 'corpo da requisição não é JSON válido'));
      }
    };
    const onError = (err: Error): void => {
      parar();
      reject(err);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** Quanto do excedente o daemon aceita DESCARTAR antes de cortar a conexão. */
const TETO_DESCARTE_BYTES = 64_000_000;

/**
 * Consome o resto do corpo SEM guardar nada, para que o cliente receba o 413.
 *
 * Fechar o socket com dados não lidos no buffer faz o sistema mandar RST — e
 * no Windows o RST apaga a resposta que o cliente ainda não leu: ele via
 * `ECONNRESET` em vez do 413. Descartar é barato (nenhum byte é retido); o
 * teto impede que um cliente mantenha o daemon ocupado para sempre.
 */
function descartarResto(req: IncomingMessage): void {
  let descartado = 0;
  req.on('data', (chunk: Buffer) => {
    descartado += chunk.length;
    if (descartado > TETO_DESCARTE_BYTES) req.socket.destroy();
  });
  req.on('error', () => {
    /* conexão cortada: nada a fazer */
  });
  req.resume();
}

/** `decodeURIComponent` que vira 400 em vez de exceção solta. */
export function decodificarSegmento(segmento: string): string {
  try {
    return decodeURIComponent(segmento);
  } catch {
    throw new HubError('MALFORMED_URL', 'URL com codificação percentual (%) malformada', {
      segmento: segmento.slice(0, 200),
    });
  }
}

/** Erro que é culpa da URL do cliente (não do daemon). */
export function ehErroDeUrl(err: unknown): boolean {
  if (err instanceof URIError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_INVALID_URL';
}

function primeiro(valor: string | string[] | undefined): string | null {
  if (valor === undefined) return null;
  return Array.isArray(valor) ? (valor[0] ?? null) : valor;
}

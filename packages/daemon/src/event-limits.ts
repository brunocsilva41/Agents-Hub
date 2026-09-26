import type { EventEnvelope } from '@agents-hub/core';

/**
 * Tetos de tamanho de evento (vistoria 2026-09-25, item 2.5).
 *
 * Sem eles, um `tool_result` de 5 MB ia inteiro para `raw_json` (o mapper do
 * Claude já cortava `payload.content`, mas `raw` guardava o bloco todo), uma
 * linha de 60 MB virava um evento de 60 MB duplicado em payload e raw, e
 * `GET /sessions/:id/events` chegou a responder 125 MB de uma vez. O evento é
 * a timeline — texto para ler, não arquivo para guardar —, então o que passa
 * do teto é cortado com a marca `[truncado N bytes]`.
 */
export const LIMITES_DE_EVENTO = {
  /** Cada string dentro do `payload`, em caracteres. */
  textoMax: 32 * 1024,
  /** `payload` inteiro serializado, em bytes. */
  payloadMax: 256 * 1024,
  /** `raw` serializado, em bytes. `raw` só serve para depurar mapper. */
  rawMax: 16 * 1024,
} as const;

/** Tetos por sessão, contados enquanto o daemon está no ar. */
export const LIMITES_DE_SESSAO = {
  /** Bytes (payload + raw) persistidos por sessão antes de entrar em modo econômico. */
  bytesMax: 64 * 1024 * 1024,
  /** Eventos persistidos por sessão antes de entrar em modo econômico. */
  eventosMax: 100_000,
  /** No modo econômico, cada string do payload fica com no máximo isto. */
  textoEconomico: 2 * 1024,
} as const;

/** Orçamento de bytes de uma página de `GET /sessions/:id/events`. */
export const PAGINA_BYTES_MAX = 8 * 1024 * 1024;

/** Mesma marca que o leitor de linhas dos adapters usa. */
function marca(bytes: number): string {
  return ` [truncado ${bytes} bytes]`;
}

const bytesDe = (s: string): number => Buffer.byteLength(s, 'utf8');

interface Truncador {
  cortados: number;
}

function cortarTexto(texto: string, max: number, t: Truncador): string {
  if (texto.length <= max) return texto;
  const resto = bytesDe(texto.slice(max));
  t.cortados += resto;
  return texto.slice(0, max) + marca(resto);
}

/** Percorre o payload cortando strings longas; profundidade limitada por segurança. */
function cortarValor(valor: unknown, max: number, t: Truncador, profundidade: number): unknown {
  if (typeof valor === 'string') return cortarTexto(valor, max, t);
  if (valor === null || typeof valor !== 'object') return valor;
  if (profundidade > 8) {
    const json = JSON.stringify(valor) ?? '';
    return cortarTexto(json, max, t);
  }
  if (Array.isArray(valor)) return valor.map((v) => cortarValor(v, max, t, profundidade + 1));
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor)) saida[k] = cortarValor(v, max, t, profundidade + 1);
  return saida;
}

export interface EventoLimitado {
  payload: Record<string, unknown>;
  raw: unknown;
  /** Bytes (payload + raw) do evento já limitado. */
  bytes: number;
  truncado: boolean;
}

/**
 * Aplica os tetos a um evento. `textoMax` pode ser apertado (modo econômico
 * da sessão, ou página HTTP que já estourou o orçamento).
 */
export function limitarEvento(
  evento: { payload: Record<string, unknown>; raw: unknown },
  opts: { textoMax?: number; semRaw?: boolean } = {},
): EventoLimitado {
  const textoMax = opts.textoMax ?? LIMITES_DE_EVENTO.textoMax;
  const t: Truncador = { cortados: 0 };

  let payload = cortarValor(evento.payload, textoMax, t, 0) as Record<string, unknown>;
  let payloadJson = JSON.stringify(payload) ?? '{}';
  if (bytesDe(payloadJson) > LIMITES_DE_EVENTO.payloadMax) {
    // Muitos campos médios somando além do teto: guarda os escalares curtos
    // (tipo, stream, ids) e o começo do resto como texto.
    const escalares: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'number' || typeof v === 'boolean' || v === null) escalares[k] = v;
      else if (typeof v === 'string' && v.length <= 256) escalares[k] = v;
    }
    const resto = bytesDe(payloadJson) - textoMax;
    t.cortados += Math.max(0, resto);
    payload = { ...escalares, text: payloadJson.slice(0, textoMax) + marca(Math.max(0, resto)) };
    payloadJson = JSON.stringify(payload);
  }

  let raw = evento.raw;
  let rawBytes = 0;
  if (opts.semRaw) {
    raw = null;
  } else if (raw !== null && raw !== undefined) {
    const rawJson = typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? '');
    rawBytes = bytesDe(rawJson);
    if (rawBytes > LIMITES_DE_EVENTO.rawMax) {
      // `raw` cortado vira string: o objeto original não cabe, e metade de
      // um JSON não é JSON. Continua servindo para depurar o começo.
      const corte = rawJson.slice(0, LIMITES_DE_EVENTO.rawMax);
      const resto = rawBytes - bytesDe(corte);
      t.cortados += resto;
      raw = corte + marca(resto);
      rawBytes = bytesDe(raw as string);
    }
  }

  if (t.cortados > 0) {
    payload = { ...payload, truncated: true, truncatedBytes: t.cortados };
    payloadJson = JSON.stringify(payload);
  }

  return { payload, raw, bytes: bytesDe(payloadJson) + rawBytes, truncado: t.cortados > 0 };
}

/**
 * Teto de saída por sessão. Até o teto, só os limites por evento valem.
 * Passado o teto, a sessão entra em modo econômico: `log` (stdout/stderr
 * crus, o grosso de uma rajada) deixa de ser persistido, os demais eventos
 * perdem `raw` e ficam com strings curtas — a timeline continua dizendo o que
 * aconteceu, sem o banco crescer sem limite. O aviso sai uma vez só.
 */
export class TetoDeSaida {
  readonly #uso = new Map<string, { eventos: number; bytes: number; avisado: boolean; descartados: number }>();

  constructor(
    private readonly limites: { bytesMax: number; eventosMax: number; textoEconomico: number } = LIMITES_DE_SESSAO,
  ) {}

  /**
   * Decide o que persistir. `null` = descartar. `aviso` vem preenchido só na
   * primeira vez que a sessão cruza o teto.
   */
  admitir(
    sessionId: string,
    evento: { type: string; payload: Record<string, unknown>; raw: unknown },
  ): { evento: EventoLimitado | null; aviso: string | null } {
    let uso = this.#uso.get(sessionId);
    if (!uso) {
      uso = { eventos: 0, bytes: 0, avisado: false, descartados: 0 };
      this.#uso.set(sessionId, uso);
      // Memória limitada: sessões antigas saem na ordem de chegada.
      if (this.#uso.size > 5000) {
        const primeira = this.#uso.keys().next().value;
        if (primeira !== undefined) this.#uso.delete(primeira);
      }
    }

    const excedido = uso.bytes >= this.limites.bytesMax || uso.eventos >= this.limites.eventosMax;
    if (excedido && evento.type === 'log') {
      uso.descartados += 1;
      return { evento: null, aviso: this.#aviso(uso) };
    }

    const limitado = excedido
      ? limitarEvento(evento, { textoMax: this.limites.textoEconomico, semRaw: true })
      : limitarEvento(evento);
    uso.eventos += 1;
    uso.bytes += limitado.bytes;
    return { evento: limitado, aviso: excedido ? this.#aviso(uso) : null };
  }

  #aviso(uso: { avisado: boolean }): string | null {
    if (uso.avisado) return null;
    uso.avisado = true;
    return (
      `saída da sessão passou do teto (${Math.round(this.limites.bytesMax / 1024 / 1024)} MB ` +
      `ou ${this.limites.eventosMax} eventos): logs brutos deixam de ser gravados e os demais ` +
      'eventos passam a ser resumidos'
    );
  }
}

/**
 * Limita uma página de eventos para resposta HTTP/replay: cada evento passa
 * pelos tetos (também os antigos, gravados antes deles existirem), e depois
 * que a página passa de `PAGINA_BYTES_MAX` os eventos restantes vão sem `raw`
 * e com texto curto. A contagem de eventos não muda — quem pagina por
 * quantidade (o painel) continua funcionando.
 */
export function limitarPagina(
  eventos: EventEnvelope[],
  orcamento: number = PAGINA_BYTES_MAX,
): EventEnvelope[] {
  let usados = 0;
  return eventos.map((e) => {
    const estourado = usados >= orcamento;
    const limitado = estourado
      ? limitarEvento(e, { textoMax: 512, semRaw: true })
      : limitarEvento(e);
    usados += limitado.bytes;
    if (!limitado.truncado && limitado.raw === e.raw) return e;
    return { ...e, payload: limitado.payload, raw: limitado.raw as EventEnvelope['raw'] };
  });
}

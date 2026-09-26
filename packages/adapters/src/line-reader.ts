import type { Readable } from 'node:stream';

/**
 * Teto de uma linha de saída do agente, em bytes.
 *
 * `readline` acumula a linha inteira em memória até achar o `\n`: um agente
 * que imprimiu 60 MB sem quebra de linha levou o daemon de 92 MB para 494 MB
 * de RSS e gerou um evento (e uma resposta HTTP) de 125 MB (vistoria
 * 2026-09-25, 06-daemon-nucleo e 10-adapters). Acima do teto, só o começo da
 * linha é guardado e o resto é descartado até o próximo `\n`.
 *
 * O teto é folgado de propósito: uma linha JSONL legítima com um
 * `tool_result` de alguns MB (ler um arquivo grande) precisa continuar sendo
 * JSON inteiro para virar `tool.result` — quem corta o conteúdo para caber na
 * timeline são os tetos por evento do daemon (`event-limits.ts`).
 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** Marca anexada ao que foi cortado — o mesmo formato em todo o Hub. */
export function marcaDeTruncado(bytes: number): string {
  return ` [truncado ${bytes} bytes]`;
}

/**
 * Lê `input` linha a linha, como `readline` com `crlfDelay: Infinity`, mas com
 * teto de tamanho por linha. Linha acima de `maxBytes` chega cortada, com
 * `marcaDeTruncado` no fim (uma linha JSONL cortada deixa de ser JSON válido e
 * vira `log` com `unparsed: true` no adapter, que é o desfecho certo).
 *
 * Trabalha em bytes, não em texto: cortar no meio de um caractere UTF-8 não
 * corrompe o resto, porque o corte só acontece na linha já condenada, e a
 * decodificação de cada linha é feita inteira de uma vez.
 *
 * Respeita `pause()`/`resume()` do stream (o backpressure do adapter), porque
 * só consome via evento `data`.
 */
export function lerLinhas(
  input: Readable,
  onLine: (line: string) => void,
  maxBytes: number = MAX_LINE_BYTES,
): void {
  let partes: Buffer[] = [];
  let guardados = 0;
  let descartados = 0;

  const emitir = (): void => {
    let buf = partes.length === 1 ? (partes[0] as Buffer) : Buffer.concat(partes, guardados);
    partes = [];
    guardados = 0;
    // CRLF: o `\r` final pertence ao terminador, não à linha.
    if (descartados === 0 && buf.length > 0 && buf[buf.length - 1] === 0x0d) {
      buf = buf.subarray(0, buf.length - 1);
    }
    const texto = buf.toString('utf8');
    if (descartados > 0) {
      const cortados = descartados;
      descartados = 0;
      onLine(texto + marcaDeTruncado(cortados));
      return;
    }
    // Como o `readline`: `\r` solto (barra de progresso) também quebra linha.
    if (texto.includes('\r')) {
      for (const parte of texto.split('\r')) onLine(parte);
      return;
    }
    onLine(texto);
  };

  const acumular = (pedaco: Buffer): void => {
    if (pedaco.length === 0) return;
    const cabe = maxBytes - guardados;
    if (cabe <= 0) {
      descartados += pedaco.length;
      return;
    }
    if (pedaco.length <= cabe) {
      partes.push(pedaco);
      guardados += pedaco.length;
      return;
    }
    partes.push(pedaco.subarray(0, cabe));
    guardados += cabe;
    descartados += pedaco.length - cabe;
  };

  input.on('data', (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let inicio = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, inicio);
      if (nl === -1) break;
      acumular(buf.subarray(inicio, nl));
      emitir();
      inicio = nl + 1;
    }
    if (inicio < buf.length) acumular(buf.subarray(inicio));
  });

  input.on('end', () => {
    if (guardados > 0 || descartados > 0) emitir();
  });
}

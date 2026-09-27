/**
 * Texto legível de um valor de payload (`unknown`) para timeline, CLI e MCP.
 *
 * `String(v)` em objeto vira `[object Object]` — que é o que aparecia quando um
 * agente mandava, por exemplo, `status` estruturado em vez de string. Aqui
 * objeto e array viram JSON; `null`/`undefined` viram `vazio`.
 */
export function textoDe(valor: unknown, vazio = ''): string {
  if (valor === undefined || valor === null) return vazio;
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean' || typeof valor === 'bigint') {
    return String(valor);
  }
  if (typeof valor === 'symbol') return valor.description ?? 'Symbol()';
  if (typeof valor === 'function') return '[função]';
  try {
    return JSON.stringify(valor) ?? vazio;
  } catch {
    // Referência circular: melhor um marcador que derrubar quem só queria exibir.
    return '[objeto]';
  }
}

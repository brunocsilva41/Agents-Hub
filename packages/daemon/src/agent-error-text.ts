/**
 * O motivo que o PRÓPRIO agente deu para falhar, junto do desfecho do processo
 * (vistoria 2026-09-25, 08-mcp-hooks achado 11).
 *
 * O Claude recusa um prompt grande com uma linha `result` no stdout
 * (`is_error: true`, `result: "Prompt is too long"`) e sai com código 1. O
 * desfecho do processo só olha o stderr, então a tentativa ficava registrada
 * como "processo terminou com código 1" — e era isso que o chamador via no
 * status, no failureContext do substituto e na auditoria. O motivo real
 * existia na timeline (evento `error` com `summary`), mas não chegava a
 * ninguém que olhasse só a tarefa.
 */

const TETO = 300;

/** Texto de um evento `error` mapeado: `message`, `summary` ou `error`. */
export function textoDoErroDoAgente(payload: Record<string, unknown>): string | null {
  for (const chave of ['message', 'summary', 'error'] as const) {
    const v = payload[chave];
    if (typeof v === 'string' && v.trim().length > 0) {
      const t = v.trim().replace(/\s+/g, ' ');
      return t.length > TETO ? `${t.slice(0, TETO - 1)}…` : t;
    }
  }
  return null;
}

/**
 * Erro da tentativa: o motivo do agente na frente, o desfecho do processo
 * entre parênteses. Sem falha (`null`), continua `null` — um erro emitido no
 * meio de um turno que terminou bem não vira falha.
 */
export function juntarErroDoAgente(
  erroDoProcesso: string | null,
  doAgente: string | null,
): string | null {
  if (erroDoProcesso === null || doAgente === null) return erroDoProcesso;
  if (erroDoProcesso.includes(doAgente)) return erroDoProcesso;
  return `${doAgente} (${erroDoProcesso})`;
}

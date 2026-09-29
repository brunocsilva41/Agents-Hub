import type { MappedEvent } from './types.js';

/**
 * Motivo de uma run que saiu com código ≠ 0 — FONTE ÚNICA do texto de erro.
 *
 * No teste real de 2026-09-26 o Codex bateu no limite de uso da conta: ele
 * emitiu um evento `error` com "You've hit your usage limit...", mas o motivo
 * exibido e registrado na tentativa foi o que vinha primeiro no stderr — um
 * aviso "failed to load skill ... SKILL.md" do ambiente do usuário. Com o
 * motivo errado, a classificação também errou (limite de conta virou falha
 * "permanente" genérica).
 *
 * Ordem de preferência:
 *   1. a ÚLTIMA mensagem de evento `error` do próprio agente (é ele quem sabe
 *      por que parou);
 *   2. a última linha do stderr que PAREÇA erro (e não aviso);
 *   3. a última linha útil do stderr que não seja aviso — o Claude recusa um
 *      `--resume` de sessão inexistente com "No conversation found with
 *      session ID: ..." (sem palavra de erro) e um `result` sem texto
 *      (teste real de 2026-09-29);
 *   4. nada — melhor dizer "sem mensagem" do que promover um aviso a motivo.
 */

/** Texto de um evento `error` mapeado (cada mapper usa um campo). */
export function mensagemDoEventoDeErro(evento: Pick<MappedEvent, 'type' | 'payload'>): string | null {
  if (evento.type !== 'error') return null;
  const p = evento.payload;
  for (const campo of ['message', 'error', 'summary', 'text']) {
    const v = p[campo];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

const PARECE_AVISO =
  /\b(warn(ing)?|aviso|deprecat\w*|notice|info)\b|skill\.md|missing yaml frontmatter/i;
const PARECE_ERRO =
  /\b(error|erro|fatal|failed|failure|falh\w*|exception|denied|refused|unauthori[sz]ed|forbidden|limit|quota|credits?)\b|\b[45]\d\d\b/i;

/** Última linha do stderr que parece erro e não aviso. */
export function ultimaLinhaDeErro(stderr: readonly string[]): string | null {
  for (let i = stderr.length - 1; i >= 0; i -= 1) {
    const linha = (stderr[i] ?? '').trim();
    if (linha.length === 0 || PARECE_AVISO.test(linha)) continue;
    if (PARECE_ERRO.test(linha)) return linha;
  }
  return null;
}

/** Última linha do stderr que não é aviso, com ou sem cara de erro. */
function ultimaLinhaUtil(stderr: readonly string[]): string | null {
  for (let i = stderr.length - 1; i >= 0; i -= 1) {
    const linha = (stderr[i] ?? '').trim();
    if (linha.length > 0 && !PARECE_AVISO.test(linha)) return linha;
  }
  return null;
}

/** Texto final: `processo terminou com código N: <motivo>`. */
export function motivoDaFalha(
  exitCode: number | null,
  errosDoAgente: readonly string[],
  stderr: readonly string[],
): string {
  const motivo =
    errosDoAgente[errosDoAgente.length - 1] ?? ultimaLinhaDeErro(stderr) ?? ultimaLinhaUtil(stderr);
  const base = `processo terminou com código ${exitCode}`;
  return motivo
    ? `${base}: ${cortar(motivo)}`
    : `${base} (o agente não emitiu mensagem de erro; veja o log da sessão)`;
}

function cortar(texto: string, max = 2000): string {
  const limpo = texto.replace(/\s+/g, ' ').trim();
  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo;
}

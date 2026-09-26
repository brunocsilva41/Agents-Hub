/**
 * Validação do caminho de projeto no modal "Registrar Novo Projeto".
 *
 * Quem decide é o daemon (`daemon/src/project-path.ts`): só ele enxerga o
 * disco, e responde `400 INVALID_PATH` para pasta inexistente, arquivo comum
 * ou caminho relativo. Antes, `POST /projects` aceitava qualquer coisa e o
 * modal dizia "projeto registrado" para `C:\nao\existe` (vistoria 2026-09-25,
 * relatório 04). Aqui só fica o que dá para saber sem o disco — vazio e
 * relativo — e a tradução da recusa do daemon para uma mensagem junto do campo.
 */

/** Absoluto em Windows (`C:\`, `C:/`, `\\servidor\`) ou POSIX (`/`). */
export function caminhoEhAbsoluto(caminho: string): boolean {
  const c = caminho.trim();
  return /^[a-zA-Z]:[\\/]/.test(c) || c.startsWith('\\\\') || c.startsWith('/');
}

/** Problema detectável sem o disco, ou `null`. */
export function problemaNoCaminhoLocal(caminho: string): string | null {
  if (caminho.trim() === '') return 'Informe o caminho da pasta do projeto.';
  if (!caminhoEhAbsoluto(caminho)) {
    return 'Use o caminho absoluto da pasta (ex.: C:\\Projetos\\MeuApp ou /home/voce/app) — caminho relativo seria resolvido contra a pasta do daemon.';
  }
  return null;
}

/**
 * A recusa do daemon é sobre o caminho? Devolve a mensagem para mostrar junto
 * do campo, ou `null` se o erro é de outra natureza.
 *
 * O daemon manda `"path inválido: a pasta \"X\" não existe"`; o prefixo com o
 * nome técnico do campo sai, porque na tela o campo já está identificado.
 */
export function erroDeCaminhoDoDaemon(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code !== 'INVALID_PATH') return null;
  const texto = typeof message === 'string' && message.trim() !== '' ? message : 'caminho inválido';
  const motivo = texto.replace(/^\w+ inválido:\s*/, '');
  return `O Hub recusou o caminho: ${motivo}`;
}

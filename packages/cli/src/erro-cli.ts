import { ajudaDoComando } from './ajuda.js';
import { bold, dim, red } from './render.js';

/**
 * Saída de erro única da CLI (vistoria 07, R07-21).
 *
 * Antes cada comando imprimia do seu jeito: `withDaemon` com `[CODIGO]`,
 * `hooks`/`mcp`/`stop` só a mensagem, `required()` sem dizer o uso, erro de
 * uso inline em vermelho solto. Agora todo erro sai por aqui, no stderr, no
 * mesmo formato:
 *
 *     hub: [CODIGO] mensagem          (código do HubApiError/HubError, quando há)
 *       - campo: problema             (details.issues do daemon, quando há)
 *     uso: hub <cmd> ...              (só em erro de uso: a linha do `hub help`)
 *
 * Código de saída: 1 para QUALQUER erro, de uso ou de execução. O 2 fica
 * reservado para "parada esperando aprovação" (`start`/`watch`/`send`): usar 2
 * também para erro de uso, como faz a convenção POSIX, faria um script que
 * testa `$? == 2` confundir "digitei errado" com "tem aprovação pendente".
 */

export const PREFIXO_DE_ERRO = 'hub:';

/** Erro de uso (argumento/flag faltando ou inválido): mostra a linha de uso. */
export class ErroDeUso extends Error {
  constructor(
    message: string,
    readonly comando?: string,
  ) {
    super(message);
    this.name = 'ErroDeUso';
  }
}

let comandoAtual: string | undefined;

/** O comando em execução — para o erro de uso achar a linha de uso certa. */
export function definirComandoAtual(comando: string): void {
  comandoAtual = comando;
}

/** Código de domínio do erro (`HubApiError.code`, `HubError.code`, `EADDRINUSE`...). */
function codigoDe(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : null;
}

/** Lê `details.issues` sem confiar no formato — é `unknown`. */
export function issuesDe(err: unknown): Array<{ path: string; message: string }> {
  const details = (err as { details?: unknown } | null)?.details;
  if (typeof details !== 'object' || details === null) return [];
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  const resultado: Array<{ path: string; message: string }> = [];
  for (const issue of issues) {
    if (typeof issue !== 'object' || issue === null) continue;
    const message = (issue as { message?: unknown }).message;
    if (typeof message !== 'string') continue;
    const p = (issue as { path?: unknown }).path;
    resultado.push({ path: typeof p === 'string' ? p : '', message });
  }
  return resultado;
}

/** As linhas (sem cor) que `mostrarErro` imprime. */
export function linhasDeErro(err: unknown, comando: string | undefined = comandoAtual): string[] {
  const mensagem = err instanceof Error ? err.message : String(err);
  const codigo = err instanceof ErroDeUso ? null : codigoDe(err);
  const linhas = [
    `${PREFIXO_DE_ERRO} ${codigo && !mensagem.includes(`[${codigo}]`) ? `[${codigo}] ` : ''}${mensagem}`,
  ];
  for (const issue of issuesDe(err)) linhas.push(`  - ${issue.path || '(raiz)'}: ${issue.message}`);
  if (err instanceof ErroDeUso) {
    const uso = ajudaDoComando(err.comando ?? comando ?? '');
    if (uso.length > 0) {
      linhas.push('uso:');
      linhas.push(...uso);
    }
    const alvo = err.comando ?? comando;
    if (alvo) linhas.push(`veja: hub ${alvo} --help`);
  }
  return linhas;
}

/** Imprime o erro no formato único e marca a saída com código 1. */
export function mostrarErro(
  err: unknown,
  logErro: (linha: string) => void = (l) => console.error(l),
): void {
  const [primeira = '', ...resto] = linhasDeErro(err);
  logErro(red(primeira));
  for (const linha of resto) {
    logErro(
      linha.startsWith('veja:') || linha === 'uso:'
        ? dim(linha)
        : linha.startsWith('  - ')
          ? linha
          : bold(linha),
    );
  }
  process.exitCode = 1;
}

/** Atalho: erro de uso do comando atual. */
export function erroDeUso(mensagem: string): ErroDeUso {
  return new ErroDeUso(mensagem, comandoAtual);
}

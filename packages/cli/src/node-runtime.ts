/**
 * O que a versão do Node em uso exige para o Hub rodar.
 *
 * `node:sqlite` apareceu no 22.5 atrás de `--experimental-sqlite` e só saiu de
 * trás da flag no 22.13 (linha 22) e no 23.4 (linha 23) — conferido contra os
 * binários: 22.5.0 e 22.12.0 dão `ERR_UNKNOWN_BUILTIN_MODULE` sem a flag,
 * 22.13.0 importa sem ela. O piso declarado em `engines` é 22.5, então a
 * própria CLI precisa passar a flag nessas versões: o shim do `npm link`/`npm
 * i -g` chama `node bin.js` puro, e antes disto nem `hub help` rodava.
 *
 * Puro (versão e `execArgv` entram por parâmetro) para ser testável sem
 * precisar de um Node antigo instalado.
 */

export const NODE_MINIMO = '22.5.0';
export const FLAG_SQLITE = '--experimental-sqlite';

export interface AvaliacaoDoNode {
  /** Abaixo do piso: nem com flag existe `node:sqlite`. */
  suportado: boolean;
  /** Esta versão só carrega `node:sqlite` com `--experimental-sqlite`. */
  sqliteExigeFlag: boolean;
  /** ... e a flag não veio neste processo: é preciso reexecutar. */
  precisaFlagSqlite: boolean;
}

function partes(versao: string): [number, number, number] {
  const [maior = 0, menor = 0, patch = 0] = versao
    .replace(/^v/, '')
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0);
  return [maior, menor, patch];
}

export function avaliarNode(versao: string, execArgv: readonly string[]): AvaliacaoDoNode {
  const [maior, menor] = partes(versao);
  const suportado = maior > 22 || (maior === 22 && menor >= 5);
  const semFlagNativa = (maior === 22 && menor < 13) || (maior === 23 && menor < 4);
  const jaTemFlag = execArgv.includes(FLAG_SQLITE);
  const sqliteExigeFlag = suportado && semFlagNativa;
  return { suportado, sqliteExigeFlag, precisaFlagSqlite: sqliteExigeFlag && !jaTemFlag };
}

/**
 * Flags de Node para um processo filho que vai carregar o daemon (autostart,
 * reexecução do `bin.js`). Vazio nas versões em que `node:sqlite` é nativo:
 * passar a flag à toa não quebra, mas polui `ps`/Gerenciador de Tarefas e
 * esconde qual versão de fato precisou dela.
 */
export function flagsDoNodeParaDaemon(versao: string): string[] {
  // Pela versão, não pelo `execArgv` deste processo: o filho nasce com os
  // argumentos que receber aqui, não herda os do pai.
  return avaliarNode(versao, []).sqliteExigeFlag ? [FLAG_SQLITE] : [];
}

type EmitWarning = typeof process.emitWarning;

/**
 * Engole SÓ o `ExperimentalWarning` do SQLite; qualquer outro aviso passa.
 *
 * O Node imprime `(node:1234) ExperimentalWarning: SQLite is an experimental
 * feature...` + uma linha de dica no stderr a cada processo que carrega
 * `node:sqlite` — ou seja, em todo comando `hub`, inclusive `help`. Ruído que
 * parece defeito e atrapalha quem captura stderr. `--disable-warning` também
 * resolveria, mas exigiria reexecutar o Node em TODA versão só por isso;
 * `process.removeAllListeners('warning')` calaria avisos que importam
 * (depreciação, vazamento de listener).
 *
 * Precisa rodar ANTES do primeiro import de `node:sqlite` — por isso vive no
 * `bin.ts`, que carrega o resto por `import()` dinâmico.
 */
export function silenciarAvisoDoSqlite(proc: { emitWarning: EmitWarning } = process): void {
  const original = proc.emitWarning.bind(proc) as (...args: unknown[]) => void;
  const filtrado = (aviso: unknown, ...resto: unknown[]): void => {
    const opcao = resto[0];
    const tipo =
      aviso instanceof Error
        ? aviso.name
        : typeof opcao === 'string'
          ? opcao
          : typeof opcao === 'object' && opcao !== null
            ? (opcao as { type?: unknown }).type
            : undefined;
    const texto = aviso instanceof Error ? aviso.message : String(aviso);
    if (tipo === 'ExperimentalWarning' && /\bSQLite\b/i.test(texto)) return;
    original(aviso, ...resto);
  };
  proc.emitWarning = filtrado as EmitWarning;
}

/**
 * Texto de erro fatal para o usuário: mensagem e código, sem stack trace.
 *
 * Erro com `code` (`HubError` de config/env inválida, `EADDRINUSE`, `ENOENT`)
 * é erro de ambiente e a mensagem basta; o stack só confunde. Erro SEM código
 * é bug nosso — aí o stack é justamente o que alguém vai precisar para
 * consertar, e fica.
 */
export function textoDeErroFatal(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return err.message.includes(code) ? err.message : `[${code}] ${err.message}`;
    }
    return err.stack ?? err.message;
  }
  return String(err);
}

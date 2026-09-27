import { spawn } from 'node:child_process';
import { flagOn, type Args } from './cmd-util.js';
import { bold, dim, green, yellow } from './render.js';

/** Abre `url` no navegador padrão. Injetável: teste nenhum abre navegador. */
export type Opener = (url: string) => Promise<void>;

/**
 * Abridor do sistema, sem shell no meio: a URL nunca é interpretada por
 * `cmd.exe` (onde `&` quebraria o comando). No Windows, `rundll32
 * url.dll,FileProtocolHandler` é o que o próprio Explorer usa para "abrir
 * link"; no macOS, `open`; no resto, `xdg-open`.
 */
export const abrirNoNavegador: Opener = (url) =>
  new Promise((resolve, reject) => {
    const [bin, argv] =
      process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const filho = spawn(bin, argv, { detached: true, stdio: 'ignore', windowsHide: true });
    filho.once('error', reject);
    filho.once('spawn', () => {
      filho.unref();
      resolve();
    });
  });

/**
 * `hub open [--print]` — o painel é servido pelo próprio daemon, na mesma
 * URL da API. Quem chama garante o daemon no ar antes (`withDaemon`).
 * `--print` só imprime a URL (útil em SSH/sem ambiente gráfico).
 */
export async function openCommand(url: string, args: Args, opener: Opener = abrirNoNavegador): Promise<void> {
  if (flagOn(args, 'print')) {
    console.log(url);
    return;
  }
  try {
    await opener(url);
    console.log(`${green('painel aberto')} ${bold(url)}`);
    console.log(dim('o navegador recebe o token de operador ao carregar a página (cookie HttpOnly).'));
  } catch (err) {
    // Sem navegador (servidor, SSH): a URL impressa ainda resolve.
    console.log(`${yellow('não consegui abrir o navegador')} ${dim(`(${(err as Error).message})`)}`);
    console.log(`abra à mão: ${bold(url)}`);
  }
}

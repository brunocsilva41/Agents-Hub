import { spawn } from 'node:child_process';

/**
 * Mata a árvore de processos de um PID — e **espera** ela morrer.
 *
 * Extraído de duas implementações quase idênticas (`killTree` em
 * `process-adapter.ts`, `killServerTree` em `opencode/adapter.ts`), as duas
 * escritas para o mesmo problema: no Windows, o CLI do agente costuma ser um
 * shim (`cmd.exe`/`sh`) que abre um processo filho real. `child.kill()`
 * sozinho mata só o shim — o `npm`/`node` real sobrevive, reparentado, e
 * continua gastando token e escrevendo no worktree.
 *
 * `taskkill /T /F` anda a árvore a partir do PID informado, então precisa
 * rodar ANTES de qualquer outro kill no mesmo processo — matar o pai primeiro
 * derruba a árvore que o `/T` precisaria andar.
 *
 * Resolve com o que houver: se `taskkill` não estiver no PATH, o `'error'`
 * seria emitido num ChildProcess sem listener, o que no Node é exceção não
 * tratada — por isso cai para `fallbackKill()` (ex.: `SIGKILL` direto no
 * processo, que só derruba o shim, mas é melhor que derrubar o daemon).
 *
 * @param pid PID do processo raiz (o shim, tipicamente).
 * @param fallbackKill Chamado quando `taskkill` não está disponível; deve
 *   matar o processo pelo mecanismo do Node (ex.: `child.kill('SIGKILL')`).
 */
export function killProcessTree(pid: number, fallbackKill: () => void): Promise<void> {
  if (process.platform !== 'win32') {
    fallbackKill();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const matador = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
    });

    let resolvido = false;
    const encerrar = (): void => {
      if (resolvido) return;
      resolvido = true;
      resolve();
    };

    matador.on('error', () => {
      fallbackKill();
      encerrar();
    });
    matador.on('exit', encerrar);

    // Teto: quem espera não pode ficar preso num `taskkill` que não volta.
    const limite = setTimeout(encerrar, 5_000);
    limite.unref?.();
  });
}

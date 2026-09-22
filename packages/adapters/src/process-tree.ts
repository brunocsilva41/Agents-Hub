import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

/**
 * Nome da imagem do processo vivo num PID, ou `null` se ele não existe mais.
 *
 * No Windows usa `tasklist /FI "PID eq <pid>"`: é o jeito de confirmar
 * IDENTIDADE, não só existência — `process.kill(pid, 0)` (o teste comum de
 * "está vivo") não diz NADA sobre o que está rodando ali, e é exatamente essa
 * lacuna que permite matar um PID reciclado pelo SO por engano.
 *
 * Extraído de `session-manager.ts` (dívida arquitetural: o arquivo acumulava
 * reconciliação de PID junto de sessões/orçamento/vigilância) — mora aqui,
 * ao lado de `killProcessTree`, porque é a mesma preocupação (identidade e
 * ciclo de vida de processo no SO), não porque algo do domínio mudou.
 */
export async function imagemDoProcesso(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0);
      // POSIX não tem um equivalente de baixo custo ao `tasklist` aqui; a
      // checagem de nome fica só para o Windows, que é a plataforma suportada
      // hoje (ver decisão "Linux: informativo até provar" no roadmap).
      return 'desconhecido';
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync('tasklist', [
      '/FI',
      `PID eq ${pid}`,
      '/FO',
      'CSV',
      '/NH',
    ]);
    const linha = stdout.trim().split(/\r?\n/)[0] ?? '';
    // Sem processo casando, o `tasklist` imprime "INFO: No tasks..." em vez
    // de CSV — não começa com aspas.
    if (!linha.startsWith('"')) return null;
    const primeiroCampo = linha.split('","')[0]?.replace(/^"/, '') ?? '';
    return primeiroCampo.length > 0 ? primeiroCampo : null;
  } catch {
    return null;
  }
}

/**
 * A imagem viva bate com o que o manifesto do agente declara?
 *
 * Comparação exata (`claude.exe` para `bin: claude`) cobriria só o caso onde
 * o adapter não precisou de shell. A maioria dos CLIs de agente instalados
 * via npm no Windows é um shim `.cmd`, e `ProcessAgentAdapter` spawna esses
 * com `shell: true` — o PID guardado na sessão é do `cmd.exe`/`sh`
 * intermediário, não do binário final (o `killProcessTree`/`taskkill /T`
 * já lida com isso andando a árvore; aqui só precisamos aceitar o wrapper
 * como identidade plausível, não confirmar o processo folha).
 *
 * Deliberadamente NÃO aceita `node` como wrapper genérico: isso deixaria
 * qualquer script Node do usuário — sem nenhuma relação com o Hub — elegível
 * para ser morto por qualquer agente. O wrapper aceito é só o shell que
 * `needsShell: true` de fato usa para invocar o shim.
 */
export function imagemPareceEsperada(imagem: string, bin: string): boolean {
  const nome = imagem.toLowerCase().replace(/\.exe$/, '');
  const alvo = bin.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (nome === alvo) return true;
  return ['cmd', 'sh', 'bash'].includes(nome);
}

/**
 * Tolerância de relógio na comparação de horários: `sessao.updatedAt` e o
 * `StartTime` do processo vêm de relógios/resoluções diferentes (SQLite vs.
 * `Get-Process`), então uma diferença de poucos segundos não é sinal de nada
 * — só folga suficiente para não gerar falso positivo no caminho comum onde
 * processo e atualização da sessão acontecem quase juntos.
 */
export const TOLERANCIA_RELOGIO_MS = 5_000;

/**
 * Horário em que o processo vivo no PID foi criado, ou `null` quando não dá
 * para saber (POSIX hoje, ou qualquer falha ao consultar o SO).
 *
 * Usa PowerShell (`Get-Process -Id <pid>).StartTime`) em vez de
 * `wmic process ... get CreationDate`: `wmic` está descontinuado nas versões
 * recentes do Windows e seu formato de data (`yyyyMMddHHmmss.ffffff+UUU`)
 * exige parsing manual sujeito a erro; `StartTime` já vem como `DateTime`.
 */
export async function horarioDeCriacaoDoProcesso(pid: number): Promise<Date | null> {
  if (process.platform !== 'win32') {
    // Mesma limitação documentada em `imagemDoProcesso`: sem um equivalente
    // barato ao `tasklist`/`Get-Process` no POSIX, a reconciliação segue sem
    // cobertura de identidade (nome OU horário) fora do Windows.
    return null;
  }

  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
    ]);
    const texto = stdout.trim();
    if (texto.length === 0) return null;
    const data = new Date(texto);
    return Number.isNaN(data.getTime()) ? null : data;
  } catch {
    // Processo já não existe mais, ou o SO nega acesso ao StartTime (processo
    // de sistema, por exemplo) — nos dois casos, não dá pra confirmar horário.
    return null;
  }
}

/**
 * O processo vivo no PID nasceu depois do último registro conhecido da
 * sessão no banco (com folga de `TOLERANCIA_RELOGIO_MS`)?
 *
 * Se sim, é quase certamente o SO tendo reciclado o PID para outro processo
 * — o órfão de verdade só poderia ter nascido ANTES do daemon anterior
 * morrer, ou seja, antes (ou muito perto) do último `updatedAt` gravado.
 * `inicioProcesso === null` (horário desconhecido) NÃO conta como reciclado:
 * a checagem de horário é uma mitigação best-effort a mais, não um requisito
 * — na dúvida, mantém o comportamento anterior em vez de travar a limpeza.
 */
export function pidPareceReciclado(inicioProcesso: Date | null, referenciaIso: string): boolean {
  if (inicioProcesso === null) return false;
  const referencia = new Date(referenciaIso).getTime();
  if (Number.isNaN(referencia)) return false;
  return inicioProcesso.getTime() > referencia + TOLERANCIA_RELOGIO_MS;
}

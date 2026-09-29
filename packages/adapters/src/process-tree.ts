import { execFile, spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
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
 * Fora do Windows, duas camadas que se completam (R06-13 + achado do Linux):
 *
 * - o filho nasce líder de um grupo de processos (`opcoesDeGrupo()` no
 *   `spawn`) e o kill vai para o GRUPO (`kill(-pid)`) — pega inclusive o
 *   bisneto cujo pai já morreu (reparentado ao init, mas ainda no grupo);
 * - a árvore PID→PPID é levantada ANTES de a raiz morrer e cada descendente
 *   leva `SIGKILL` individual — pega o neto `detached` (sessão própria, FORA
 *   do grupo), que sobrevivia ao kill de grupo sozinho.
 *
 * No fim, espera cada PID sumir da tabela: a promessa desta função é devolver
 * a árvore MORTA (quem chama libera o worktree logo em seguida).
 *
 * @param pid PID do processo raiz (o shim, tipicamente).
 * @param fallbackKill Chamado quando `taskkill` não está disponível (ou, em
 *   POSIX, quando não há grupo); deve matar o processo pelo mecanismo do Node
 *   (ex.: `child.kill('SIGKILL')`).
 * @param deps Só para teste: plataforma e `process.kill` substituíveis.
 */
export function killProcessTree(
  pid: number,
  fallbackKill: () => void,
  deps: { platform?: NodeJS.Platform; kill?: (pid: number, signal: NodeJS.Signals) => void } = {},
): Promise<void> {
  const plataforma = deps.platform ?? process.platform;
  if (plataforma !== 'win32') {
    // PID inválido (ex.: `child.pid ?? -1`): `-pid` viraria `kill(1)` ou
    // `kill(0)` — o init ou o PRÓPRIO grupo do daemon. Nunca.
    if (!Number.isInteger(pid) || pid <= 1) {
      fallbackKill();
      return Promise.resolve();
    }
    const matar = deps.kill ?? ((p: number, sinal: NodeJS.Signals) => process.kill(p, sinal));
    // Com `kill` injetado (teste de montagem) não há processo real para
    // esperar morrer — a espera olharia PIDs de mentira na tabela de verdade.
    return matarArvorePosix(pid, fallbackKill, matar, deps.kill === undefined);
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

async function matarArvorePosix(
  pid: number,
  fallbackKill: () => void,
  matar: (pid: number, sinal: NodeJS.Signals) => void,
  esperarMorte: boolean,
): Promise<void> {
  // Levantada ANTES do kill da raiz: morto o pai, os filhos passam a ter o
  // init como PPID e deixam de ser alcançáveis a partir de `pid`. Resta uma
  // janela (a raiz pode spawnar entre a leitura e o kill) que só um
  // `SIGSTOP` prévio fecharia — mas um `fallbackKill` com `SIGTERM` num
  // processo parado fica pendente para sempre, o que é pior que a janela.
  const descendentes = descendentesDe(pid, await paresPidPpid());
  // Primeiro o grupo (pega quem ficou nele mesmo órfão de pai); sem grupo
  // (spawn sem `detached`, `ESRCH`), o fallback mata ao menos a raiz.
  try {
    matar(-pid, 'SIGKILL');
  } catch {
    fallbackKill();
  }
  // Depois, cada descendente da foto — pega o `detached` que saiu do grupo.
  for (const alvo of descendentes) {
    try {
      matar(alvo, 'SIGKILL');
    } catch {
      // Já morreu sozinho entre a leitura da árvore e agora — é o que queríamos.
    }
  }

  // `kill()` só ENVIA o sinal; a promessa desta função é devolver a árvore
  // morta (quem chama libera o worktree logo em seguida). Espera cada PID
  // sumir da tabela, com o mesmo teto de 5s do `taskkill` — um zumbi que
  // ninguém colhe (container sem init) não pode prender quem espera.
  if (!esperarMorte) return;
  const limite = Date.now() + 5_000;
  let vivos = [pid, ...descendentes];
  while (Date.now() < limite) {
    vivos = vivos.filter(existe);
    if (vivos.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function existe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: existe, só não é nosso — continua contando como vivo.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Todos os descendentes de `raiz` (filhos, netos...), em largura. */
function descendentesDe(raiz: number, pares: ReadonlyArray<[number, number]>): number[] {
  const filhosPorPai = new Map<number, number[]>();
  for (const [pid, ppid] of pares) {
    const irmaos = filhosPorPai.get(ppid);
    if (irmaos) irmaos.push(pid);
    else filhosPorPai.set(ppid, [pid]);
  }
  const visitados = [raiz];
  // `for...of` sobre array visita também o que for anexado durante a volta:
  // é a própria fila da busca em largura.
  for (const atual of visitados) {
    for (const filho of filhosPorPai.get(atual) ?? []) {
      // PID não se repete numa foto da tabela, mas o guarda evita laço
      // infinito se o SO devolver algo inconsistente no meio da leitura.
      if (!visitados.includes(filho)) visitados.push(filho);
    }
  }
  return visitados.slice(1);
}

/**
 * Foto da tabela de processos como pares [pid, ppid].
 *
 * No Linux lê `/proc` direto (não depende de `procps`, ausente em imagens de
 * container enxutas); nos demais POSIX usa `ps`, que lá é parte do sistema
 * base. Falha vira lista vazia: sem a foto, o melhor que dá é matar a raiz.
 */
async function paresPidPpid(): Promise<Array<[number, number]>> {
  if (process.platform === 'linux') {
    const pares: Array<[number, number]> = [];
    let entradas: string[];
    try {
      entradas = await readdir('/proc');
    } catch {
      return [];
    }
    for (const nome of entradas) {
      if (!/^\d+$/.test(nome)) continue;
      try {
        const stat = await readFile(`/proc/${nome}/stat`, 'utf8');
        // O 2º campo (comm) vem entre parênteses e pode conter espaço e `)`;
        // o PPID é o 2º campo depois do ÚLTIMO `)`.
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        if (Number.isInteger(ppid)) pares.push([Number(nome), ppid]);
      } catch {
        // Processo terminou entre o `readdir` e a leitura — fora da foto.
      }
    }
    return pares;
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=']);
    return stdout
      .split('\n')
      .map((linha) => linha.trim().split(/\s+/).map(Number))
      .filter(
        (campos): campos is [number, number] =>
          campos.length === 2 && campos.every((n) => Number.isInteger(n) && n > 0),
      );
  } catch {
    return [];
  }
}

/**
 * Opções de `spawn` para o filho poder ser morto com a árvore inteira.
 *
 * POSIX: `detached: true` põe o filho num grupo de processos próprio (ele é
 * o líder, id do grupo = PID dele), que é o que `killProcessTree` mata com
 * `kill(-pid)`. Windows: nada — lá `detached` abriria um console novo, e a
 * árvore já é andada por `taskkill /T`.
 */
export function opcoesDeGrupo(plataforma: NodeJS.Platform = process.platform): { detached?: true } {
  return plataforma === 'win32' ? {} : { detached: true };
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
  if (process.platform !== 'win32') return imagemDoProcessoPosix(pid);

  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
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
 * Equivalente POSIX do `tasklist`: o nome do executável vivo no PID.
 *
 * Antes devolvia a constante `'desconhecido'` para todo PID vivo, o que fazia
 * `imagemPareceEsperada` recusar sempre e a reconciliação NUNCA matar órfão
 * fora do Windows — seguro, mas o órfão sobrevivia ao reinício do daemon
 * (teste de reconciliação vermelho no Linux).
 *
 * No Linux vem do `argv[0]` em `/proc/<pid>/cmdline`, não de
 * `/proc/<pid>/comm`: o Node renomeia a própria thread principal para
 * `MainThread`, então `comm` de um `node` nunca diria `node`. Um zumbi tem
 * `cmdline` vazio — já morreu, só não foi colhido — e conta como inexistente.
 */
async function imagemDoProcessoPosix(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const argv0 = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')[0] ?? '';
      return argv0.length > 0 ? path.posix.basename(argv0) : null;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm=']);
    const comando = stdout.trim();
    return comando.length > 0 ? path.posix.basename(comando) : null;
  } catch {
    // `ps -p` sai com código != 0 quando o PID não existe.
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
 *
 * `executavelSpawnado` (opcional) é o arquivo que o adapter de fato spawna
 * quando desembrulha o shim npm (`ResolvedBin.file`: o `node.exe` que roda o
 * script, ou o `.exe` real): aí o PID guardado é desse executável, não do
 * `cmd.exe`. Aceitá-lo aqui é específico ao agente (vem do resolve do PRÓPRIO
 * `bin`), não um "node genérico" — e a checagem de horário de criação do PID
 * em `#matarOrfao` continua valendo por cima.
 */
export function imagemPareceEsperada(imagem: string, bin: string, executavelSpawnado?: string): boolean {
  const nome = imagem.toLowerCase().replace(/\.exe$/, '');
  const alvo = bin.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (nome === alvo) return true;
  if (executavelSpawnado) {
    const spawnado = (executavelSpawnado.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
    if (nome === spawnado) return true;
  }
  return ['cmd', 'sh', 'bash'].includes(nome);
}

/**
 * Tolerância de relógio na comparação de horários: `sessao.updatedAt` e o
 * `StartTime` do processo vêm de relógios/resoluções diferentes (SQLite vs.
 * `Get-Process`; no POSIX, o `btime` de 1 s de resolução, que ainda anda um
 * pouco com ajuste de NTP, ou o `lstart` do `ps`, também de 1 s), então uma
 * diferença de poucos segundos não é sinal de nada
 * — só folga suficiente para não gerar falso positivo no caminho comum onde
 * processo e atualização da sessão acontecem quase juntos.
 */
export const TOLERANCIA_RELOGIO_MS = 5_000;

/**
 * Horário em que o processo vivo no PID foi criado, ou `null` quando não dá
 * para saber (qualquer falha ao consultar o SO).
 *
 * Windows: PowerShell (`Get-Process -Id <pid>).StartTime`) em vez de
 * `wmic process ... get CreationDate`: `wmic` está descontinuado nas versões
 * recentes do Windows e seu formato de data (`yyyyMMddHHmmss.ffffff+UUU`)
 * exige parsing manual sujeito a erro; `StartTime` já vem como `DateTime`.
 *
 * Linux: `/proc` direto (ver `inicioPeloProcStat`), não `ps -o lstart=` —
 * `procps` falta em imagens de container enxutas (o mesmo motivo de
 * `paresPidPpid` ler `/proc`), `lstart` tem resolução de 1 s e sai em hora
 * local num formato que depende de locale. Demais POSIX (macOS, BSD): `ps`,
 * que lá é do sistema base, com `LC_ALL=C` e `TZ=UTC` para o texto ter um
 * formato só.
 */
export async function horarioDeCriacaoDoProcesso(pid: number): Promise<Date | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') return horarioDeCriacaoLinux(pid);
  if (process.platform !== 'win32') return horarioDeCriacaoPorPs(pid);

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
 * Ticks de relógio por segundo em que o kernel conta o `starttime`.
 *
 * É o `USER_HZ` da ABI do kernel — 100 em x86, ARM, RISC-V, PowerPC e s390.
 * O Node não expõe `sysconf(_SC_CLK_TCK)`, então pergunta ao `getconf` (da
 * libc, sem shell) uma vez só e cai para 100 se ele não existir.
 */
let clkTck: Promise<number> | undefined;
function ticksPorSegundo(): Promise<number> {
  clkTck ??= execFileAsync('getconf', ['CLK_TCK'])
    .then(({ stdout }) => {
      const n = Number(stdout.trim());
      return Number.isInteger(n) && n > 0 ? n : 100;
    })
    .catch(() => 100);
  return clkTck;
}

async function horarioDeCriacaoLinux(pid: number): Promise<Date | null> {
  try {
    const [stat, procStat, tck] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile('/proc/stat', 'utf8'),
      ticksPorSegundo(),
    ]);
    const btime = bootDoProcStat(procStat);
    return btime === null ? null : inicioPeloProcStat(stat, btime, tck);
  } catch {
    // PID sem entrada em /proc: o processo já não existe.
    return null;
  }
}

async function horarioDeCriacaoPorPs(pid: number): Promise<Date | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    return inicioPeloLstart(stdout);
  } catch {
    // `ps -p` sai com código != 0 quando o PID não existe.
    return null;
  }
}

/** `btime` de `/proc/stat`: o boot do sistema, em segundos desde a época. */
export function bootDoProcStat(procStat: string): number | null {
  const casou = /^btime\s+(\d+)\s*$/m.exec(procStat);
  return casou ? Number(casou[1]) : null;
}

/**
 * Início do processo a partir de `/proc/<pid>/stat`: o campo 22
 * (`starttime`) conta ticks desde o boot; somado ao `btime`, vira instante.
 *
 * O 2º campo (`comm`) vem entre parênteses e pode ter espaço e `)` — por isso
 * a contagem começa depois do ÚLTIMO `)`, onde o 3º campo é o índice 0 e o
 * 22º, o índice 19.
 */
export function inicioPeloProcStat(
  stat: string,
  btimeSegundos: number,
  ticksPorSeg: number,
): Date | null {
  const fim = stat.lastIndexOf(')');
  if (fim < 0) return null;
  const campo = stat.slice(fim + 2).split(' ')[19] ?? '';
  if (!/^\d+$/.test(campo)) return null;
  return new Date(btimeSegundos * 1000 + (Number(campo) * 1000) / ticksPorSeg);
}

const MESES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Início do processo a partir de `ps -o lstart=` com `LC_ALL=C` e `TZ=UTC`
 * (`Tue Sep 29 12:00:00 2026`). Parse manual, não `new Date(texto)`: o
 * formato aceito pelo `Date` para strings fora do ISO depende do motor.
 */
export function inicioPeloLstart(texto: string): Date | null {
  const casou = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(texto.trim());
  if (!casou) return null;
  const mes = MESES.indexOf(casou[1] as string);
  if (mes < 0) return null;
  const [dia, hora, minuto, segundo, ano] = casou.slice(2).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(ano, mes, dia, hora, minuto, segundo));
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

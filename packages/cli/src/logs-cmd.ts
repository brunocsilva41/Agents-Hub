import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { flagOn, flagString, NEWLINE, type Args } from './cmd-util.js';
import { bold, dim } from './render.js';

/** Quanto do fim do arquivo ler para achar as últimas N linhas. */
const JANELA_BYTES = 2 * 1024 * 1024;

/**
 * Arquivos `daemon-AAAA-MM-DD.log` de `logDir`, do mais antigo ao mais novo.
 * O nome carrega a data, então a ordem alfabética é a cronológica.
 */
export function arquivosDeLog(logDir: string): string[] {
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((f) => /^daemon-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort()
    .map((f) => path.join(logDir, f));
}

function lerTrecho(file: string, inicio: number, fim: number): string {
  if (fim <= inicio) return '';
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(fim - inicio);
    const lidos = readSync(fd, buf, 0, buf.length, inicio);
    return buf.subarray(0, lidos).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Últimas `n` linhas de `file` (sem ler o arquivo inteiro se ele for grande). */
export function ultimasLinhas(file: string, n: number): string[] {
  const tamanho = statSync(file).size;
  const inicio = Math.max(0, tamanho - JANELA_BYTES);
  const linhas = lerTrecho(file, inicio, tamanho).split(/\r?\n/);
  if (linhas.at(-1) === '') linhas.pop();
  // Se cortamos no meio do arquivo, a primeira linha provavelmente está pela metade.
  if (inicio > 0) linhas.shift();
  return n <= 0 ? [] : linhas.slice(-n);
}

export interface LogsOptions {
  /** Encerra o `--follow` (teste); sem ele, segue até Ctrl-C. */
  signal?: AbortSignal;
  pollMs?: number;
  /** Saída do `--follow` (texto cru, sem quebra extra). Padrão: stdout. */
  write?: (texto: string) => void;
}

/**
 * `hub logs [--lines N] [--follow] [--list]` — o que o daemon autostartado
 * escreveu em `<home>/logs`. Não precisa do daemon no ar: o caso mais comum
 * de ler log é justamente o daemon ter caído.
 */
export async function logsCommand(logDir: string, args: Args, options: LogsOptions = {}): Promise<void> {
  const arquivos = arquivosDeLog(logDir);

  if (flagOn(args, 'list')) {
    if (arquivos.length === 0) console.log(dim(`nenhum log em ${logDir}`));
    for (const f of arquivos) console.log(`${path.basename(f)} ${dim(`${statSync(f).size} bytes`)}`);
    return;
  }

  const linhasFlag = flagString(args, 'lines') ?? flagString(args, 'n');
  const n = linhasFlag === undefined ? 50 : Number(linhasFlag);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--lines inválido: "${String(linhasFlag)}" (use um inteiro >= 0)`);
  }

  let atual = arquivos.at(-1);
  if (atual === undefined && !flagOn(args, 'follow')) {
    console.log(dim(`nenhum log do daemon em ${logDir}.`));
    console.log(
      dim('o arquivo nasce quando o daemon sobe sozinho (autostart); `hub daemon` escreve no terminal.'),
    );
    return;
  }

  let posicao = 0;
  if (atual !== undefined) {
    console.log(dim(`==> ${atual} <==`));
    const linhas = ultimasLinhas(atual, n);
    if (linhas.length > 0) console.log(linhas.join(NEWLINE));
    posicao = statSync(atual).size;
  }

  if (!flagOn(args, 'follow')) return;

  console.log(dim(`seguindo ${bold(logDir)} — Ctrl-C para sair`));
  const pollMs = options.pollMs ?? 500;
  const escrever = options.write ?? ((texto: string) => void process.stdout.write(texto));
  // Polling e não `fs.watch`: no Windows o watch perde escrita de outro
  // processo com o arquivo aberto em append, e o arquivo troca à meia-noite.
  while (options.signal?.aborted !== true) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollMs);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
    const novo = arquivosDeLog(logDir).at(-1);
    if (novo !== undefined && novo !== atual) {
      atual = novo;
      posicao = 0;
      console.log(dim(`==> ${atual} <==`));
    }
    if (atual === undefined || !existsSync(atual)) continue;
    const tamanho = statSync(atual).size;
    if (tamanho < posicao) posicao = 0; // truncado por fora
    const trecho = lerTrecho(atual, posicao, tamanho);
    posicao = tamanho;
    if (trecho.length > 0) escrever(trecho);
  }
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY } from '@agents-hub/core';
import { createHub, type Hub } from '@agents-hub/daemon';
import { HubClient } from './client.js';

/**
 * Daemon REAL isolado para os testes da CLI, com agentes FALSOS (scripts Node
 * que imitam um CLI de texto). Nenhum modelo é chamado: custo zero e
 * determinístico. Só usado por `*.test.ts`.
 *
 * Modos do agente falso (`FAKE_MODE` no manifesto):
 * - `ok`: responde `RESPOSTA-OK` e sai 0;
 * - `falha`: escreve `boom` no stderr e sai com código 3;
 * - `dorme-uma-vez`: a 1ª execução dorme (até ser morta); as seguintes
 *   respondem `RESPOSTA-NOVA` — para testar pause -> send;
 * - `lento`: dorme `FAKE_SLEEP_MS` e responde `RESPOSTA-OK`.
 */
const AGENTE_FALSO = `
const fs = require('node:fs');
if (process.argv.includes('--version')) { process.stdout.write('9.9.9\\n'); process.exit(0); }
const modo = process.env.FAKE_MODE || 'ok';
const contador = process.env.FAKE_COUNTER;
let n = 0;
if (contador) {
  try { n = Number(fs.readFileSync(contador, 'utf8')) || 0; } catch {}
  n += 1;
  fs.writeFileSync(contador, String(n));
}
if (modo === 'falha') { process.stderr.write('boom\\n'); process.exit(3); }
if (modo === 'dorme-uma-vez' && n <= 1) { setTimeout(() => {}, 120000); return; }
if (modo === 'dorme-uma-vez') { process.stdout.write('RESPOSTA-NOVA\\n'); process.exit(0); }
if (modo === 'lento') {
  setTimeout(() => { process.stdout.write('RESPOSTA-OK\\n'); process.exit(0); }, Number(process.env.FAKE_SLEEP_MS || 300));
  return;
}
process.stdout.write('RESPOSTA-OK\\n');
process.exit(0);
`;

export interface AgenteFalso {
  id: string;
  modo: 'ok' | 'falha' | 'dorme-uma-vez' | 'lento';
  capacidade?: string;
  sleepMs?: number;
}

export interface HubDeTeste {
  hub: Hub;
  client: HubClient;
  raiz: string;
  /** Pasta de projeto (sem git) já criada. */
  projeto: string;
  encerrar(): Promise<void>;
}

/**
 * `port: 0` não basta: a guarda de borda compara o `Host` da requisição com
 * `config.port`, conhecido só depois do `listen` — reserva uma porta antes.
 */
export function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const endereco = srv.address();
      const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
      srv.close(() => resolve(porta));
    });
  });
}

const esc = (p: string): string => p.replaceAll('\\', '\\\\');

export async function montarHubDeTeste(
  agentes: AgenteFalso[],
  opcoes: { fallback?: Record<string, string[]>; prefixo?: string } = {},
): Promise<HubDeTeste> {
  const raiz = mkdtempSync(path.join(os.tmpdir(), opcoes.prefixo ?? 'hub-cli-teste-'));
  const manifestos = path.join(raiz, 'manifests');
  const projeto = path.join(raiz, 'projeto');
  const script = path.join(raiz, 'agente-falso.cjs');
  for (const dir of [manifestos, projeto]) mkdirSync(dir, { recursive: true });
  writeFileSync(script, AGENTE_FALSO, 'utf8');

  for (const a of agentes) {
    const manifesto = [
      `id: ${a.id}`,
      `name: Agente falso ${a.id}`,
      'bin: node',
      'detect:',
      `  args: ["${esc(script)}", "--version"]`,
      'invoke:',
      `  oneShot: ["${esc(script)}"]`,
      '  stdinPrompt: true',
      '  env:',
      `    FAKE_MODE: "${a.modo}"`,
      `    FAKE_COUNTER: "${esc(path.join(raiz, `${a.id}.count`))}"`,
      `    FAKE_SLEEP_MS: "${a.sleepMs ?? 300}"`,
      'session:',
      '  strategy: replay',
      'stream:',
      '  format: text',
      '  mapper: generic-text',
      `capabilities: [${a.capacidade ?? `cap-${a.id}`}]`,
      'defaults:',
      '  isolation: none',
      '  timeoutSeconds: 60',
      '  supervision: autonomous',
      '',
    ].join('\n');
    writeFileSync(path.join(manifestos, `${a.id}.yaml`), manifesto, 'utf8');
  }

  const hub = createHub({
    home: raiz,
    manifestsDir: manifestos,
    webRoot: path.join(raiz, 'sem-web'),
    port: await portaLivre(),
    policy: {
      ...DEFAULT_POLICY,
      retries: { max: 0, backoffMs: 10 },
      fallback: opcoes.fallback ?? {},
      watch: { pauseOn: [], flagOn: [] },
    },
  });
  const { host, port } = await hub.start();
  const client = new HubClient(`http://${host}:${port}`);

  return {
    hub,
    client,
    raiz,
    projeto,
    async encerrar() {
      await hub.shutdown();
      try {
        rmSync(raiz, { recursive: true, force: true });
      } catch {
        /* limpeza de temp é oportunista (Windows segura arquivo aberto) */
      }
    },
  };
}

/** Captura `log`/`logErro` dos comandos e o `process.exitCode` que eles deixam. */
export function capturar(): {
  linhas: string[];
  erros: string[];
  log: (l: string) => void;
  logErro: (l: string) => void;
  texto(): string;
} {
  const linhas: string[] = [];
  const erros: string[] = [];
  return {
    linhas,
    erros,
    log: (l) => linhas.push(l),
    logErro: (l) => erros.push(l),
    texto: () => [...linhas, ...erros].join('\n'),
  };
}

/** Espera uma condição (poll curto) ou falha com a mensagem. */
export async function esperar(
  cond: () => boolean | Promise<boolean>,
  msg: string,
  timeoutMs = 20_000,
): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > limite) throw new Error(`timeout: ${msg}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Corre `p` com teto: um comando que pendura vira falha do teste, não teste travado. */
export async function comTeto<T>(p: Promise<T>, ms: number, oque: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const teto = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${oque} não terminou em ${ms}ms (pendurou)`)), ms);
  });
  try {
    return await Promise.race([p, teto]);
  } finally {
    clearTimeout(timer);
  }
}

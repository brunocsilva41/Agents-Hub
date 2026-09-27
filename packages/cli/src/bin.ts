#!/usr/bin/env node
/**
 * Entrada do `hub` (o que o `bin` do pacote aponta, o que o autostart e o hook
 * executam).
 *
 * Existe separada de `main.ts` porque três coisas precisam acontecer ANTES de
 * qualquer import estático que chegue em `node:sqlite` — e em ESM os imports
 * estáticos rodam antes da primeira linha do módulo:
 *
 * 1. Node 22.5–22.12 (e 23.0–23.3) só carregam `node:sqlite` com
 *    `--experimental-sqlite`; sem a flag, nem `hub help` rodava. Aqui a CLI se
 *    reexecuta com a flag quando ela falta (ver `node-runtime.ts`).
 * 2. O `ExperimentalWarning` do SQLite sai em todo comando; o filtro precisa
 *    estar instalado antes do import.
 * 3. `hub hook` roda a cada Bash/Edit/Write do agente e não usa o banco: vai
 *    direto para `hook-run.ts`, sem carregar daemon/store (~0,5 s a menos por
 *    chamada), e sem reexecutar nem em Node antigo.
 *
 * Por fim, erro de ambiente (config.json ou variável inválida, porta ocupada)
 * vira uma linha legível em vez de stack trace — o `await main()` de
 * `main.ts` rejeita o `import()` abaixo, e é aqui que ele é tratado.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  avaliarNode,
  FLAG_SQLITE,
  NODE_MINIMO,
  silenciarAvisoDoSqlite,
  textoDeErroFatal,
} from './node-runtime.js';

function versaoDoHub(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'desconhecida';
  } catch {
    return 'desconhecida';
  }
}

async function rodar(): Promise<void> {
  const argv = process.argv.slice(2);
  const comando = argv[0];

  if (comando === '--version' || comando === '-v') {
    console.log(versaoDoHub());
    return;
  }

  const node = avaliarNode(process.versions.node, process.execArgv);
  if (!node.suportado) {
    process.stderr.write(
      `hub: o Agents-Hub precisa do Node ${NODE_MINIMO} ou mais novo (este é ${process.version}).\n`,
    );
    process.exitCode = 1;
    return;
  }

  silenciarAvisoDoSqlite();

  if (comando === 'hook') {
    const { flagsDoHook, runHook } = await import('./hook-run.js');
    await runHook({ flags: flagsDoHook(argv.slice(1)) });
    return;
  }

  if (node.precisaFlagSqlite) {
    await reexecutarComFlag(argv);
    return;
  }

  await import('./main.js');
}

/**
 * Mesmo Node, mesmos argumentos, com `--experimental-sqlite`.
 *
 * Assíncrono e com `stdio: 'inherit'`: stdin/stdout/TTY passam direto (o
 * `watch` e o `daemon` em primeiro plano continuam interativos). O Ctrl-C
 * chega aos dois processos do console; o pai ignora e espera o filho decidir
 * — senão o `hub daemon` devolvia o prompt antes de o filho terminar de
 * encerrar as sessões.
 */
function reexecutarComFlag(argv: string[]): Promise<void> {
  return new Promise((resolve) => {
    const filho = spawn(
      process.execPath,
      [...process.execArgv, FLAG_SQLITE, fileURLToPath(import.meta.url), ...argv],
      { stdio: 'inherit' },
    );
    const ignorar = (): void => {};
    process.on('SIGINT', ignorar);
    process.on('SIGTERM', ignorar);
    filho.on('error', (err) => {
      process.stderr.write(
        `hub: não foi possível reexecutar o Node com ${FLAG_SQLITE}: ${err.message}\n`,
      );
      process.exitCode = 1;
      resolve();
    });
    filho.on('exit', (codigo, sinal) => {
      process.exitCode = codigo ?? (sinal ? 1 : 0);
      resolve();
    });
  });
}

try {
  await rodar();
} catch (err) {
  process.stderr.write(`hub: ${textoDeErroFatal(err)}\n`);
  process.exitCode = 1;
}

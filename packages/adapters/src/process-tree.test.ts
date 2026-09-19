import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { killProcessTree } from './process-tree.js';

/**
 * Prova que `killProcessTree` mata a árvore inteira, não só o processo raiz.
 *
 * O script "pai" spawna um "neto" (`detached: true`, sem relação de pipe com
 * o pai) que ignora SIGTERM e escreve o próprio PID num arquivo — o mesmo
 * padrão usado para provar `killTree`/`killServerTree` antes da extração.
 * Sem `/T`, `taskkill` mataria só o pai (o shim), e o neto sobreviveria
 * reparentado — exatamente o bug que motivou este módulo.
 */

const PARENT_SCRIPT = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const outDir = process.argv[2];
const netoScript = path.join(outDir, 'neto.js');

const neto = spawn(process.execPath, [netoScript, outDir], {
  detached: true,
  stdio: 'ignore',
});
neto.unref();

fs.writeFileSync(path.join(outDir, 'parent.pid'), String(process.pid));

// O pai fica vivo também, para o teste poder distinguir "matou só o pai" de
// "matou a árvore inteira".
setInterval(() => {}, 1000 * 60);
`;

const NETO_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');

const outDir = process.argv[2];
fs.writeFileSync(path.join(outDir, 'neto.pid'), String(process.pid));

// Ignora SIGTERM de propósito: só \`taskkill /F\` (ou SIGKILL em POSIX) mata.
process.on('SIGTERM', () => {});

setInterval(() => {}, 1000 * 60);
`;

function pidVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function aguardarArquivo(file: string, timeoutMs = 10_000): Promise<string> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`arquivo ${file} nunca apareceu`);
}

async function aguardarMorte(pid: number, timeoutMs = 10_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (!pidVivo(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pid ${pid} continua vivo depois de ${timeoutMs}ms`);
}

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('killProcessTree mata o processo raiz e o neto que ignora SIGTERM', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hub-process-tree-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'parent.js'), PARENT_SCRIPT, 'utf8');
  writeFileSync(path.join(dir, 'neto.js'), NETO_SCRIPT, 'utf8');

  const parent = spawn(process.execPath, [path.join(dir, 'parent.js'), dir], {
    stdio: 'ignore',
  });
  assert.ok(parent.pid, 'processo pai deveria ter PID');

  const netoPidStr = await aguardarArquivo(path.join(dir, 'neto.pid'));
  const netoPid = Number(netoPidStr);
  assert.ok(Number.isInteger(netoPid) && netoPid > 0);
  assert.ok(pidVivo(netoPid), 'neto deveria estar vivo antes do kill');

  let fallbackChamado = false;
  await killProcessTree(parent.pid!, () => {
    fallbackChamado = true;
    parent.kill('SIGKILL');
  });

  await aguardarMorte(parent.pid!);
  await aguardarMorte(netoPid);

  if (process.platform === 'win32') {
    // No Windows, `taskkill /T /F` deveria ter funcionado sem cair no fallback.
    assert.equal(fallbackChamado, false);
  }
});

test('killProcessTree resolve sem erro para PID inexistente', async () => {
  // PID improvável de existir; a função deve resolver (best-effort) e não lançar.
  await assert.doesNotReject(killProcessTree(999_999, () => {}));
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { ValidationPolicy } from '@agents-hub/core';
import { runValidation } from './validation.js';

/**
 * Achado §3.7 do doc 08: o portão de validação matava só o `cmd.exe`/`sh` no
 * timeout (`shell: true` + `child.kill()`), deixando o `npm`/`node` real
 * vivo, preso escrevendo no worktree que a run deveria liberar.
 *
 * O script abaixo reproduz a árvore de três níveis do caso real:
 * `spawn(..., {shell:true})` → `cmd.exe`/`sh` → `node parent.js` → neto
 * `detached`, que ignora SIGTERM. Só `taskkill /T /F` (via `killProcessTree`)
 * derruba a árvore inteira.
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

setInterval(() => {}, 1000 * 60);
`;

const NETO_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');

const outDir = process.argv[2];
fs.writeFileSync(path.join(outDir, 'neto.pid'), String(process.pid));
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

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('runValidation mata a árvore inteira quando o comando estoura o timeout', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hub-validation-tree-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'parent.js'), PARENT_SCRIPT, 'utf8');
  writeFileSync(path.join(dir, 'neto.js'), NETO_SCRIPT, 'utf8');

  const policy: ValidationPolicy = {
    command: `node "${path.join(dir, 'parent.js')}" "${dir}"`,
    commandTimeoutSeconds: 1,
    review: { enabled: false, agent: null },
  };

  const outcome = await runValidation(policy, { workdir: dir, acceptanceCriteria: [] });

  assert.ok(outcome);
  assert.equal(outcome.passed, false);
  assert.match(outcome.checks[0]?.detail ?? '', /excedeu/);

  const netoPidStr = await aguardarArquivo(path.join(dir, 'neto.pid'));
  const netoPid = Number(netoPidStr);
  assert.ok(Number.isInteger(netoPid) && netoPid > 0);

  // `killProcessTree` já resolveu dentro de `runValidation`; o neto deve
  // estar morto imediatamente, não só "eventualmente".
  assert.equal(pidVivo(netoPid), false, 'o processo neto sobreviveu ao timeout do portão');
});

test('runValidation aprova quando o comando sai com código 0', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hub-validation-ok-'));
  dirs.push(dir);

  const policy: ValidationPolicy = {
    command: process.platform === 'win32' ? 'exit 0' : 'true',
    commandTimeoutSeconds: 10,
    review: { enabled: false, agent: null },
  };

  const outcome = await runValidation(policy, { workdir: dir, acceptanceCriteria: [] });
  assert.ok(outcome);
  assert.equal(outcome.passed, true);
});

test('runValidation retorna null quando não há comando configurado', async () => {
  const policy: ValidationPolicy = {
    command: null,
    commandTimeoutSeconds: 10,
    review: { enabled: false, agent: null },
  };

  const outcome = await runValidation(policy, { workdir: os.tmpdir(), acceptanceCriteria: [] });
  assert.equal(outcome, null);
});

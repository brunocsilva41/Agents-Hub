import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  bootDoProcStat,
  horarioDeCriacaoDoProcesso,
  inicioPeloLstart,
  inicioPeloProcStat,
  killProcessTree,
  opcoesDeGrupo,
  imagemPareceEsperada,
  pidPareceReciclado,
  TOLERANCIA_RELOGIO_MS,
} from './process-tree.js';

/**
 * Prova que `killProcessTree` mata a árvore inteira, não só o processo raiz.
 *
 * O script "pai" spawna um "neto" (no Windows `detached: true`, sem relação
 * de pipe com o pai; no POSIX no mesmo grupo do pai) que ignora SIGTERM e escreve o próprio PID num arquivo — o mesmo
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

// Windows: \`detached\` desliga o neto do pai (o caso que exige \`/T\`). POSIX:
// o neto fica no grupo do pai, como o filho real de um shim; um processo que
// sai do grupo de propósito (setsid) não é alcançável por kill de grupo.
const neto = spawn(process.execPath, [netoScript, outDir], {
  detached: process.platform === 'win32',
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
    // Como os adapters fazem: no POSIX o pai vira líder de grupo.
    ...opcoesDeGrupo(),
  });
  assert.ok(parent.pid, 'processo pai deveria ter PID');

  const netoPidStr = await aguardarArquivo(path.join(dir, 'neto.pid'));
  const netoPid = Number(netoPidStr);
  assert.ok(Number.isInteger(netoPid) && netoPid > 0);
  assert.ok(pidVivo(netoPid), 'neto deveria estar vivo antes do kill');

  let fallbackChamado = false;
  await killProcessTree(parent.pid, () => {
    fallbackChamado = true;
    parent.kill('SIGKILL');
  });

  await aguardarMorte(parent.pid);
  await aguardarMorte(netoPid);

  if (process.platform === 'win32') {
    // No Windows, `taskkill /T /F` deveria ter funcionado sem cair no fallback.
    assert.equal(fallbackChamado, false);
  }
});

/**
 * R06-13 (vistoria 2026-09-25): em POSIX o kill ia só no PID direto. Só roda
 * fora do Windows — no Windows quem anda a árvore é o `taskkill /T`, coberto
 * pelo teste acima.
 */
test(
  'POSIX: kill de grupo derruba o neto que ficou no grupo, mesmo com o pai ignorando SIGTERM',
  { skip: process.platform === 'win32' ? 'kill de grupo é POSIX; no Windows vale taskkill /T' : false },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hub-process-grupo-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'parent.js'), PARENT_SCRIPT, 'utf8');
    writeFileSync(path.join(dir, 'neto.js'), NETO_SCRIPT, 'utf8');
    const parent = spawn(process.execPath, [path.join(dir, 'parent.js'), dir], {
      stdio: 'ignore',
      ...opcoesDeGrupo(),
    });
    const netoPid = Number(await aguardarArquivo(path.join(dir, 'neto.pid')));
    let fallback = false;
    // O fallback mata só o pai: se fosse ele a agir, o neto sobreviveria.
    await killProcessTree(parent.pid!, () => {
      fallback = true;
      parent.kill('SIGKILL');
    });
    await aguardarMorte(netoPid);
    assert.equal(fallback, false);
  },
);

test('montagem: grupo próprio só fora do Windows', () => {
  assert.deepEqual(opcoesDeGrupo('win32'), {});
  assert.deepEqual(opcoesDeGrupo('linux'), { detached: true });
  assert.deepEqual(opcoesDeGrupo('darwin'), { detached: true });
});

test('montagem: em POSIX o kill vai para o GRUPO (-pid) com SIGKILL', async () => {
  const chamadas: Array<[number, string]> = [];
  let fallback = 0;
  await killProcessTree(4321, () => (fallback += 1), {
    platform: 'linux',
    kill: (p, s) => void chamadas.push([p, s]),
  });
  assert.deepEqual(chamadas, [[-4321, 'SIGKILL']]);
  assert.equal(fallback, 0);
});

test('montagem: sem grupo (ESRCH) cai no fallback; PID inválido nunca vira kill(-1)/kill(0)', async () => {
  let fallback = 0;
  await killProcessTree(4321, () => (fallback += 1), {
    platform: 'linux',
    kill: () => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    },
  });
  assert.equal(fallback, 1);

  const chamadas: number[] = [];
  for (const pid of [-1, 0, 1, Number.NaN]) {
    await killProcessTree(pid, () => (fallback += 1), {
      platform: 'linux',
      kill: (p) => void chamadas.push(p),
    });
  }
  assert.deepEqual(chamadas, []);
  assert.equal(fallback, 5);
});

test('killProcessTree resolve sem erro para PID inexistente', async () => {
  // PID improvável de existir; a função deve resolver (best-effort) e não lançar.
  await assert.doesNotReject(killProcessTree(999_999, () => {}));
});

/**
 * `imagemPareceEsperada`/`pidPareceReciclado` são a lógica que decide se um
 * PID reconciliado no restart do daemon ainda é o processo esperado — extraídas
 * de `session-manager.ts` sem teste próprio até aqui (achado de auditoria).
 * Puras, sem I/O: testadas direto, sem precisar de processo real.
 */

test('imagemPareceEsperada: nome bate exatamente (com ou sem .exe)', () => {
  assert.equal(imagemPareceEsperada('claude.exe', 'claude'), true);
  assert.equal(imagemPareceEsperada('claude', 'claude.exe'), true);
  assert.equal(imagemPareceEsperada('CLAUDE.EXE', 'claude'), true, 'comparação é case-insensitive');
});

test('imagemPareceEsperada: aceita cmd/sh/bash como wrapper plausível de qualquer bin', () => {
  assert.equal(imagemPareceEsperada('cmd.exe', 'codex'), true);
  assert.equal(imagemPareceEsperada('sh', 'opencode'), true);
  assert.equal(imagemPareceEsperada('bash', 'kimi'), true);
});

test('imagemPareceEsperada: NÃO aceita node como wrapper genérico', () => {
  // Aceitar `node` deixaria qualquer script Node do usuário elegível para
  // ser morto por qualquer agente — o wrapper aceito é só o shell que
  // `needsShell: true` de fato usa.
  assert.equal(imagemPareceEsperada('node.exe', 'claude'), false);
});

test('imagemPareceEsperada: aceita o executável que o shim npm desembrulhado de fato spawnou', () => {
  // Shim npm desembrulhado (resolverShimNpm): o PID guardado é do node.exe
  // que roda o script do PRÓPRIO agente, ou do .exe real — não de um cmd.exe.
  assert.equal(imagemPareceEsperada('node.exe', 'copilot', 'C:\\Program Files\\nodejs\\node.exe'), true);
  assert.equal(
    imagemPareceEsperada(
      'opencode.exe',
      'opencode',
      'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe',
    ),
    true,
  );
  // Sem o executável resolvido, node continua recusado.
  assert.equal(imagemPareceEsperada('node.exe', 'copilot'), false);
});

test('imagemPareceEsperada: imagem sem relação com o bin é recusada', () => {
  assert.equal(imagemPareceEsperada('chrome.exe', 'claude'), false);
});

test('pidPareceReciclado: horário desconhecido nunca conta como reciclado', () => {
  assert.equal(pidPareceReciclado(null, new Date().toISOString()), false);
});

test('pidPareceReciclado: processo nascido bem depois do último updatedAt é reciclado', () => {
  const referencia = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const nascidoDepois = new Date('2026-01-01T00:00:30.000Z');
  assert.equal(pidPareceReciclado(nascidoDepois, referencia), true);
});

test('pidPareceReciclado: dentro da tolerância de relógio não conta como reciclado', () => {
  const referencia = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const dentroDaFolga = new Date(new Date(referencia).getTime() + TOLERANCIA_RELOGIO_MS - 1);
  assert.equal(pidPareceReciclado(dentroDaFolga, referencia), false);
});

test('pidPareceReciclado: processo nascido antes do último updatedAt não é reciclado (órfão de verdade)', () => {
  const referencia = new Date('2026-01-01T00:10:00.000Z').toISOString();
  const nascidoAntes = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(pidPareceReciclado(nascidoAntes, referencia), false);
});

test('pidPareceReciclado: referência inválida não lança e não conta como reciclado', () => {
  assert.equal(pidPareceReciclado(new Date(), 'não é uma data'), false);
});

/**
 * Horário de criação do processo no POSIX: antes `horarioDeCriacaoDoProcesso`
 * devolvia `null` fora do Windows, e a checagem de PID reciclado da
 * reconciliação não valia no Linux/macOS. O parse é puro e roda em qualquer
 * plataforma; a consulta de verdade roda em todas (PowerShell, `/proc`, `ps`).
 */
test('bootDoProcStat: lê o btime de /proc/stat', () => {
  const procStat = 'cpu  1 2 3 4\nintr 99\nctxt 1234\nbtime 1790000000\nprocesses 42\n';
  assert.equal(bootDoProcStat(procStat), 1790000000);
  assert.equal(bootDoProcStat('cpu 1 2 3\n'), null);
});

test('inicioPeloProcStat: soma o starttime (campo 22, em ticks) ao boot', () => {
  // comm com espaço e ")" de propósito: o campo 22 conta depois do ÚLTIMO ")".
  const campos = ['S', '1', ...Array.from({ length: 17 }, (_, i) => String(i + 10)), '12345', '99'];
  const stat = `4242 (node) (x) ${campos.join(' ')}`;
  const inicio = inicioPeloProcStat(stat, 1_790_000_000, 100);
  assert.equal(inicio?.getTime(), 1_790_000_000_000 + 123_450);
  assert.equal(inicioPeloProcStat(stat, 1_790_000_000, 1000)?.getTime(), 1_790_000_000_000 + 12_345);
});

test('inicioPeloProcStat: stat truncado ou sem parênteses devolve null', () => {
  assert.equal(inicioPeloProcStat('4242 node S 1', 0, 100), null);
  assert.equal(inicioPeloProcStat('4242 (node) S 1 2 3', 0, 100), null);
});

test('inicioPeloLstart: formato do ps com LC_ALL=C e TZ=UTC', () => {
  assert.equal(
    inicioPeloLstart('Tue Sep 29 12:34:56 2026\n')?.toISOString(),
    '2026-09-29T12:34:56.000Z',
  );
  // Dia de um dígito vem com espaço duplo.
  assert.equal(inicioPeloLstart('Thu Oct  1 00:00:05 2026')?.toISOString(), '2026-10-01T00:00:05.000Z');
  assert.equal(inicioPeloLstart('ter 29 set 2026 12:34:56'), null);
  assert.equal(inicioPeloLstart(''), null);
});

test('horarioDeCriacaoDoProcesso: o do processo atual bate com o uptime dele', async () => {
  const esperado = Date.now() - process.uptime() * 1000;
  const inicio = await horarioDeCriacaoDoProcesso(process.pid);
  assert.ok(inicio, `o SO deveria informar o início do pid ${process.pid} em ${process.platform}`);
  assert.ok(
    Math.abs(inicio.getTime() - esperado) <= TOLERANCIA_RELOGIO_MS,
    `início ${inicio.toISOString()} longe do esperado ${new Date(esperado).toISOString()}`,
  );
});

test('horarioDeCriacaoDoProcesso: PID inexistente ou inválido devolve null', async () => {
  assert.equal(await horarioDeCriacaoDoProcesso(999_999_999), null);
  assert.equal(await horarioDeCriacaoDoProcesso(-1), null);
});

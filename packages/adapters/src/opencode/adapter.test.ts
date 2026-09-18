import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { clearBinCache } from '../bin-resolver.js';
import { AgentManifestSchema } from '../types.js';
import { createOpenCodeAdapter, type OpenCodeAdapter } from './adapter.js';

/**
 * Achado §3.7.1 do doc 08: `opencode serve` sobe com stderr em `pipe` e
 * ninguém lê o outro lado. Em POSIX, isso enche o buffer do SO (tipicamente
 * ~64 KB) e a escrita do processo filho BLOQUEIA — o "opencode serve" nunca
 * chega a `server.listen()`, e o boot do Hub fica esperando um health check
 * que nunca vem.
 *
 * Medido: neste ambiente (Windows), escrever dezenas de MB em `child.stderr`
 * sem leitor nenhum NÃO bloqueou o processo filho — o pipe nomeado do Windows
 * não reproduziu o travamento de forma determinística num teste rápido, ao
 * contrário do buffer fixo de um pipe POSIX. Por isso este teste não tenta
 * provar o travamento (seria não-determinístico, ou exigiria um volume grande
 * o bastante para o teste ficar lento e frágil); ele prova o que É
 * determinístico e comum aos dois mundos: que o Hub REALMENTE drena o stderr
 * do processo filho, em vez de só declarar `stdio: 'pipe'` e não ler nada —
 * que é a causa raiz do risco em qualquer SO, blocante ou não.
 */

const FAKE_SERVER_SCRIPT = `
const http = require('node:http');
const fs = require('node:fs');

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);

// ~300 KB em 300 linhas — de sobra acima de um buffer de pipe POSIX típico
// (~64 KB), caso o teste rode em Linux/macOS algum dia. writeSync vai direto
// ao fd, sem o buffer interno do Node por trás de process.stderr. Em linhas
// (não um blob só) porque o dreno do adapter é por linha.
const linha = 'x'.repeat(1000) + '\\n';
for (let i = 0; i < 300; i += 1) fs.writeSync(2, linha);
fs.writeSync(2, Buffer.from('MARCA_FIM_DO_DESPEJO\\n'));

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }
  if (req.method === 'POST' && req.url === '/api/session') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { id: 'ses_fake1' } }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1');
`;

interface Ambiente {
  dir: string;
  binName: string;
}

function montarBinarioFalso(): Ambiente {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hub-opencode-stderr-'));
  const script = path.join(dir, 'fake-opencode-server.cjs');
  writeFileSync(script, FAKE_SERVER_SCRIPT, 'utf8');

  const binName = 'opencode-fake-stderr-test';

  if (process.platform === 'win32') {
    writeFileSync(path.join(dir, `${binName}.cmd`), `@echo off\r\nnode "${script}" %*\r\n`, 'utf8');
  } else {
    const shPath = path.join(dir, binName);
    writeFileSync(shPath, `#!/bin/sh\nexec node "${script}" "$@"\n`, 'utf8');
    chmodSync(shPath, 0o755);
  }

  return { dir, binName };
}

let ambiente: Ambiente;
let pathOriginal: string | undefined;
let adapter: OpenCodeAdapter | null = null;

before(() => {
  ambiente = montarBinarioFalso();
  pathOriginal = process.env['PATH'];
  process.env['PATH'] = `${ambiente.dir}${path.delimiter}${pathOriginal ?? ''}`;
  clearBinCache();
});

after(async () => {
  if (adapter) await adapter.close().catch(() => undefined);
  process.env['PATH'] = pathOriginal;
  clearBinCache();
  try {
    rmSync(ambiente.dir, { recursive: true, force: true });
  } catch {
    /* limpeza de temp é oportunista */
  }
});

test(
  'stderr do "opencode serve" é drenado e chega ao console do Hub, não só declarado como pipe',
  { timeout: 15_000 },
  async () => {
    const manifest = AgentManifestSchema.parse({
      id: 'opencode',
      name: 'OpenCode Falso',
      bin: ambiente.binName,
      invoke: { oneShot: ['run'] },
    });

    adapter = createOpenCodeAdapter(manifest, { port: 48923, host: '127.0.0.1' });

    const linhasCapturadas: string[] = [];
    const consoleErrorOriginal = console.error;
    console.error = (...args: unknown[]): void => {
      linhasCapturadas.push(args.map(String).join(' '));
    };
    let handle;
    try {
      handle = await adapter.start(
        {
          sessionId: 'ses_teste',
          taskId: null,
          agentId: 'opencode',
          workdir: ambiente.dir,
          mode: 'autonomous',
          env: {},
          timeoutSeconds: 30,
          heartbeatSeconds: 30,
        },
        'prompt de teste',
      );

      // O boot já prova que o processo não ficou preso (respondeu ao health
      // check). A marca no fim do despejo prova que quem ficou preso, se
      // alguém ficasse, seria detectável: o dreno de fato lê e repassa.
      await esperarLinha(linhasCapturadas, 'MARCA_FIM_DO_DESPEJO', 5_000);
    } finally {
      console.error = consoleErrorOriginal;
    }

    assert.equal(handle.nativeSessionId, 'ses_fake1');
    assert.ok(
      linhasCapturadas.some((l) => l.includes('[opencode serve]') && l.includes('MARCA_FIM_DO_DESPEJO')),
      `esperava a última linha do stderr do processo filho ecoada no console do Hub, prefixada com "[opencode serve]". Capturado (${linhasCapturadas.length} linhas): ${JSON.stringify(linhasCapturadas.slice(0, 5))}`,
    );
  },
);

async function esperarLinha(linhas: string[], marca: string, timeoutMs: number): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (linhas.some((l) => l.includes(marca))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AgentDiscovery } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

/**
 * Item 1.8 do GOAL: endurecimento da borda HTTP, sempre contra o daemon de
 * verdade (porta própria, `home` temporário, nenhum CLI de modelo real).
 *
 * `node:http` cru em vez de `fetch`: aqui importa controlar exatamente os
 * cabeçalhos (`Origin: null`, `Content-Length: 0`, `Sec-Fetch-Site`) e mandar
 * caminho com `%` malformado e `::$DATA` sem normalização do cliente.
 */

const TOKEN_ARG = 'sk-ant-SEGREDOARGS1234567890abcdef';
const BEARER = 'bearerSEGREDO-abcdefghijklmnop';
const SIG = 'SEGREDOLONGO123';

interface Resposta {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let porta = 0;

/** Requisição crua; resolve com a resposta mesmo se o servidor fechar no meio do envio. */
function http(
  method: string,
  caminho: string,
  opts: {
    headers?: Record<string, string>;
    body?: Buffer | string;
    chunked?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<Resposta> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${porta}`, ...(opts.headers ?? {}) };
    const body = opts.body === undefined ? undefined : Buffer.from(opts.body);
    if (body !== undefined && !opts.chunked && headers['content-length'] === undefined) {
      headers['content-length'] = String(body.length);
    }
    const req = request(
      {
        host: '127.0.0.1',
        port: porta,
        method,
        path: caminho,
        headers,
        timeout: opts.timeoutMs ?? 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`sem resposta em ${opts.timeoutMs ?? 5000} ms (conexão pendurada)`));
    });
    // EPIPE/ECONNRESET ao mandar o corpo depois de o servidor já ter
    // respondido 413 é esperado; só vira falha se nenhuma resposta chegar.
    req.on('error', (err) => setTimeout(() => reject(err), 200));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('borda HTTP endurecida (item 1.8)', () => {
  let raiz: string;
  let hub: Hub;
  let projetoPath: string;
  let arquivoComum: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-borda-'));
    const manifestos = path.join(raiz, 'manifests');
    const webRoot = path.join(raiz, 'web');
    projetoPath = path.join(raiz, 'projeto');
    arquivoComum = path.join(raiz, 'arquivo.txt');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(webRoot, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });
    writeFileSync(arquivoComum, 'não sou pasta');
    writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>ui</title>');
    writeFileSync(
      path.join(manifestos, 'claude.yaml'),
      `id: claude
name: claude
vendor: Test
description: agente falso
bin: node-que-nao-existe-hub-teste
invoke:
  oneShot: ["x"]
  interactive: false
detect:
  args: ["--version"]
capabilities:
  - code-edit
session:
  strategy: replay
stream:
  format: text
  mapper: generic-text
defaults:
  isolation: none
  timeoutSeconds: 30
`,
    );

    // Leitor de descoberta falso que VAZA segredo em args e URL, como um
    // leitor com bug faria: a rota tem de mascarar mesmo assim.
    const fake = async (id: string): Promise<AgentDiscovery> => ({
      agentId: id,
      installed: false,
      version: null,
      binPath: null,
      auth: { state: 'unknown', evidence: [] },
      defaults: {},
      files: [],
      mcpServers: [
        {
          name: 'remoto',
          transport: 'stdio',
          command: 'npx',
          args: [
            'mcp-remote',
            'https://h.exemplo/mcp',
            '--header',
            `Authorization: Bearer ${BEARER}`,
            '--api-key',
            TOKEN_ARG,
            `--token=${TOKEN_ARG}`,
          ],
          url: `https://h.exemplo/mcp?sig=${SIG}`,
          source: '/x',
          isHub: false,
        },
      ],
      instructionFiles: [],
      warnings: [],
    });

    hub = createHub(
      { home: path.join(raiz, 'hubhome'), manifestsDir: manifestos, port: 0, webRoot },
      { discoverAgent: fake, homeDir: path.join(raiz, 'home') },
    );
    porta = (await hub.start()).port;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza oportunista */
    }
  });

  // ------------------------------------------------------------------ (a)
  test('(a) Origin: null com POST Content-Length: 0 é recusado', async () => {
    const r = await http('POST', '/maintenance/sweep', {
      headers: { origin: 'null', 'content-length': '0' },
    });
    assert.equal(r.status, 403, r.body);
  });

  test('(a) Origin loopback sem porta (porta 80 implícita) é outra origem', async () => {
    const r = await http('POST', '/maintenance/sweep', {
      headers: { origin: 'http://localhost', 'content-length': '0' },
    });
    assert.equal(r.status, 403, r.body);
  });

  test('(a) Sec-Fetch-Site cross-site sem Origin não muda estado', async () => {
    const r = await http('POST', '/maintenance/sweep', {
      headers: { 'sec-fetch-site': 'cross-site', 'content-length': '0' },
    });
    assert.equal(r.status, 403, r.body);
  });

  test('(a) corpo não-JSON continua 415; cliente local sem Origin segue passando', async () => {
    const texto = await http('POST', '/projects', {
      headers: { 'content-type': 'text/plain' },
      body: '{"path":"x"}',
    });
    assert.equal(texto.status, 415);

    // `sweep` exige o token de operador (item 1.6); o que se mede aqui é a
    // guarda de borda deixar passar o cliente local legítimo.
    const auth = { authorization: `Bearer ${hub.operatorToken}` };
    const ok = await http('POST', '/maintenance/sweep', { headers: { 'content-length': '0', ...auth } });
    assert.equal(ok.status, 200, ok.body);

    const mesma = await http('POST', '/maintenance/sweep', {
      headers: {
        origin: `http://127.0.0.1:${porta}`,
        'content-length': '0',
        'sec-fetch-site': 'same-origin',
        ...auth,
      },
    });
    assert.equal(mesma.status, 200, mesma.body);
  });

  // ------------------------------------------------------------------ (b)
  test('(b) % malformado na rota responde 400 em vez de pendurar', async () => {
    for (const caminho of ['/sessions/%E0%A4%A', '/tasks/%zz', '/approvals/%']) {
      const r = await http('GET', caminho, { timeoutMs: 3000 });
      assert.equal(r.status, 400, `${caminho}: ${r.body}`);
      assert.match(r.body, /MALFORMED_URL/);
    }
  });

  // ------------------------------------------------------------------ (c)
  test('(c) JSON malformado é 400 INVALID_JSON, sem a mensagem do parser', async () => {
    const r = await http('POST', '/projects', {
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    assert.equal(r.status, 400, r.body);
    assert.match(r.body, /INVALID_JSON/);
    assert.doesNotMatch(r.body, /position|Expected property/);
  });

  test('(c) corpo acima de 5 MB é 413, declarado ou chunked', async () => {
    const grande = Buffer.alloc(6_000_000, 0x20);
    const declarado = await http('POST', '/projects', {
      headers: { 'content-type': 'application/json' },
      body: grande,
    });
    assert.equal(declarado.status, 413, declarado.body);
    assert.match(declarado.body, /PAYLOAD_TOO_LARGE/);

    const chunked = await http('POST', '/projects', {
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      body: grande,
      chunked: true,
    });
    assert.equal(chunked.status, 413, chunked.body);

    // O daemon segue de pé depois disso.
    assert.equal((await http('GET', '/health')).status, 200);
  });

  // ------------------------------------------------------------------ (d)
  test('(d) /discovery mascara segredo em args e na query da URL', async () => {
    const r = await http('GET', '/discovery?refresh=1', { timeoutMs: 30_000 });
    assert.equal(r.status, 200, r.body);
    assert.ok(!r.body.includes(TOKEN_ARG), 'token de --api-key/--token vazou');
    assert.ok(!r.body.includes(BEARER), 'Bearer de --header vazou');
    assert.ok(!r.body.includes(SIG), 'sig= da URL vazou');
    const agente = (JSON.parse(r.body) as { agents: AgentDiscovery[] }).agents[0];
    const args = agente?.mcpServers[0]?.args ?? [];
    assert.ok(args.includes('mcp-remote'), 'arg inocente continua visível');
    assert.ok(args.includes('--api-key'), 'o NOME da flag continua visível');
    assert.ok(args.includes('Authorization: ***'));
  });

  // ------------------------------------------------------------------ (e)
  test('(e) caminho de projeto inexistente, relativo ou arquivo é 400 com motivo', async () => {
    const casos: [string, RegExp][] = [
      [path.join(raiz, 'nao-existe'), /não existe/],
      ['relativo/pasta', /relativo/],
      [arquivoComum, /não é uma pasta/],
    ];
    for (const [p, motivo] of casos) {
      const r = await http('POST', '/projects', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      assert.equal(r.status, 400, `${p}: ${r.body}`);
      assert.match(r.body, /INVALID_PATH/);
      assert.match(r.body, motivo);
    }

    const ok = await http('POST', '/projects', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projetoPath }),
    });
    assert.equal(ok.status, 201, ok.body);
    const id = (JSON.parse(ok.body) as { project: { id: string } }).project.id;

    const pasta = await http('POST', `/projects/${id}/folders`, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hub.operatorToken}` },
      body: JSON.stringify({ path: path.join(raiz, 'outra-que-nao-existe') }),
    });
    assert.equal(pasta.status, 400, pasta.body);
    assert.match(pasta.body, /INVALID_PATH/);
  });

  // ------------------------------------------------------------------ (f)
  test('(f) estático recusa stream alternativo do NTFS e variantes', async () => {
    assert.equal((await http('GET', '/index.html')).status, 200, 'o arquivo real continua servido');
    for (const caminho of [
      '/index.html::$DATA',
      '/index.html:$DATA',
      '/index.html%3A%3A$DATA',
      '/index.html.',
      '/index.html%20',
      '/CON',
      '/nul.txt',
      '/%5c..%5cindex.html',
    ]) {
      const r = await http('GET', caminho);
      assert.ok(r.status === 400 || r.status === 403, `${caminho} devolveu ${r.status}`);
      assert.doesNotMatch(r.body, /<title>ui<\/title>/, `${caminho} serviu o HTML`);
    }
  });

  // ------------------------------------------------------------------ (g)
  test('(g) /health não expõe o home do usuário', async () => {
    const r = await http('GET', '/health');
    assert.equal(r.status, 200);
    const corpo = JSON.parse(r.body) as Record<string, unknown>;
    assert.equal(corpo['home'], undefined);
    assert.ok(!r.body.includes(raiz.replace(/\\/g, '\\\\')), 'caminho do home vazou');
    assert.equal(corpo['ok'], true);
  });
});

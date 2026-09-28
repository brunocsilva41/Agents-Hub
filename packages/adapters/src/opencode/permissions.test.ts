import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { SessionMode } from '@agents-hub/core';
import { clearBinCache } from '../bin-resolver.js';
import { AgentManifestSchema, type MappedEvent, type RunContext } from '../types.js';
import { createOpenCodeAdapter, type OpenCodeAdapter } from './adapter.js';
import { configDosAgentesDoHub, OPENCODE_AGENTE_DO_MODO } from './permissions.js';

/**
 * Item 4.2 do GOAL: o modo do Hub não restringia nada no OpenCode — o adapter
 * nunca mandava `agent`, e o agente padrão (`build`) é `allow *`.
 *
 * O servidor aqui é falso (HTTP + SSE no próprio processo): o que se testa é o
 * CONTRATO que o adapter fala com `opencode serve`, levantado contra o binário
 * 1.18.32 (ver `permissions.ts`). Nenhuma chamada de modelo.
 */

interface Registro {
  method: string;
  url: string;
  body: unknown;
}

interface ServidorFalso {
  port: number;
  requests: Registro[];
  /** Agentes que `GET /api/agent` lista. */
  agentes: string[];
  /** Eventos emitidos no SSE logo depois do prompt ser admitido. */
  aposPrompt: (sessionID: string) => unknown[];
  close: () => Promise<void>;
}

async function subirServidorFalso(): Promise<ServidorFalso> {
  const streams = new Set<http.ServerResponse>();
  const estado: ServidorFalso = {
    port: 0,
    requests: [],
    agentes: ['build', 'plan'],
    aposPrompt: (sessionID) => [{ type: 'session.idle', data: { sessionID } }],
    close: async () => undefined,
  };

  const emitir = (evento: unknown): void => {
    for (const res of streams) res.write(`data: ${JSON.stringify(evento)}\n\n`);
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const url = req.url ?? '';
      estado.requests.push({
        method: req.method ?? '',
        url,
        body: raw ? (JSON.parse(raw) as unknown) : null,
      });
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.method === 'GET' && url === '/api/health') return json(200, { healthy: true });
      if (req.method === 'GET' && url === '/api/agent') {
        return json(200, { data: estado.agentes.map((id) => ({ id })) });
      }
      if (req.method === 'POST' && url === '/api/session')
        return json(200, { data: { id: 'ses_falsa' } });
      if (req.method === 'GET' && url === '/api/session/ses_falsa')
        return json(200, { data: { id: 'ses_falsa' } });
      if (req.method === 'POST' && url === '/api/session/ses_falsa/agent') {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET' && url === '/api/session/active') return json(200, { data: {} });
      if (req.method === 'GET' && url === '/api/event') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': heartbeat\n\n');
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      if (req.method === 'POST' && url === '/api/session/ses_falsa/prompt') {
        json(200, { data: { id: 'msg_1', sessionID: 'ses_falsa' } });
        // O servidor real ecoa o prompt admitido antes de o loop começar.
        setTimeout(() => {
          const prompt = (JSON.parse(raw) as { prompt: { text: string } }).prompt;
          emitir({ type: 'session.next.prompt.admitted', data: { sessionID: 'ses_falsa', prompt } });
          emitir({ type: 'session.next.prompted', data: { sessionID: 'ses_falsa', prompt } });
          for (const e of estado.aposPrompt('ses_falsa')) emitir(e);
        }, 20);
        return;
      }
      if (req.method === 'POST' && /\/reply$|\/reject$/.test(url)) {
        res.writeHead(204);
        return res.end();
      }
      json(404, {});
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  estado.port = (server.address() as AddressInfo).port;
  estado.close = () =>
    new Promise<void>((resolve) => {
      for (const res of streams) res.destroy();
      server.close(() => resolve());
    });
  return estado;
}

const manifesto = AgentManifestSchema.parse({
  id: 'opencode',
  name: 'OpenCode Falso',
  bin: 'opencode-binario-que-nao-existe-hub',
  invoke: { oneShot: ['run'] },
});

function ctx(mode: SessionMode): RunContext {
  return {
    sessionId: 'ses_hub',
    taskId: null,
    agentId: 'opencode',
    workdir: os.tmpdir(),
    mode,
    env: {},
    timeoutSeconds: 30,
    heartbeatSeconds: 30,
  };
}

async function drenar(events: AsyncIterable<MappedEvent>): Promise<MappedEvent[]> {
  const out: MappedEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('OpenCode: modo do Hub → agente com permissão real', () => {
  let servidor: ServidorFalso;
  let adapter: OpenCodeAdapter;

  before(async () => {
    servidor = await subirServidorFalso();
    adapter = createOpenCodeAdapter(manifesto, { port: servidor.port, autoStart: false });
  });
  after(async () => {
    await adapter.close();
    await servidor.close();
  });

  for (const mode of ['supervised', 'semi', 'autonomous'] as const) {
    test(`start em ${mode} cria a sessão com o agente ${OPENCODE_AGENTE_DO_MODO[mode]}`, async () => {
      servidor.agentes = ['build', 'plan', 'hub-supervised', 'hub-semi', 'hub-autonomous'];
      servidor.requests.length = 0;
      const handle = await adapter.start(ctx(mode), 'faça algo');
      const eventos = await drenar(handle.events);
      await handle.done;

      const criou = servidor.requests.find((r) => r.method === 'POST' && r.url === '/api/session');
      assert.equal((criou?.body as Record<string, unknown>)['agent'], OPENCODE_AGENTE_DO_MODO[mode]);
      assert.ok(
        !eventos.some((e) => e.type === 'log' && e.payload['level'] === 'warn'),
        'com os agentes hub-* disponíveis não há aviso de restrição parcial',
      );
    });
  }

  test('servidor sem os agentes hub-* (subido pelo usuário): supervised cai no "plan" e AVISA na timeline', async () => {
    servidor.agentes = ['build', 'plan'];
    servidor.requests.length = 0;
    const handle = await adapter.start(ctx('supervised'), 'faça algo');
    const eventos = await drenar(handle.events);

    const criou = servidor.requests.find((r) => r.method === 'POST' && r.url === '/api/session');
    assert.equal((criou?.body as Record<string, unknown>)['agent'], 'plan');
    const aviso = eventos.find((e) => e.type === 'log' && e.payload['level'] === 'warn');
    assert.match(String(aviso?.payload['text']), /shell NÃO são barrados/);
  });

  test('resume troca o agente da sessão para o do modo atual antes do prompt', async () => {
    servidor.agentes = ['build', 'plan', 'hub-supervised', 'hub-semi', 'hub-autonomous'];
    servidor.requests.length = 0;
    const handle = await adapter.resume(ctx('supervised'), 'ses_falsa', 'continue');
    await drenar(handle.events);

    const troca = servidor.requests.findIndex(
      (r) => r.method === 'POST' && r.url === '/api/session/ses_falsa/agent',
    );
    const prompt = servidor.requests.findIndex(
      (r) => r.method === 'POST' && r.url === '/api/session/ses_falsa/prompt',
    );
    assert.ok(troca >= 0, 'esperava POST /api/session/{id}/agent no resume');
    assert.deepEqual(servidor.requests[troca]?.body, { agent: 'hub-supervised' });
    assert.ok(troca < prompt, 'a troca de agente tem de vir antes do prompt');
  });

  // R10-07: o manifesto promete `provider/model`, mas o providerID ia fixo
  // em 'opencode' — `-m zai-coding-plan/glm-4.6` virava um modelo inexistente.
  for (const [pedido, esperado] of [
    ['zai-coding-plan/glm-4.6', { providerID: 'zai-coding-plan', id: 'glm-4.6' }],
    ['openrouter/anthropic/claude-x', { providerID: 'openrouter', id: 'anthropic/claude-x' }],
    ['glm-4.6', { providerID: 'opencode', id: 'glm-4.6' }],
  ] as const) {
    test(`modelo "${pedido}" vai ao servidor como ${esperado.providerID} + ${esperado.id} (start e resume)`, async () => {
      servidor.agentes = ['hub-semi'];
      servidor.aposPrompt = (sessionID) => [{ type: 'session.idle', data: { sessionID } }];
      const comModelo = { ...ctx('semi'), model: pedido };

      servidor.requests.length = 0;
      await drenar((await adapter.start(comModelo, 'oi')).events);
      const criou = servidor.requests.find((r) => r.method === 'POST' && r.url === '/api/session');
      assert.deepEqual((criou?.body as Record<string, unknown>)['model'], esperado);

      servidor.requests.length = 0;
      await drenar((await adapter.resume(comModelo, 'ses_falsa', 'de novo')).events);
      const trocou = servidor.requests.find(
        (r) => r.method === 'POST' && r.url === '/api/session/ses_falsa/model',
      );
      assert.deepEqual(trocou?.body, { model: esperado });
    });
  }

  test('pedido de permissão pendente é recusado na hora (não trava o turno) e não vira aprovação fantasma', async () => {
    servidor.agentes = ['build', 'plan'];
    servidor.requests.length = 0;
    servidor.aposPrompt = (sessionID) => [
      {
        type: 'permission.v2.asked',
        data: { id: 'per_1', sessionID, action: 'read', resources: ['C:\\repo\\.env'] },
      },
      { type: 'session.idle', data: { sessionID } },
    ];
    const handle = await adapter.start(ctx('semi'), 'leia o .env');
    const eventos = await drenar(handle.events);
    // A recusa é disparada sem await no loop do stream: espera ela chegar ao
    // servidor falso (com prazo), em vez de um respiro fixo que num runner
    // lento chega antes da requisição.
    const acharRecusa = () =>
      servidor.requests.find(
        (r) => r.method === 'POST' && r.url === '/api/session/ses_falsa/permission/per_1/reply',
      );
    const limite = Date.now() + 5_000;
    while (!acharRecusa() && Date.now() < limite) await new Promise((r) => setTimeout(r, 10));

    const recusa = acharRecusa();
    assert.equal((recusa?.body as Record<string, unknown> | undefined)?.['reply'], 'reject');
    assert.ok(!eventos.some((e) => e.type === 'approval.requested'));
    assert.ok(
      eventos.some((e) => e.type === 'log' && /recusado pelo Hub/.test(String(e.payload['text']))),
    );
  });

  test('o brief enviado não volta como evento (eco do prompt)', async () => {
    servidor.agentes = ['hub-semi'];
    servidor.aposPrompt = (sessionID) => [{ type: 'session.idle', data: { sessionID } }];
    const handle = await adapter.start(ctx('semi'), '# Tarefa\n\nBRIEF-SECRETO-DO-TESTE');
    const eventos = await drenar(handle.events);
    assert.ok(
      !eventos.some((e) => JSON.stringify(e.payload).includes('BRIEF-SECRETO-DO-TESTE')),
      `o prompt ecoado apareceu na timeline: ${JSON.stringify(eventos.map((e) => e.type))}`,
    );
  });
});

describe('OpenCode: config dos agentes hub-*', () => {
  test('supervised nega edição, shell, rede e subagente; semi/autonomous negam o irreversível', () => {
    const cfg = configDosAgentesDoHub() as {
      agent: Record<string, { permission: Record<string, unknown> }>;
    };
    const sup = cfg.agent['hub-supervised']!.permission;
    assert.equal(sup['*'], 'deny');
    for (const k of ['edit', 'bash', 'webfetch', 'task', 'question', 'external_directory']) {
      assert.equal(sup[k], 'deny', `supervised: ${k}`);
    }
    for (const nome of ['hub-semi', 'hub-autonomous']) {
      const p = cfg.agent[nome]!.permission;
      // `*` primeiro: "última regra que casa vence" no OpenCode.
      assert.equal(Object.keys(p)[0], '*');
      const bash = p['bash'] as Record<string, string>;
      assert.equal(Object.keys(bash)[0], '*');
      assert.equal(bash['*git push*'], 'deny');
      assert.equal(bash['*rm -rf*'], 'deny');
      assert.equal((p['read'] as Record<string, string>)['*.env'], 'deny');
    }
    assert.equal(cfg.agent['hub-semi']!.permission['task'], 'deny');
    assert.equal(cfg.agent['hub-autonomous']!.permission['task'], 'allow');
  });
});

// ---------------------------------------------------------------------------
// O servidor que o Hub sobe recebe OPENCODE_CONFIG_DIR com os agentes hub-*
// e o probe usa `--version` (não "servidor no ar" + authenticated:true).
// ---------------------------------------------------------------------------

const FAKE_SERVE = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.18.32'); process.exit(0); }
const port = Number(args[args.indexOf('--port') + 1]);
const streams = new Set();
http.createServer((req, res) => {
  if (req.url === '/api/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': hb\\n\\n');
    streams.add(res);
    res.on('close', () => streams.delete(res));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/api/session/ses_x/prompt') {
    res.end('{"data":{}}');
    setTimeout(() => {
      for (const s of streams) s.write('data: {"type":"session.idle","data":{"sessionID":"ses_x"}}\\n\\n');
    }, 20);
    return;
  }
  if (req.url === '/api/health') return res.end('{"healthy":true}');
  if (req.url === '/__config') {
    const dir = process.env.OPENCODE_CONFIG_DIR || null;
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8')); } catch {}
    return res.end(JSON.stringify({ dir, agents: cfg ? Object.keys(cfg.agent || {}) : [] }));
  }
  if (req.url === '/api/agent') return res.end('{"data":[{"id":"build"}]}');
  if (req.url === '/api/session') return res.end('{"data":{"id":"ses_x"}}');
  res.end('{}');
}).listen(port, '127.0.0.1');
`;

describe('OpenCode: servidor subido pelo Hub', () => {
  let dir: string;
  let pathAntes: string | undefined;
  const binName = 'opencode-fake-config-dir-test';

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hub-opencode-cfgdir-'));
    const script = path.join(dir, 'serve.cjs');
    writeFileSync(script, FAKE_SERVE, 'utf8');
    if (process.platform === 'win32') {
      writeFileSync(path.join(dir, `${binName}.cmd`), `@echo off\r\nnode "${script}" %*\r\n`, 'utf8');
    } else {
      const sh = path.join(dir, binName);
      writeFileSync(sh, `#!/bin/sh\nexec node "${script}" "$@"\n`, 'utf8');
      chmodSync(sh, 0o755);
    }
    pathAntes = process.env['PATH'];
    process.env['PATH'] = `${dir}${path.delimiter}${pathAntes ?? ''}`;
    clearBinCache();
  });
  after(() => {
    process.env['PATH'] = pathAntes;
    clearBinCache();
    rmSync(dir, { recursive: true, force: true });
  });

  test(
    'OPENCODE_CONFIG_DIR aponta para o opencode.json dos agentes hub-*',
    { timeout: 20_000 },
    async () => {
      const configDir = path.join(dir, 'cfg-do-hub');
      const m = AgentManifestSchema.parse({
        id: 'opencode',
        name: 'x',
        bin: binName,
        invoke: { oneShot: ['run'] },
      });
      const a = createOpenCodeAdapter(m, { port: 48931, configDir });
      try {
        const h = await a.start(ctx('semi'), 'oi');
        await drenar(h.events);
        await h.done;
        const r = (await fetch(`${a.baseUrl}/__config`).then((x) => x.json())) as {
          dir: string;
          agents: string[];
        };
        assert.equal(path.resolve(r.dir), path.resolve(configDir));
        assert.deepEqual(r.agents.sort(), ['hub-autonomous', 'hub-semi', 'hub-supervised']);
        assert.ok(
          readFileSync(path.join(configDir, 'opencode.json'), 'utf8').includes('hub-supervised'),
        );
      } finally {
        await a.close();
      }
    },
  );

  test(
    'probe devolve a versão do --version e não inventa autenticação',
    { timeout: 20_000 },
    async () => {
      const m = AgentManifestSchema.parse({
        id: 'opencode',
        name: 'x',
        bin: binName,
        detect: { args: ['--version'], versionRegex: '(\\d+\\.\\d+\\.\\d+)' },
        invoke: { oneShot: ['run'] },
      });
      const a = createOpenCodeAdapter(m, { port: 48932, configDir: path.join(dir, 'cfg2') });
      try {
        // Servidor no ar na porta: antes, isto bastava para "servidor no ar" + authenticated:true.
        const h = await a.start(ctx('semi'), 'oi');
        await drenar(h.events);
        await h.done;
        const p = await a.probe();
        assert.equal(p.installed, true);
        assert.equal(p.version, '1.18.32');
        assert.equal(p.authenticated, null);
      } finally {
        await a.close();
      }
    },
  );
});

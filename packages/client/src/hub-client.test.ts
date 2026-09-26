import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { HubApiError, HubClient } from './index.js';

/**
 * Contrato do `HubClient` contra um servidor HTTP falso (item 7.1 do GOAL: o
 * cliente usado por CLI, MCP e painel não tinha teste próprio). O daemon de
 * verdade é exercitado em outros pacotes; aqui cada resposta é escolhida a
 * dedo para medir o que o cliente faz com ela: erro estruturado, erro em
 * texto, HTML no lugar de JSON, corpo vazio, SSE — e o que ele manda: método,
 * caminho, query, corpo e token.
 */

interface Recebida {
  method: string;
  url: string;
  auth: string | undefined;
  contentType: string | undefined;
  body: string;
}

type Resposta = { status: number; body: string; headers?: Record<string, string> };

describe('HubClient contra servidor falso', () => {
  const recebidas: Recebida[] = [];
  let proxima: Resposta | ((req: IncomingMessage, res: ServerResponse) => void) = { status: 200, body: '{}' };
  let base = '';

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      recebidas.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      });
      if (typeof proxima === 'function') return proxima(req, res);
      res.writeHead(proxima.status, { 'Content-Type': 'application/json', ...(proxima.headers ?? {}) });
      res.end(proxima.body);
    });
  });

  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    recebidas.length = 0;
    proxima = { status: 200, body: '{}' };
  });

  async function erroDe(p: Promise<unknown>): Promise<HubApiError> {
    try {
      await p;
    } catch (err) {
      assert.ok(err instanceof HubApiError, `esperava HubApiError, veio ${String(err)}`);
      return err;
    }
    throw new Error('esperava rejeição');
  }

  test('barra final da base é removida; GET vai sem corpo e sem token', async () => {
    proxima = { status: 200, body: JSON.stringify({ ok: true }) };
    const r = await new HubClient(`${base}/`).health();
    assert.deepEqual(r, { ok: true });
    assert.equal(recebidas[0]?.method, 'GET');
    assert.equal(recebidas[0]?.url, '/health');
    assert.equal(recebidas[0]?.auth, undefined);
  });

  test('erro estruturado do daemon vira HubApiError com code, status e details preservados', async () => {
    proxima = {
      status: 422,
      body: JSON.stringify({
        error: { code: 'INVALID_BRIEF', message: 'Brief inválido', details: [{ path: 'objective' }] },
      }),
    };
    const e = await erroDe(new HubClient(base).startSession({ projectId: 'prj_1', brief: { agent: 'a', objective: 'o' } }));
    assert.equal(e.code, 'INVALID_BRIEF');
    assert.equal(e.status, 422);
    assert.equal(e.message, 'Brief inválido');
    assert.deepEqual(e.details, [{ path: 'objective' }]);
  });

  test('erro sem envelope: a mensagem é o corpo e o code é o status', async () => {
    proxima = { status: 503, body: JSON.stringify({ outra: 'coisa' }) };
    const e = await erroDe(new HubClient(base).projects());
    assert.equal(e.code, '503');
    assert.equal(e.status, 503);
    assert.match(e.message, /outra/);
  });

  test('HTML no lugar de JSON: erro que aponta a causa, com o começo da resposta resumido', async () => {
    const html = `<!doctype html>\n<html>${'x'.repeat(500)}</html>`;
    proxima = { status: 200, body: html, headers: { 'Content-Type': 'text/html' } };
    const e = await erroDe(new HubClient(base).health());
    assert.equal(e.code, 'RESPOSTA_NAO_JSON');
    assert.equal(e.status, 200);
    assert.match(e.message, /não é JSON \(HTTP 200\)/);
    assert.match(e.message, /<!doctype html> <html>/, 'quebras de linha viram espaço');
    assert.ok(e.message.endsWith('…'), 'resposta longa é truncada');
  });

  test('corpo vazio com 2xx vira objeto vazio (não estoura no JSON.parse)', async () => {
    proxima = { status: 200, body: '' };
    assert.deepEqual(await new HubClient(base).pause('ses_abc'), {});
  });

  test('id malformado rejeita a promessa SEM fazer requisição', async () => {
    const c = new HubClient(base);
    await assert.rejects(c.session('../../shutdown'));
    await assert.rejects(c.cancel('tsk_errado'));
    await assert.rejects(c.approval(''));
    assert.equal(recebidas.length, 0);
  });

  test('POST leva JSON e o token; token como função lida a cada chamada; null não manda nada', async () => {
    let token: string | undefined = 't1';
    const c = new HubClient(base, { token: () => token });
    await c.cancel('ses_abc', 'motivo');
    token = undefined;
    await c.cancel('ses_abc');
    await new HubClient(base, { token: null }).approvals();

    assert.equal(recebidas[0]?.method, 'POST');
    assert.equal(recebidas[0]?.url, '/sessions/ses_abc/cancel');
    assert.equal(recebidas[0]?.contentType, 'application/json');
    assert.equal(recebidas[0]?.auth, 'Bearer t1');
    assert.deepEqual(JSON.parse(recebidas[0]!.body), { reason: 'motivo' });
    assert.equal(recebidas[1]?.auth, undefined);
    assert.equal(recebidas[2]?.auth, undefined);
  });

  test('query: vazios são omitidos; tail vira 1; ids de filtro são validados', async () => {
    const c = new HubClient(base);
    await c.sessions();
    await c.sessions({ projectId: 'prj_1', rootId: undefined });
    await c.events('ses_1', { since: 5, tail: true });
    await c.events('ses_1', { tail: false });
    await c.discovery(true);
    await c.policy('prj_9');
    assert.deepEqual(
      recebidas.map((r) => r.url),
      [
        '/sessions',
        '/sessions?projectId=prj_1',
        '/sessions/ses_1/events?since=5&tail=1',
        '/sessions/ses_1/events',
        '/discovery?refresh=1',
        '/policy?projectId=prj_9',
      ],
    );
    await assert.rejects(c.audit({ sessionId: 'nao-e-id' }));
    assert.equal(recebidas.length, 6);
  });

  test('DELETE sem corpo e PUT com corpo', async () => {
    const c = new HubClient(base, { token: 'tk' });
    await c.removeFolder('prj_1', 'pfd_2');
    await c.saveProjectContext('prj_1', { memory: 'm' });
    assert.equal(recebidas[0]?.method, 'DELETE');
    assert.equal(recebidas[0]?.url, '/projects/prj_1/folders/pfd_2');
    assert.equal(recebidas[0]?.body, '');
    assert.equal(recebidas[1]?.method, 'PUT');
    assert.deepEqual(JSON.parse(recebidas[1]!.body), { memory: 'm' });
    assert.equal(recebidas[1]?.auth, 'Bearer tk');
  });

  test('stream(): entrega um evento por frame, ignora keep-alive e frame malformado', async () => {
    proxima = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': keep-alive\n\n');
      res.write('id: 1\ndata: {"seq":1}\n\n');
      // Um frame partido em dois pedaços de rede.
      res.write('data: {"se');
      res.write('q":2}\n\n');
      res.write('data: {quebrado\n\n');
      res.end('data: {"seq":3}\n\n');
    };
    const c = new HubClient(base);
    const vistos: unknown[] = [];
    for await (const ev of c.stream({ sessionId: 'ses_1', since: 0 })) vistos.push(ev);
    assert.deepEqual(vistos, [{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    assert.equal(recebidas[0]?.url, '/events?sessionId=ses_1&since=0');
    assert.equal(c.streamUrl({}), `${base}/events`);
  });

  test('stream(): HTTP de erro vira exceção com o status', async () => {
    proxima = { status: 429, body: '{}' };
    const gen = new HubClient(base).stream();
    await assert.rejects(gen.next(), /HTTP 429/);
  });
});

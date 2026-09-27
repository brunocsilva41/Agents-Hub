import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createHub, type Hub } from './hub.js';
import { operatorTokenPath } from './operator-auth.js';

/**
 * Toda rota `operator: true` exige o token — provado pela TABELA de rotas do
 * servidor, não por uma lista mantida à mão no teste (uma rota protegida nova
 * entra aqui sozinha).
 *
 * O token é semeado terminando em `0` de propósito. `operator-auth.test`
 * montava o "token quase certo" como `token.slice(0, 63) + '0'`; quando o
 * token sorteado já terminava em `0` (1 em 16 subidas) o "errado" era o
 * certo, e as rotas protegidas "respondiam sem token" — inclusive
 * `POST /shutdown` com 200, derrubando o processo de teste. Com o token fixo,
 * essa classe de erro fica vermelha SEMPRE, não 1 vez em 16.
 */

const TOKEN_SEMEADO = `${'c'.repeat(63)}0`;

/** O token certo com o último caractere trocado por outro dígito hex. */
function quaseOToken(token: string): string {
  const ultimo = token.slice(-1);
  return `${token.slice(0, -1)}${ultimo === '0' ? '1' : '0'}`;
}

interface Resposta {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe('tabela de rotas: toda rota de operador exige o token', () => {
  let raiz: string;
  let hub: Hub;
  let porta = 0;

  function http(
    method: string,
    caminho: string,
    headers: Record<string, string> = {},
  ): Promise<Resposta> {
    return new Promise((resolve, reject) => {
      const h: Record<string, string> = { host: `127.0.0.1:${porta}`, ...headers };
      const corpo = method === 'POST' || method === 'PUT' ? Buffer.from('{}') : undefined;
      if (corpo !== undefined) {
        h['content-type'] = 'application/json';
        h['content-length'] = String(corpo.length);
      }
      const req = request(
        { host: '127.0.0.1', port: porta, method, path: caminho, headers: h },
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
      req.on('error', reject);
      if (corpo !== undefined) req.write(corpo);
      req.end();
    });
  }

  /** `/projects/:id/folders/:folderId` -> `/projects/x/folders/x`: a auth vem antes de validar parâmetro. */
  const concreto = (padrao: string): string => padrao.replace(/:\w+/g, 'x');

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-rotas-operador-'));
    const home = path.join(raiz, 'home');
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(home, { recursive: true });
    mkdirSync(manifestos, { recursive: true });
    // O daemon reaproveita um token existente bem formado.
    writeFileSync(operatorTokenPath(home), `${TOKEN_SEMEADO}\n`, 'utf8');
    hub = createHub({ home, manifestsDir: manifestos, port: 0 });
    porta = (await hub.start()).port;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  test('o hub usa o token semeado (terminado em 0) e a tabela tem as rotas protegidas conhecidas', () => {
    assert.equal(hub.operatorToken, TOKEN_SEMEADO);
    const protegidas = hub.server
      .routeTable()
      .filter((r) => r.operator)
      .map((r) => `${r.method} ${r.path}`);
    for (const esperada of [
      'POST /approvals/:id',
      'POST /shutdown',
      'PUT /projects/:id/context',
      'POST /projects/:id/trust',
      'POST /projects/:id/import',
      'POST /projects/:id/folders',
      'DELETE /projects/:id/folders/:folderId',
      'POST /maintenance/sweep',
      'PUT /policy',
      'PUT /projects/:id/policy',
    ]) {
      assert.ok(
        protegidas.some((p) => p.replace(/:\w+/g, ':') === esperada.replace(/:\w+/g, ':')),
        `${esperada} deveria estar protegida; protegidas: ${protegidas.join(', ')}`,
      );
    }
  });

  test('não existem duas rotas com o mesmo método e padrão', () => {
    const vistos = new Map<string, string>();
    for (const r of hub.server.routeTable()) {
      // Nome do parâmetro não importa para o casamento: `/a/:id` e `/a/:x` são a mesma rota.
      const chave = `${r.method} ${r.path.replace(/:\w+/g, ':')}`;
      assert.ok(
        !vistos.has(chave),
        `rota duplicada: ${r.method} ${r.path} (já registrada como ${vistos.get(chave)})`,
      );
      vistos.set(chave, `${r.method} ${r.path}`);
    }
  });

  test('nenhuma rota de operador é sombreada por uma rota aberta registrada antes', () => {
    const tabela = hub.server.routeTable();
    for (const [i, r] of tabela.entries()) {
      if (!r.operator) continue;
      const url = concreto(r.path);
      const primeira = tabela.findIndex(
        (o) => o.method === r.method && new RegExp(`^${o.path.replace(/:\w+/g, '[^/]+')}$`).test(url),
      );
      assert.equal(
        primeira,
        i,
        `${r.method} ${url} casa antes com ${tabela[primeira]?.method} ${tabela[primeira]?.path}`,
      );
    }
  });

  test('toda rota de operador: sem token e com token quase certo (Bearer, X-Hub-Token, cookie) -> 401', async () => {
    const quase = quaseOToken(hub.operatorToken);
    assert.notEqual(quase, hub.operatorToken);
    // `/shutdown` por último: se ele "passar", o processo cai e o resto nem roda.
    const rotas = hub.server
      .routeTable()
      .filter((r) => r.operator)
      .sort((a, b) => Number(a.path === '/shutdown') - Number(b.path === '/shutdown'));
    assert.ok(rotas.length >= 10, `rotas de operador: ${rotas.length}`);

    for (const r of rotas) {
      const url = concreto(r.path);
      const tentativas: Array<[string, Record<string, string>]> = [
        ['sem token', {}],
        ['Bearer quase certo', { authorization: `Bearer ${quase}` }],
        ['X-Hub-Token quase certo', { 'x-hub-token': quase }],
        ['cookie quase certo', { cookie: `hub_operator=${quase}` }],
        ['Bearer vazio', { authorization: 'Bearer ' }],
      ];
      for (const [nome, headers] of tentativas) {
        const res = await http(r.method, url, headers);
        assert.equal(res.status, 401, `${r.method} ${url} (${nome}): ${res.body}`);
        assert.match(res.body, /UNAUTHORIZED/);
        assert.match(String(res.headers['www-authenticate']), /Bearer/);
      }
    }
  });

  test('controle: com o token certo a mesma requisição passa da autenticação', async () => {
    const res = await http('POST', '/approvals/apv_inexistente', {
      authorization: `Bearer ${hub.operatorToken}`,
    });
    assert.notEqual(res.status, 401, res.body);
    assert.notEqual(res.status, 403, res.body);
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newId } from '@agents-hub/core';
import { baseUrl } from './config.js';
import { createHub, type Hub } from './hub.js';

/**
 * Item 7.3 do GOAL (testes frágeis): os testes escolhiam porta com
 * `portaLivre()` — abrir a porta 0, ler o número, FECHAR e só então o daemon
 * tentar ligar a mesma porta. Entre o `close` e o `listen` qualquer processo
 * da máquina podia pegá-la (o daemon falhava no `listen`, ou o teste falava
 * com o servidor de OUTRO teste). Obs.: os 200/400 intermitentes de
 * `operator-auth.test` nas rotas protegidas NÃO eram isto — eram o próprio
 * teste mandando o token certo como "errado" (ver `operator-routes-table.test`).
 *
 * A correção é o daemon aceitar `port: 0` de verdade: o SO escolhe e liga a
 * porta num passo só, e `listen()` devolve a porta real e a grava na config —
 * a guarda de borda compara `Host`/`Origin` contra `config.port`, então com
 * `0` ali ela recusaria (403) toda requisição legítima.
 */
describe('HubServer com port: 0 — a porta real vem do bind, não de palpite', () => {
  let raiz: string;
  let a: Hub;
  let b: Hub;
  let portaA: number;
  let portaB: number;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-porta-zero-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    a = createHub({ home: path.join(raiz, 'a'), manifestsDir: manifestos, port: 0 });
    b = createHub({ home: path.join(raiz, 'b'), manifestsDir: manifestos, port: 0 });
    // Simultâneos de propósito: dois binds em paralelo não podem colidir.
    [portaA, portaB] = (await Promise.all([a.start(), b.start()])).map((e) => e.port) as [
      number,
      number,
    ];
  });

  after(async () => {
    await Promise.all([a.shutdown(), b.shutdown()]);
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  test('cada Hub recebe uma porta real, distinta, e a config passa a refleti-la', () => {
    assert.ok(portaA > 0 && portaB > 0, `portas reais esperadas, veio ${portaA}/${portaB}`);
    assert.notEqual(portaA, portaB);
    assert.equal(a.config.port, portaA);
    assert.equal(b.config.port, portaB);
  });

  test('a guarda de borda aceita o Host com a porta real, e cada porta é do Hub certo', async () => {
    // Um projeto só em A: se a porta de B levasse a A (ou vice-versa), a
    // listagem denunciaria.
    const projeto = path.join(raiz, 'projeto-de-a');
    mkdirSync(projeto, { recursive: true });
    const idDeA = a.sessions.registerProject(projeto, 'so-em-a').id;

    const ids = async (hub: Hub): Promise<string[]> => {
      const res = await fetch(`${baseUrl(hub.config)}/projects`);
      assert.equal(res.status, 200, `porta ${hub.config.port}`);
      return ((await res.json()) as { projects: Array<{ id: string }> }).projects.map((p) => p.id);
    };
    assert.ok((await ids(a)).includes(idDeA));
    assert.ok(!(await ids(b)).includes(idDeA));
  });

  test('rota protegida: cada Hub aceita só o PRÓPRIO token', async () => {
    const decidir = (porta: number, token?: string) =>
      fetch(`http://127.0.0.1:${porta}/approvals/${newId('apv')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ decision: 'approved' }),
      });

    assert.notEqual(a.operatorToken, b.operatorToken);

    assert.equal((await decidir(portaA)).status, 401, 'A sem token');
    assert.equal((await decidir(portaB)).status, 401, 'B sem token');
    assert.equal((await decidir(portaA, b.operatorToken)).status, 401, 'A com o token de B');
    assert.equal((await decidir(portaB, a.operatorToken)).status, 401, 'B com o token de A');

    // Com o próprio token passa da autenticação e da guarda (a aprovação não
    // existe, então o status é de "não achei", não de "quem é você").
    for (const [porta, token] of [
      [portaA, a.operatorToken],
      [portaB, b.operatorToken],
    ] as const) {
      const status = (await decidir(porta, token)).status;
      assert.ok(
        status !== 401 && status !== 403 && status < 500,
        `porta ${porta} com o próprio token: ${status}`,
      );
    }
  });
});

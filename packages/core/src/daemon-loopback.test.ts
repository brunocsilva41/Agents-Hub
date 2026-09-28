import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULT_POLICY, PolicyEngine, type PolicyContext, type RiskLevel } from './policy.js';

/**
 * R05-03 (vistoria 05, reaberto ALTO): qualquer processo local obtém o cookie
 * com o token de operador forjando `Sec-Fetch-*` num `GET /` do daemon — e
 * não existe cabeçalho que distinga navegador de `curl`. Uma das camadas que
 * sobram é o GATE: requisição HTTP ao PRÓPRIO daemon é tratada como leitura
 * do token (`irreversible`), igual a ler o arquivo `operator-token`.
 *
 * Critério (documentado em `alvoDoDaemon`):
 * - host loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`,
 *   `::ffff:127.x`, `0.0.0.0`) E porta efetiva (explícita ou padrão do
 *   esquema) entre as portas do daemon → `irreversible`, e `allowDomains` NÃO
 *   libera (liberar `localhost` para um servidor de dev não pode liberar o Hub);
 * - loopback em OUTRA porta segue a regra de rede de sempre (escalate, ou
 *   exec se o domínio estiver liberado) — `curl localhost:3000` do projeto
 *   continua possível;
 * - o classificador sem contexto usa a porta padrão (4747).
 */

const workdir = path.resolve('/tmp/hub/worktree');
const ctx = (extra: Partial<PolicyContext> = {}): PolicyContext => ({
  workdir,
  mode: 'semi',
  hubPorts: [4747],
  ...extra,
});
const engine = new PolicyEngine();
const liberaLocalhost = new PolicyEngine({
  ...DEFAULT_POLICY,
  network: { allowDomains: ['localhost', '127.0.0.1'] },
});

function risco(command: string, e = engine, c = ctx()): RiskLevel {
  return e.classify({ kind: 'command', command }, c).risk;
}

const FORJADO =
  'curl -s -i -H "Sec-Fetch-Dest: document" -H "Sec-Fetch-Mode: navigate" ' +
  '-H "Sec-Fetch-Site: none" http://127.0.0.1:4747/';

describe('R05-03: requisição HTTP ao daemon do Hub é leitura do token', () => {
  const AO_DAEMON = [
    FORJADO,
    'curl http://127.0.0.1:4747/',
    'curl 127.0.0.1:4747',
    'curl localhost:4747/approvals',
    'curl http://localhost:4747/approvals/apv_1 -X POST',
    'curl "http://[::1]:4747/"',
    'curl http://127.1:4747/',
    'curl http://0x7f000001:4747/',
    'curl http://app.localhost:4747/',
    'curl http://0.0.0.0:4747/',
    'wget -qO- http://127.0.0.1:4747/',
    'Invoke-WebRequest -Uri http://127.0.0.1:4747/ -Headers @{"Sec-Fetch-Dest"="document"}',
    'iwr http://localhost:4747',
    'Invoke-RestMethod http://127.0.0.1:4747/approvals',
    'bash -c "curl http://127.0.0.1:4747/"',
    'node -e "fetch(\'http://127.0.0.1:4747/\').then(r=>r.headers)"',
    'python -c "import urllib.request; urllib.request.urlopen(\'http://localhost:4747/\')"',
  ];
  for (const cmd of AO_DAEMON) {
    test(`irreversible: ${cmd}`, () => {
      assert.equal(risco(cmd), 'irreversible');
    });
  }

  test('allowDomains com localhost/127.0.0.1 NÃO libera a porta do daemon', () => {
    assert.equal(risco(FORJADO, liberaLocalhost), 'irreversible');
    assert.equal(risco('curl http://localhost:4747/', liberaLocalhost), 'irreversible');
  });

  test('porta real do daemon vem do contexto (porta 0 nos testes, config.port em produção)', () => {
    const c = ctx({ hubPorts: [51234] });
    assert.equal(risco('curl http://127.0.0.1:51234/', engine, c), 'irreversible');
    // Com a porta real conhecida, 4747 é só mais uma porta local.
    assert.equal(risco('curl http://127.0.0.1:4747/', liberaLocalhost, c), 'exec');
  });

  test('sem contexto de porta, vale a padrão (4747)', () => {
    const semPorta: PolicyContext = { workdir, mode: 'semi' };
    assert.equal(risco('curl http://127.0.0.1:4747/', engine, semPorta), 'irreversible');
  });

  test('loopback em OUTRA porta segue a regra de rede (não trava servidor de dev)', () => {
    assert.equal(risco('curl http://localhost:3000/'), 'escalate');
    assert.equal(risco('curl http://localhost:3000/', liberaLocalhost), 'exec');
    assert.equal(risco('curl http://127.0.0.1:5173/api', liberaLocalhost), 'exec');
  });

  test('host remoto na mesma porta não é o daemon', () => {
    assert.equal(risco('curl http://example.com:4747/'), 'escalate');
  });

  test('WebFetch (ação network) ao daemon também é irreversible', () => {
    const r = engine.classify({ kind: 'network', url: 'http://127.0.0.1:4747/' }, ctx());
    assert.equal(r.risk, 'irreversible');
    const l = liberaLocalhost.classify({ kind: 'network', url: 'http://localhost:4747/x' }, ctx());
    assert.equal(l.risk, 'irreversible');
    const dev = liberaLocalhost.classify({ kind: 'network', url: 'http://localhost:3000/' }, ctx());
    assert.equal(dev.risk, 'read');
  });

  test('autonomous também para: irreversible pede aprovação em todo modo', () => {
    const d = engine.decide({ kind: 'command', command: FORJADO }, ctx({ mode: 'autonomous' }));
    assert.equal(d.decision, 'approve');
  });
});

describe('R05-03: comandos de operador da CLI do Hub rodados pelo agente', () => {
  // A CLI lê `operator-token` sozinha: `hub approve` pelo agente é
  // autoaprovação sem passar pelo `Read` do arquivo.
  const OPERADOR = [
    'hub approve apv_123',
    'hub deny apv_123',
    'hub.cmd approve apv_123',
    'npx hub approve apv_123',
    'hub policy set maxDepth 9',
    'hub policy mode irreversible allow',
    'hub policy allow add rm',
    'hub project trust',
    'hub stop',
    'hub restart',
    'hub hooks uninstall claude',
  ];
  for (const cmd of OPERADOR) {
    test(`irreversible: ${cmd}`, () => {
      assert.equal(risco(cmd), 'irreversible');
    });
  }

  test('consulta da CLI não é afetada', () => {
    assert.notEqual(risco('hub approvals'), 'irreversible');
    assert.notEqual(risco('hub policy show'), 'irreversible');
    assert.notEqual(risco('hub policy'), 'irreversible');
    assert.notEqual(risco('hub status'), 'irreversible');
  });
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * R02-10: o MCP server lia `process.env` cru. `AGENTS_HUB_MCP_GRACE_MS=abc`
 * virava `NaN`, `grace > 0` dava falso e a carência de saída sumia em
 * silêncio (o processo saía com 0 como se nada estivesse errado). Agora passa
 * pelo mesmo `readHubEnv` do daemon e da CLI e recusa com a mensagem.
 */

const MAIN = fileURLToPath(new URL('./main.js', import.meta.url));

function rodar(env: Record<string, string>) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('AGENTS_HUB_')) delete base[k];
  // stdin vazio: o server conecta e o fim do stdin encerra a sessão MCP.
  return spawnSync(process.execPath, [MAIN], {
    env: { ...base, AGENTS_HUB_URL: 'http://127.0.0.1:1', ...env },
    input: '',
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('MCP server — variáveis de ambiente', () => {
  test('AGENTS_HUB_MCP_GRACE_MS=abc é recusada com o nome da variável', () => {
    const r = rodar({ AGENTS_HUB_MCP_GRACE_MS: 'abc' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /AGENTS_HUB_MCP_GRACE_MS/);
    assert.equal(r.stdout, '', 'stdout é do JSON-RPC: nada de diagnóstico ali');
  });

  test('AGENTS_HUB_URL que não é URL é recusada', () => {
    const r = rodar({ AGENTS_HUB_URL: 'nao-e-url' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /AGENTS_HUB_URL/);
  });

  test('valores válidos: conecta e sai limpo quando o stdin fecha', () => {
    const r = rodar({ AGENTS_HUB_MCP_GRACE_MS: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /agents-hub mcp conectado/);
  });
});

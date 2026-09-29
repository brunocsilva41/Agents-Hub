import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * R02-10 (resíduo): o intervalo do sinal de vida era lido com `Number()` cru
 * e o inválido voltava ao padrão em silêncio. O MCP server agora o recusa como
 * recusa `AGENTS_HUB_MCP_GRACE_MS`: sai com 1 e o nome da variável no stderr.
 */

const MAIN = fileURLToPath(new URL('./main.js', import.meta.url));

function rodar(env: Record<string, string>) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('AGENTS_HUB_')) delete base[k];
  // stdin vazio: o server conecta e o fim do stdin encerra a sessão MCP.
  return spawnSync(process.execPath, [MAIN], {
    env: { ...base, AGENTS_HUB_URL: 'http://127.0.0.1:1', AGENTS_HUB_MCP_GRACE_MS: '0', ...env },
    input: '',
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('MCP server — AGENTS_HUB_MCP_HEARTBEAT_MS', () => {
  test('valor inválido é recusado com o nome da variável, sem sujar o stdout', () => {
    const r = rodar({ AGENTS_HUB_MCP_HEARTBEAT_MS: 'abc' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /AGENTS_HUB_MCP_HEARTBEAT_MS/);
    assert.equal(r.stdout, '', 'stdout é do JSON-RPC: nada de diagnóstico ali');
  });

  test('valor válido: conecta e sai limpo quando o stdin fecha', () => {
    const r = rodar({ AGENTS_HUB_MCP_HEARTBEAT_MS: '1000' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /agents-hub mcp conectado/);
  });
});

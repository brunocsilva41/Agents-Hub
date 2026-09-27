import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_ROUTES, passaPeloProxy, ROTAS_FORA_DO_PROXY } from './api-routes.js';

// Compilado em packages/web/dist-test/logic/ — três níveis acima é packages/.
const pacotes = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('proxy do Vite em desenvolvimento', () => {
  test('/discovery é repassado (aba "Agentes detectados" no npm run dev)', () => {
    assert.ok(passaPeloProxy('/discovery'));
    assert.ok(passaPeloProxy('/discovery/claude?refresh=1'));
  });

  test('rotas perigosas continuam fora do proxy', () => {
    for (const rota of ['/shutdown', '/maintenance/sweep', '/hooks/pretooluse', '/api/tasks']) {
      assert.equal(passaPeloProxy(rota), false, rota);
    }
  });

  test('o vite.config usa esta lista (e não uma cópia que envelhece)', () => {
    const config = readFileSync(path.join(pacotes, 'web', 'vite.config.ts'), 'utf8');
    assert.match(config, /from '\.\/src\/logic\/api-routes'/);
    assert.doesNotMatch(config, /const API_ROUTES\s*=/);
  });

  test('toda rota que o HubClient chama está no proxy ou excluída de propósito', () => {
    // Pega a rota nova que alguém adicionar ao cliente sem lembrar do Vite —
    // foi exatamente assim que `/discovery` ficou de fora.
    const fonte = readFileSync(path.join(pacotes, 'client', 'src', 'index.ts'), 'utf8');
    const segmentos = new Set([...fonte.matchAll(/\(\s*[`'"](\/[a-z-]+)/g)].map((m) => m[1] as string));
    assert.ok(segmentos.size > 5, 'o varredor achou as rotas do cliente');
    for (const s of segmentos) {
      assert.ok(
        API_ROUTES.includes(s) || ROTAS_FORA_DO_PROXY.includes(s),
        `rota ${s} do HubClient não está no proxy do Vite nem na lista de exclusões`,
      );
    }
  });
});

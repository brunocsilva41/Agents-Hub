import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openCommand } from './open-cmd.js';
import { capturar } from './test-kit.js';

describe('hub open', () => {
  const url = 'http://127.0.0.1:4999';

  test('abre a URL do painel com o abridor (injetado — nenhum navegador de verdade)', async () => {
    const abertas: string[] = [];
    const { out } = await capturar(() =>
      openCommand(url, { command: 'open', positional: [], flags: {} }, async (u) => {
        abertas.push(u);
      }),
    );
    assert.deepEqual(abertas, [url]);
    assert.ok(out.some((l) => l.includes('painel aberto') && l.includes(url)));
  });

  test('--print só imprime a URL, sem abrir nada', async () => {
    let chamado = false;
    const { out } = await capturar(() =>
      openCommand(url, { command: 'open', positional: [], flags: { print: true } }, async () => {
        chamado = true;
      }),
    );
    assert.equal(chamado, false);
    assert.deepEqual(out, [url]);
  });

  test('sem navegador, cai para a URL impressa em vez de falhar', async () => {
    const { out } = await capturar(() =>
      openCommand(url, { command: 'open', positional: [], flags: {} }, async () => {
        throw new Error('spawn xdg-open ENOENT');
      }),
    );
    assert.ok(out.some((l) => l.includes('não consegui abrir')));
    assert.ok(out.some((l) => l.includes(url)));
  });
});

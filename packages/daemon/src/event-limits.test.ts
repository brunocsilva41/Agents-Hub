import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EventEnvelope } from '@agents-hub/core';
import { LIMITES_DE_EVENTO, TetoDeSaida, limitarEvento, limitarPagina } from './event-limits.js';

/** Tetos de evento, de sessão e de página (vistoria 2026-09-25, item 2.5). */
describe('event-limits', () => {
  test('evento pequeno passa intacto', () => {
    const r = limitarEvento({ payload: { text: 'oi', n: 1 }, raw: { a: 1 } });
    assert.equal(r.truncado, false);
    assert.deepEqual(r.payload, { text: 'oi', n: 1 });
    assert.deepEqual(r.raw, { a: 1 });
  });

  test('string longa no payload e raw grande são cortados com a marca', () => {
    const r = limitarEvento({
      payload: { content: 'a'.repeat(100_000), aninhado: { texto: 'b'.repeat(50_000) } },
      raw: { bloco: 'c'.repeat(5 * 1024 * 1024) },
    });
    assert.equal(r.truncado, true);
    assert.match(String(r.payload['content']), /\[truncado \d+ bytes\]$/);
    assert.ok(String(r.payload['content']).length <= LIMITES_DE_EVENTO.textoMax + 40);
    assert.match(String((r.payload['aninhado'] as Record<string, unknown>)['texto']), /\[truncado/);
    assert.equal(typeof r.raw, 'string');
    assert.ok(Buffer.byteLength(r.raw as string) < LIMITES_DE_EVENTO.rawMax + 64);
    assert.equal(r.payload['truncated'], true);
    assert.ok(r.bytes < 256 * 1024);
  });

  test('payload com muitos campos médios cabe no teto total', () => {
    const payload: Record<string, unknown> = { tipo: 'x' };
    for (let i = 0; i < 100; i += 1) payload[`c${i}`] = 'd'.repeat(10_000);
    const r = limitarEvento({ payload, raw: null });
    assert.ok(r.bytes <= LIMITES_DE_EVENTO.payloadMax + 1024, `${r.bytes} bytes`);
    assert.equal(r.payload['tipo'], 'x');
  });

  test('teto por sessão: passado o limite, log deixa de ser gravado e o aviso sai uma vez', () => {
    const teto = new TetoDeSaida({ bytesMax: 1000, eventosMax: 1_000_000, textoEconomico: 10 });
    const avisos: string[] = [];
    let gravados = 0;
    let descartados = 0;
    for (let i = 0; i < 50; i += 1) {
      const { evento, aviso } = teto.admitir('ses_1', { type: 'log', payload: { text: 'x'.repeat(100) }, raw: null });
      if (aviso) avisos.push(aviso);
      if (evento) gravados += 1;
      else descartados += 1;
    }
    assert.ok(gravados < 50 && descartados > 0);
    assert.equal(avisos.length, 1);

    const { evento } = teto.admitir('ses_1', {
      type: 'message',
      payload: { text: 'mensagem importante e longa' },
      raw: { bruto: true },
    });
    assert.ok(evento, 'eventos que não são log continuam na timeline');
    assert.equal(evento.raw, null);
    assert.match(String(evento.payload['text']), /^mensagem i \[truncado/);

    // Outra sessão não é afetada.
    assert.ok(teto.admitir('ses_2', { type: 'log', payload: { text: 'oi' }, raw: null }).evento);
  });

  test('página: contagem preservada, eventos antigos gigantes cortados, orçamento de bytes', () => {
    const eventos: EventEnvelope[] = Array.from({ length: 20 }, (_, i) => ({
      id: `evt_${i}`,
      seq: i + 1,
      ts: '2020-01-01T00:00:00.000Z',
      sessionId: 'ses_1',
      taskId: null,
      agentId: 'x',
      type: 'log',
      payload: { text: 'e'.repeat(1_000_000) },
      cost: null,
      raw: 'r'.repeat(1_000_000),
    }));
    const pagina = limitarPagina(eventos, 200 * 1024);
    assert.equal(pagina.length, 20);
    const bytes = Buffer.byteLength(JSON.stringify(pagina));
    assert.ok(bytes < 1024 * 1024, `${bytes} bytes`);
    assert.ok(pagina.every((e) => String(e.payload['text']).includes('[truncado')));
  });
});

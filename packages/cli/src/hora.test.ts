import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EventEnvelope } from '@agents-hub/core';
import { dataHoraLocal, horaLocal, rotuloDoFuso } from './hora.js';
import { renderEvent } from './render.js';

/**
 * Vistoria 07, R07-18: relógio local 01:10 (UTC-3) aparecia como `04:10:03`
 * em `hub approvals`/`sessions`/`watch`, sem rótulo. `offsetMin` explícito
 * deixa o teste igual em qualquer fuso da máquina que o roda.
 */

const ISO = '2026-09-25T04:10:03.000Z';
const BRASILIA = 180; // getTimezoneOffset de UTC-3

describe('hora local nos comandos', () => {
  test('horaLocal converte para o fuso (não recorta a string UTC)', () => {
    assert.equal(horaLocal(ISO, BRASILIA), '01:10:03');
    assert.equal(horaLocal(ISO, 0), '04:10:03');
    assert.equal(horaLocal(ISO, -330), '09:40:03');
  });

  test('dataHoraLocal: data vira no fuso e o rótulo vai junto', () => {
    assert.equal(dataHoraLocal('2026-09-25T01:00:00.000Z', BRASILIA), '2026-09-24 22:00:00 UTC-3');
    assert.equal(dataHoraLocal(ISO, 0), '2026-09-25 04:10:03 UTC');
    assert.equal(dataHoraLocal(ISO, -330), '2026-09-25 09:40:03 UTC+5:30');
  });

  test('rotuloDoFuso', () => {
    assert.equal(rotuloDoFuso(180), 'UTC-3');
    assert.equal(rotuloDoFuso(-60), 'UTC+1');
    assert.equal(rotuloDoFuso(0), 'UTC');
  });

  test('texto que não é data volta como veio (não vira "NaN:NaN")', () => {
    assert.equal(horaLocal('?'), '?');
    assert.equal(dataHoraLocal(''), '');
  });

  test('a linha de evento do watch usa a hora local da máquina', () => {
    const evento = {
      ts: ISO,
      agentId: 'claude',
      type: 'session.started',
      payload: {},
    } as unknown as EventEnvelope;
    const linha = renderEvent(evento).replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
    assert.ok(linha.startsWith(horaLocal(ISO)), linha);
  });
});

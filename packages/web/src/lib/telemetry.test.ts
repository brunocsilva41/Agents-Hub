import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isLiveState } from './sessionControls.js';
import {
  achatarGrafo,
  custoNoTempo,
  custoPorAgente,
  fluxosDoPeriodo,
  resumoDeSessoes,
  type NoDeCusto,
} from './telemetry.js';

const AGORA = Date.parse('2026-09-26T12:00:00Z');
const ha = (horas: number): string => new Date(AGORA - horas * 3_600_000).toISOString();

describe('telemetria com as definições do resto do painel (R03-27)', () => {
  const sessoes = [
    { state: 'running', createdAt: ha(1) },
    { state: 'paused', createdAt: ha(2) },
    { state: 'idle', createdAt: ha(3) },
    { state: 'waiting_approval', createdAt: ha(4) },
    { state: 'completed', createdAt: ha(5) },
    { state: 'failed', createdAt: ha(6) },
    { state: 'killed', createdAt: ha(7) },
    { state: 'completed', createdAt: ha(24 * 10) },
  ];

  test('"ao vivo" é a mesma conta da pílula do topo (isLiveState, inclui pausada/ociosa)', () => {
    const r = resumoDeSessoes(sessoes, 'tudo', AGORA);
    assert.equal(r.aoVivo, sessoes.filter((s) => isLiveState(s.state)).length);
    assert.equal(r.aoVivo, 4);
  });

  test('taxa de conclusão sobre as TERMINADAS; sem terminadas não há taxa', () => {
    const r = resumoDeSessoes(sessoes, '24h', AGORA);
    assert.equal(r.total, 7);
    assert.equal(r.terminadas, 3);
    assert.equal(r.concluidas, 1);
    assert.equal(r.falharam, 1);
    assert.equal(r.encerradas, 1);
    assert.equal(r.taxaDeConclusao, 1 / 3);
    assert.equal(
      resumoDeSessoes([{ state: 'running', createdAt: ha(1) }], 'tudo', AGORA).taxaDeConclusao,
      null,
    );
    assert.equal(resumoDeSessoes([], 'tudo', AGORA).taxaDeConclusao, null);
  });

  test('período filtra pelo começo da sessão; "ao vivo" não depende do período', () => {
    const r = resumoDeSessoes(sessoes, '24h', AGORA);
    assert.equal(r.total, 7);
    assert.equal(resumoDeSessoes(sessoes, '30d', AGORA).total, 8);
    assert.equal(
      resumoDeSessoes([{ state: 'running', createdAt: ha(24 * 40) }], '24h', AGORA).aoVivo,
      1,
    );
  });

  const no = (
    id: string,
    agentId: string,
    usd: number,
    tokens: number,
    horas: number,
    filhos: NoDeCusto[] = [],
  ): NoDeCusto => ({
    sessionId: id,
    agentId,
    usd,
    tokens,
    startedAt: ha(horas),
    children: filhos,
  });
  const grafo = [
    no('r1', 'claude', 1, 1000, 2, [no('f1', 'codex', 0.25, 400, 1), no('f2', 'claude', 0.5, 500, 1)]),
    no('r2', 'codex', 3, 9000, 24 * 5),
  ];

  test('custo por agente soma a árvore inteira, no período, maior primeiro', () => {
    assert.deepEqual(custoPorAgente(grafo, '24h', AGORA), [
      { agentId: 'claude', usd: 1.5, tokens: 1500, sessoes: 2 },
      { agentId: 'codex', usd: 0.25, tokens: 400, sessoes: 1 },
    ]);
    assert.deepEqual(custoPorAgente(grafo, '7d', AGORA)[0], {
      agentId: 'codex',
      usd: 3.25,
      tokens: 9400,
      sessoes: 2,
    });
  });

  test('achatar não repete sessão', () => {
    assert.equal(achatarGrafo([...grafo, grafo[0]!]).length, 4);
  });

  test('custo no tempo: 24 faixas de 1 h; soma bate com o total do período', () => {
    const faixas = custoNoTempo(grafo, '24h', AGORA);
    assert.equal(faixas.length, 24);
    const total = faixas.reduce((s, f) => s + f.usd, 0);
    assert.equal(total, 1.75);
    assert.equal(faixas[faixas.length - 2]!.usd, 1, 'a raiz começou há 2 h');
    assert.equal(custoNoTempo([], 'tudo', AGORA).length, 0);
    assert.equal(custoNoTempo(grafo, 'tudo', AGORA).length, 12);
  });

  test('só os fluxos que podem ter sessão no período precisam de /graph', () => {
    const fluxos = [
      { id: 'a', updatedAt: ha(1) },
      { id: 'b', updatedAt: ha(24 * 3) },
    ];
    assert.deepEqual(
      fluxosDoPeriodo(fluxos, '24h', AGORA).map((f) => f.id),
      ['a'],
    );
    assert.equal(fluxosDoPeriodo(fluxos, 'tudo', AGORA).length, 2);
  });
});

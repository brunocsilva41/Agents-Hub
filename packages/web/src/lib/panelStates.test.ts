import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deveFocarComposer } from './composerShortcut.js';
import { custoPorSessao, raizesParaBuscar, resumoDosGrafos, type EntradaDoGrafo } from './flowGraphs.js';
import { alternarFluxo, aoSelecionarFluxo, fluxoAberto, LISTA_INICIAL } from './flowListState.js';
import {
  aplicarTentativas,
  falhaDosRecursos,
  incluirAgentes,
  INDICE_INICIAL,
  resumoDasFalhas,
  situacaoDaTela,
} from './indexStatus.js';

describe('situação do índice por recurso (R03-16)', () => {
  test('antes de qualquer resposta: carregando, nunca vazio', () => {
    assert.equal(situacaoDaTela(INDICE_INICIAL, ['sessions'], true), 'carregando');
  });

  test('falha sem dado nenhum é ERRO, não "vazio" — e só para quem depende do recurso', () => {
    const i = aplicarTentativas(INDICE_INICIAL, {
      sessions: { ok: true },
      agents: { ok: false, erro: 'HTTP 500' },
      projects: { ok: true },
      approvals: { ok: true },
    });
    assert.equal(situacaoDaTela(i, ['agents'], true), 'erro');
    assert.equal(situacaoDaTela(i, ['sessions'], true), 'vazio');
    assert.equal(situacaoDaTela(i, ['sessions'], false), 'ok');
    assert.equal(falhaDosRecursos(i, ['agents']), 'agentes: HTTP 500');
    assert.equal(resumoDasFalhas(i), 'agentes: HTTP 500');
  });

  test('falha de RECARGA com dado antigo mantém a tela; o banner avisa', () => {
    const carregado = aplicarTentativas(INDICE_INICIAL, { sessions: { ok: true } });
    const recarga = aplicarTentativas(carregado, { sessions: { ok: false, erro: 'conexão' } });
    assert.equal(situacaoDaTela(recarga, ['sessions'], false), 'ok');
    assert.equal(resumoDasFalhas(recarga), 'sessões: conexão');
    const voltou = aplicarTentativas(recarga, { sessions: { ok: true } });
    assert.equal(resumoDasFalhas(voltou), null);
  });

  test('recurso não tentado fica como estava', () => {
    const i = aplicarTentativas(INDICE_INICIAL, { agents: { ok: false, erro: 'x' } });
    const j = aplicarTentativas(i, { sessions: { ok: true } });
    assert.equal(j.falhas.agents, 'x');
  });

  test('"tentar de novo" inclui /agents enquanto ele não carregou ou falhou', () => {
    assert.equal(incluirAgentes(INDICE_INICIAL, false), true);
    const ok = aplicarTentativas(INDICE_INICIAL, { agents: { ok: true } });
    assert.equal(incluirAgentes(ok, false), false);
    assert.equal(incluirAgentes(ok, true), true);
    const falhou = aplicarTentativas(ok, { agents: { ok: false, erro: 'x' } });
    assert.equal(incluirAgentes(falhou, false), true);
  });
});

describe('lista de fluxos: o selecionado pode ser recolhido (R03-24)', () => {
  test('selecionado abre sozinho; clicar recolhe; clicar de novo abre', () => {
    assert.equal(fluxoAberto(LISTA_INICIAL, 'r1', 'r1'), true);
    const recolhido = alternarFluxo(LISTA_INICIAL, 'r1', 'r1');
    assert.equal(fluxoAberto(recolhido, 'r1', 'r1'), false);
    const aberto = alternarFluxo(recolhido, 'r1', 'r1');
    assert.equal(fluxoAberto(aberto, 'r1', 'r1'), true);
  });

  test('outro fluxo: abre e fecha à mão', () => {
    const a = alternarFluxo(LISTA_INICIAL, 'r2', 'r1');
    assert.equal(fluxoAberto(a, 'r2', 'r1'), true);
    assert.equal(fluxoAberto(alternarFluxo(a, 'r2', 'r1'), 'r2', 'r1'), false);
  });

  test('escolher uma sessão do fluxo recolhido (paleta, DAG) volta a abri-lo', () => {
    const recolhido = alternarFluxo(LISTA_INICIAL, 'r1', 'r1');
    const depois = aoSelecionarFluxo(recolhido, 'r1');
    assert.equal(fluxoAberto(depois, 'r1', 'r1'), true);
    assert.equal(aoSelecionarFluxo(LISTA_INICIAL, 'r1'), LISTA_INICIAL, 'sem mudança, mesmo objeto');
  });
});

describe('atalho "/" do compositor (R03-28)', () => {
  const base = {
    key: '/',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    focoEmCampo: false,
    dialogoAberto: false,
    gavetaAberta: false,
    campoDesabilitado: false,
  };
  test('foca com a página livre', () => {
    assert.equal(deveFocarComposer(base), true);
  });
  test('não age com modal aberto, gaveta aberta, foco em campo ou campo desabilitado', () => {
    assert.equal(deveFocarComposer({ ...base, dialogoAberto: true }), false);
    assert.equal(deveFocarComposer({ ...base, gavetaAberta: true }), false);
    assert.equal(deveFocarComposer({ ...base, focoEmCampo: true }), false);
    assert.equal(deveFocarComposer({ ...base, campoDesabilitado: true }), false);
    assert.equal(deveFocarComposer({ ...base, ctrlKey: true }), false);
    assert.equal(deveFocarComposer({ ...base, key: 'a' }), false);
  });
});

describe('cache de grafos de vários fluxos (DAG/Telemetria)', () => {
  const entrada = (
    revisao: number,
    estado: EntradaDoGrafo<unknown>['estado'],
    erro: string | null = null,
  ) => ({
    revisao,
    estado,
    nos: estado === 'ok' ? [] : null,
    erro,
  });

  test('busca só o que falta ou mudou de revisão; erro na mesma revisão não volta em laço', () => {
    const cache = new Map([
      ['a', entrada(1, 'ok')],
      ['b', entrada(1, 'erro', 'HTTP 500')],
      ['c', entrada(1, 'carregando')],
    ]);
    const pedidos = [
      { rootId: 'a', revisao: 1 },
      { rootId: 'b', revisao: 1 },
      { rootId: 'c', revisao: 1 },
      { rootId: 'd', revisao: 0 },
    ];
    assert.deepEqual(raizesParaBuscar(cache, pedidos), ['d']);
    assert.deepEqual(raizesParaBuscar(cache, [{ rootId: 'a', revisao: 2 }]), ['a']);
    assert.deepEqual(resumoDosGrafos(cache, ['a', 'b', 'c', 'd']), {
      total: 4,
      prontos: 1,
      carregando: 2,
      falhas: 1,
      erro: 'HTTP 500',
    });
  });

  test('custo por sessão sai da árvore inteira', () => {
    const arvore = {
      sessionId: 'r',
      usd: 1,
      tokens: 10,
      children: [{ sessionId: 'f', usd: 0.5, tokens: 5, children: [] }],
    };
    const mapa = custoPorSessao([arvore]);
    assert.deepEqual(mapa.get('f'), { usd: 0.5, tokens: 5 });
    assert.deepEqual(mapa.get('r'), { usd: 1, tokens: 10 });
  });
});

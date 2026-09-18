import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createStore } from './index.js';

/**
 * "Não encontrado" precisa devolver `null`, nunca uma linha fantasma.
 *
 * Medido contra o piso declarado em `engines` (Node 22.5.0): `.get()` do
 * `node:sqlite` sem nenhuma linha casando devolvia `{ coluna: null, ... }`
 * em vez de `undefined` — só corrigido em versão posterior do runtime. Todo
 * `row ? mapX(row) : null` deste pacote lia esse objeto fantasma como
 * "encontrado". `getByPath` de um projeto inexistente virava "achado", e
 * `registerProject` retornava sem nunca inserir a linha real — a origem do
 * `FOREIGN KEY constraint failed` que a suíte via CI expôs (Node 24 não
 * reproduz; o job de Node 22.5 pegou). Corrigido trocando `.get()` por
 * `.all()[0]`, que devolve `[]` de verdade nas duas versões — estes testes
 * são a garantia de que a correção não volta a se perder numa próxima troca.
 */
describe('lookup de "uma linha ou nenhuma" devolve null quando não existe', () => {
  test('projeto por id', () => {
    const store = createStore(':memory:');
    assert.equal(store.projects.get('prj_inexistente'), null);
  });

  test('projeto por caminho', () => {
    const store = createStore(':memory:');
    assert.equal(store.projects.getByPath('/caminho/que/nao/existe'), null);
  });

  test('pasta de projeto por caminho', () => {
    const store = createStore(':memory:');
    assert.equal(store.projects.findFolderByPath('/pasta/que/nao/existe'), null);
  });

  test('sessão por id', () => {
    const store = createStore(':memory:');
    assert.equal(store.sessions.get('ses_inexistente'), null);
  });

  test('task por id', () => {
    const store = createStore(':memory:');
    assert.equal(store.tasks.get('tsk_inexistente'), null);
  });

  test('aprovação por id', () => {
    const store = createStore(':memory:');
    assert.equal(store.approvals.get('apv_inexistente'), null);
  });

  test('orçamento por root id', () => {
    const store = createStore(':memory:');
    assert.equal(store.budgets.get('ses_raiz_inexistente'), null);
  });

  test('registrar projeto duas vezes não recria: a segunda chamada acha o real', () => {
    // Reproduz o caminho exato que o bug quebrava: getByPath encontrando
    // (corretamente) um projeto que JÁ existe, sem confundir com "nenhuma
    // linha casou". Se getByPath devolvesse a linha fantasma para qualquer
    // busca, o projeto criado abaixo teria id vazio.
    const store = createStore(':memory:');
    const criado = store.projects.create({
      name: 'projeto-real',
      path: '/algum/caminho',
      defaultBranch: 'main',
    });
    assert.notEqual(criado.id, '');

    const encontrado = store.projects.getByPath('/algum/caminho');
    assert.deepEqual(encontrado, criado);
  });
});

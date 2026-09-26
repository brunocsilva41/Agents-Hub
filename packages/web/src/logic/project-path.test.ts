import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HubApiError } from '@agents-hub/client';
import { caminhoEhAbsoluto, erroDeCaminhoDoDaemon, problemaNoCaminhoLocal } from './project-path.js';

describe('caminho do projeto no modal', () => {
  test('absoluto em Windows e POSIX é aceito localmente', () => {
    for (const c of ['C:\\Projetos\\app', 'd:/x', '\\\\srv\\share\\app', '/home/u/app']) {
      assert.ok(caminhoEhAbsoluto(c), c);
      assert.equal(problemaNoCaminhoLocal(c), null, c);
    }
  });

  test('vazio e relativo são recusados antes de ir ao daemon', () => {
    assert.match(String(problemaNoCaminhoLocal('   ')), /Informe/);
    assert.match(String(problemaNoCaminhoLocal('meu-app')), /absoluto/);
    assert.match(String(problemaNoCaminhoLocal('.\\app')), /absoluto/);
  });

  test('400 INVALID_PATH do daemon vira mensagem junto do campo', () => {
    const err = new HubApiError(
      'path inválido: a pasta "C:\\nao\\existe" não existe',
      'INVALID_PATH',
      400,
    );
    assert.equal(
      erroDeCaminhoDoDaemon(err),
      'O Hub recusou o caminho: a pasta "C:\\nao\\existe" não existe',
    );
  });

  test('erro que não é de caminho não é tratado como tal', () => {
    assert.equal(erroDeCaminhoDoDaemon(new HubApiError('x', 'CONFLICT', 409)), null);
    assert.equal(erroDeCaminhoDoDaemon(new Error('rede')), null);
    assert.equal(erroDeCaminhoDoDaemon(null), null);
  });
});

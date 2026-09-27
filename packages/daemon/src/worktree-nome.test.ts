import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { nomeDaPastaDoProjeto } from './worktree.js';

/**
 * Vistoria 07, R07-24: "proj com espaço" virava `worktrees/proj-com-espa-o/`
 * (o `\w` sem flag `u` é só ASCII). Acentos agora são transliterados.
 */
describe('nome da pasta do projeto em worktrees/', () => {
  test('acentos são transliterados, não viram hífen', () => {
    assert.equal(nomeDaPastaDoProjeto('proj com espaço'), 'proj-com-espaco');
    assert.equal(nomeDaPastaDoProjeto('Configuração Ágil'), 'Configuracao-Agil');
    assert.equal(nomeDaPastaDoProjeto('açaí-pão_ü'), 'acai-pao_u');
  });

  test('o que não translitera ainda vira hífen, sem hífen/ponto nas pontas', () => {
    assert.equal(nomeDaPastaDoProjeto('日本'), 'projeto');
    assert.equal(nomeDaPastaDoProjeto('  meu projeto!  '), 'meu-projeto');
    assert.equal(nomeDaPastaDoProjeto('..'), 'projeto', '".." nunca pode sair daqui');
    assert.equal(nomeDaPastaDoProjeto('repo.'), 'repo', 'o Windows descarta ponto final');
  });

  test('limites do Windows: 60 caracteres e nome de dispositivo reservado', () => {
    assert.equal(nomeDaPastaDoProjeto('á'.repeat(100)).length, 60);
    assert.equal(nomeDaPastaDoProjeto('CON'), 'CON-projeto');
    assert.equal(nomeDaPastaDoProjeto('nul.txt'), 'nul.txt-projeto');
    assert.equal(nomeDaPastaDoProjeto('console'), 'console');
  });
});

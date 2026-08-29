import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { resolverPastaDaSessao, validarNovaPasta } from './folders.js';
import type { ProjectFolder } from './domain.js';

function pasta(p: string, extra: Partial<ProjectFolder> = {}): ProjectFolder {
  return {
    id: extra.id ?? `pfd_${p.replace(/\W/g, '')}`,
    projectId: extra.projectId ?? 'prj_1',
    path: p,
    label: extra.label ?? null,
    isPrimary: extra.isPrimary ?? false,
    createdAt: '2026-08-29T00:00:00.000Z',
  };
}

/** Raiz absoluta que funciona no Windows e no POSIX sem ramificar o teste. */
const RAIZ = path.resolve(path.sep, 'repo');
const API = path.join(RAIZ, 'api');

describe('composição de pastas do projeto', () => {
  test('pasta nova e independente é aceita', () => {
    const v = validarNovaPasta(path.resolve(path.sep, 'outro'), [pasta(RAIZ)]);
    assert.equal(v.ok, true);
  });

  test('caminho relativo é recusado com explicação', () => {
    // O daemon resolveria contra o diretório onde subiu, que não é o que o
    // usuário tem em mente — e o erro apareceria só depois, como acesso negado.
    const v = validarNovaPasta('./api', []);
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.motivo : '', /relativo/i);
  });

  test('pasta já registrada é recusada', () => {
    const v = validarNovaPasta(RAIZ, [pasta(RAIZ)]);
    assert.equal(v.ok, false);
  });

  test('pasta DENTRO de outra já registrada é recusada', () => {
    // Uma sessão aberta em /repo já alcança /repo/api. Registrar as duas
    // prometeria um isolamento que não existiria.
    const v = validarNovaPasta(API, [pasta(RAIZ)]);
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.motivo : '', /DENTRO/);
  });

  test('pasta que CONTÉM outra já registrada é recusada', () => {
    // O mesmo problema, retroativo: a pasta estreita deixaria de ser limite
    // para as sessões que já a usam.
    const v = validarNovaPasta(RAIZ, [pasta(API)]);
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.motivo : '', /CONT[ÉE]M/);
  });

  test('conflito atravessa a fronteira de projeto', () => {
    // O conflito é entre diretórios do disco. Permitir a mesma árvore em dois
    // projetos deixaria sem resposta qual política vale para o arquivo do meio.
    const v = validarNovaPasta(API, [pasta(RAIZ, { projectId: 'prj_OUTRO' })]);
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.motivo : '', /prj_OUTRO/);
  });

  test('nome parecido não é o mesmo que estar dentro', () => {
    // `/repo-antigo` NÃO está dentro de `/repo`, apesar do prefixo de string.
    // Comparar texto em vez de caminho recusaria uma pasta legítima.
    const v = validarNovaPasta(path.resolve(path.sep, 'repo-antigo'), [pasta(RAIZ)]);
    assert.equal(v.ok, true);
  });
});

describe('escolha da pasta da sessão', () => {
  const principal = pasta(RAIZ, { id: 'pfd_a', isPrimary: true });
  const secundaria = pasta(path.resolve(path.sep, 'infra'), { id: 'pfd_b' });

  test('sem escolha, usa a principal', () => {
    assert.equal(resolverPastaDaSessao([secundaria, principal])?.id, 'pfd_a');
  });

  test('escolha explícita vence', () => {
    assert.equal(resolverPastaDaSessao([principal, secundaria], 'pfd_b')?.id, 'pfd_b');
  });

  test('escolha inexistente devolve null, não a principal', () => {
    // Cair na principal quando pediram outra é agir em pasta que o usuário não
    // escolheu — o erro que este módulo inteiro existe para evitar.
    assert.equal(resolverPastaDaSessao([principal], 'pfd_INEXISTENTE'), null);
  });

  test('projeto sem pasta nenhuma devolve null', () => {
    assert.equal(resolverPastaDaSessao([]), null);
  });
});

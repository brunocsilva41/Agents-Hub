import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { isHubError, type UnitOfWork } from '@agents-hub/core';
import { createStore } from '@agents-hub/store';
import { ProjectRegistry } from './project-registry.js';

/**
 * `ProjectRegistry` direto, com banco em memória (item 7.1 do GOAL: o módulo
 * não tinha teste próprio). `projects.test.ts` cobre a ordem das checagens de
 * `register` pelo `SessionManager`; aqui ficam os contratos da classe que
 * ninguém exercitava sem subir o Hub inteiro: erro tipado para id
 * inexistente, confiança com hash (trust-on-first-use e suspensão), a camada
 * de contexto do Hub saneada e o estado do `config.yaml` do repositório.
 */

function codigoDe(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (isHubError(err)) return err.code;
    throw err;
  }
  throw new Error('esperava HubError, nada foi lançado');
}

describe('ProjectRegistry', () => {
  let raiz: string;
  let store: UnitOfWork;
  let reg: ProjectRegistry;

  before(() => {
    // Canônico: o registro normaliza caminhos (nome 8.3 → longo, item 5.5), e
    // o TEMP do Windows costuma vir em 8.3 (`BRUNOS~1`).
    raiz = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'hub-projreg-')));
  });

  after(() => {
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  beforeEach(() => {
    store = createStore(':memory:');
    reg = new ProjectRegistry(store);
  });

  let seq = 0;
  function pasta(nome = 'p'): string {
    seq += 1;
    const dir = path.join(raiz, `${nome}-${seq}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  test('register: nome padrão é o basename; pasta principal nasce junto; é idempotente', () => {
    const dir = pasta('meu-app');
    const p = reg.register(dir);
    assert.equal(p.name, path.basename(dir));
    assert.equal(p.path, path.resolve(dir));
    const pastas = reg.listFolders(p.id);
    assert.equal(pastas.length, 1);
    assert.equal(pastas[0]?.isPrimary, true);
    assert.equal(reg.register(dir, 'outro nome').id, p.id, 'o mesmo caminho devolve o mesmo projeto');
    assert.equal(reg.list().length, 1);
  });

  test('register: vazio ou relativo é PROJECT_FOLDER_CONFLICT (antes do path.resolve)', () => {
    assert.equal(
      codigoDe(() => reg.register('   ')),
      'PROJECT_FOLDER_CONFLICT',
    );
    assert.equal(
      codigoDe(() => reg.register('./relativo')),
      'PROJECT_FOLDER_CONFLICT',
    );
    assert.equal(reg.list().length, 0);
  });

  test('register: pasta dentro de outro projeto é recusada', () => {
    const dir = pasta();
    reg.register(dir);
    const dentro = path.join(dir, 'sub');
    mkdirSync(dentro);
    assert.equal(
      codigoDe(() => reg.register(dentro)),
      'PROJECT_FOLDER_CONFLICT',
    );
  });

  test('id inexistente é PROJECT_NOT_FOUND em todas as operações, nunca null seguindo adiante', () => {
    const id = 'prj_naoexiste';
    assert.equal(
      codigoDe(() => reg.get(id)),
      'PROJECT_NOT_FOUND',
    );
    assert.equal(
      codigoDe(() => reg.setTrusted(id, true)),
      'PROJECT_NOT_FOUND',
    );
    assert.equal(
      codigoDe(() => reg.getContext(id)),
      'PROJECT_NOT_FOUND',
    );
    assert.equal(
      codigoDe(() => reg.setContext(id, {})),
      'PROJECT_NOT_FOUND',
    );
    assert.equal(
      codigoDe(() => reg.repoStatus(id)),
      'PROJECT_NOT_FOUND',
    );
    assert.equal(
      codigoDe(() => reg.listFolders(id)),
      'PROJECT_NOT_FOUND',
    );
    assert.equal(
      codigoDe(() => reg.addFolder(id, pasta())),
      'PROJECT_NOT_FOUND',
    );
    assert.equal(
      codigoDe(() => reg.removeFolder(id, 'pfd_x')),
      'PROJECT_NOT_FOUND',
    );
  });

  test('addFolder: label padrão é o basename; removeFolder recusa a principal e a desconhecida', () => {
    const p = reg.register(pasta('front'));
    const back = pasta('back');
    const extra = reg.addFolder(p.id, back);
    assert.equal(extra.label, path.basename(back));
    assert.equal(extra.isPrimary, false);
    assert.equal(reg.addFolder(p.id, pasta('docs'), 'Documentação').label, 'Documentação');

    const principal = reg.listFolders(p.id).find((f) => f.isPrimary)!;
    assert.equal(
      codigoDe(() => reg.removeFolder(p.id, principal.id)),
      'FOLDER_IS_PRIMARY',
    );
    assert.equal(
      codigoDe(() => reg.removeFolder(p.id, 'pfd_desconhecida')),
      'FOLDER_NOT_FOUND',
    );

    reg.removeFolder(p.id, extra.id);
    assert.ok(!reg.listFolders(p.id).some((f) => f.id === extra.id));
    assert.equal(
      codigoDe(() => reg.addFolder(p.id, 'relativa')),
      'PROJECT_FOLDER_CONFLICT',
    );
  });

  test('setContext saneia: memória em branco some, env fora da lista de permissão é descartado', () => {
    const p = reg.register(pasta());
    const gravado = reg.setContext(p.id, {
      memory: '   ',
      prompts: { claude: '  seja breve  ', codex: '   ' },
      env: { claude: { ANTHROPIC_MODEL: 'modelo-local', NODE_OPTIONS: '--require ./payload.js' } },
    });
    assert.equal(gravado.memory, undefined);
    assert.deepEqual(gravado.prompts, { claude: 'seja breve' });
    assert.equal(gravado.env?.['claude']?.['NODE_OPTIONS'], undefined);
    assert.equal(gravado.env?.['claude']?.['ANTHROPIC_MODEL'], 'modelo-local');
    assert.deepEqual(reg.getContext(p.id), gravado, 'getContext devolve só a camada do Hub, já saneada');
  });

  test('repoStatus + setTrusted: untrusted com aviso → trusted → suspended quando o repo muda', () => {
    const dir = pasta();
    const p = reg.register(dir);
    mkdirSync(path.join(dir, '.agents-hub'));
    const arquivo = path.join(dir, '.agents-hub', 'config.yaml');
    writeFileSync(arquivo, 'memory: lembre do repo\n', 'utf8');

    const antes = reg.repoStatus(p.id);
    assert.equal(antes.path, arquivo);
    assert.equal(antes.trust, 'untrusted');
    assert.deepEqual(antes.sensitiveFields, ['memory']);
    assert.ok(antes.warning, 'campo sensível ignorado precisa de aviso');
    assert.equal(antes.context.memory, 'lembre do repo', 'o conteúdo do repo aparece para revisão');

    const confiado = reg.setTrusted(p.id, true);
    assert.equal(confiado.trusted, true);
    assert.match(String(confiado.trustedHash), /^sha256:/);
    assert.equal(reg.repoStatus(p.id).trust, 'trusted');
    assert.equal(reg.repoStatus(p.id).warning, null);

    // Um `git pull` que troca o conteúdo sensível suspende a confiança.
    writeFileSync(arquivo, 'memory: outra coisa\n', 'utf8');
    const depois = reg.repoStatus(p.id);
    assert.equal(depois.trust, 'suspended');
    assert.match(String(depois.warning), /SUSPENSA/);

    const revogado = reg.setTrusted(p.id, false);
    assert.equal(revogado.trusted, false);
    assert.equal(revogado.trustedHash, null);
    assert.equal(reg.repoStatus(p.id).trust, 'untrusted');
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createHub, type Hub } from './hub.js';

/**
 * Registro de projeto e composição de pastas, no caminho real do daemon.
 *
 * `core/folders.test.ts` cobre as regras puras. Aqui o que interessa é a ordem
 * das checagens dentro de `registerProject`, que já quebrou uma vez: validar
 * sobreposição ANTES de conferir se o projeto já existe fazia a segunda chamada
 * falhar com "esta pasta já pertence ao projeto X" — sendo X o próprio projeto
 * que o chamador queria de volta.
 */
describe('registro de projeto e pastas', () => {
  let hub: Hub;
  let raiz: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-proj-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    hub = createHub({ home: raiz, manifestsDir: manifestos, webRoot: path.join(raiz, 'sem-web') });
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function tmp(nome: string): string {
    const dir = path.join(raiz, nome);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  test('registrar o mesmo projeto duas vezes devolve o mesmo, sem erro', () => {
    // Uso normal: a CLI registra o projeto a cada `hub start`.
    const dir = tmp('idempotente');
    const a = hub.sessions.registerProject(dir, 'p');
    const b = hub.sessions.registerProject(dir, 'p');
    assert.equal(a.id, b.id);
  });

  test('todo projeto nasce com uma pasta principal', () => {
    // Sem isto um projeto recém-criado não teria onde rodar sessão nenhuma.
    const projeto = hub.sessions.registerProject(tmp('com-pasta'), 'p2');
    const pastas = hub.sessions.listProjectFolders(projeto.id);
    assert.equal(pastas.length, 1);
    assert.equal(pastas[0]?.isPrimary, true);
  });

  test('pasta independente é aceita; a de dentro é recusada', () => {
    const projeto = hub.sessions.registerProject(tmp('multi'), 'p3');
    const outra = tmp('multi-irma');

    const adicionada = hub.sessions.addProjectFolder(projeto.id, outra, 'irma');
    assert.equal(adicionada.isPrimary, false);
    assert.equal(hub.sessions.listProjectFolders(projeto.id).length, 2);

    // Subpasta da que já está registrada: uma sessão aberta na de fora já
    // alcança esta, então registrá-la prometeria isolamento inexistente.
    const dentro = path.join(outra, 'sub');
    mkdirSync(dentro, { recursive: true });
    assert.throws(() => hub.sessions.addProjectFolder(projeto.id, dentro), /DENTRO/);
  });

  test('caminho relativo é recusado antes de virar caminho errado', () => {
    const projeto = hub.sessions.registerProject(tmp('rel'), 'p4');
    assert.throws(() => hub.sessions.addProjectFolder(projeto.id, './algo'), /relativo/i);
  });

  test('a pasta principal não pode ser removida', () => {
    const projeto = hub.sessions.registerProject(tmp('principal'), 'p5');
    const [principal] = hub.sessions.listProjectFolders(projeto.id);
    assert.throws(
      () => hub.sessions.removeProjectFolder(projeto.id, principal?.id ?? ''),
      /principal/i,
    );
  });

  test('pasta de outro projeto não é removível por aqui', () => {
    const a = hub.sessions.registerProject(tmp('dono'), 'p6');
    const b = hub.sessions.registerProject(tmp('alheio'), 'p7');
    const [pastaDeB] = hub.sessions.listProjectFolders(b.id);
    // Aceitar removeria a pasta de um projeto pelo id de outro — o tipo de
    // brecha que passa despercebida porque o id "existe".
    assert.throws(
      () => hub.sessions.removeProjectFolder(a.id, pastaDeB?.id ?? ''),
      /não pertence/i,
    );
  });
});

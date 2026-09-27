import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { montarHubDeTeste, type HubDeTeste } from './hub-de-teste.js';
import { contemCaminho, resolverProjeto } from './project-resolve.js';

/**
 * Itens 5.3/5.5 do GOAL: `[projeto]`/`--project` da CLI (start, project
 * env/prompt/folders, import, policy, workflow) contra um daemon REAL.
 */
describe('resolverProjeto (CLI)', () => {
  let h: HubDeTeste;
  let projectId: string;

  before(async () => {
    h = await montarHubDeTeste([]);
    projectId = (await h.client.addProject(h.projeto, 'raiz')).project.id;
  });

  after(async () => {
    await h.encerrar();
  });

  test('subpasta de projeto registrado resolve para o projeto, sem registrar nada', async () => {
    const sub = path.join(h.projeto, 'src', 'lib');
    mkdirSync(sub, { recursive: true });
    const p = await resolverProjeto(h.client, sub);
    assert.equal(p.id, projectId);
    assert.equal((await h.client.projects()).projects.length, 1);
  });

  test(
    'outra caixa (Windows) resolve para o mesmo projeto',
    { skip: process.platform !== 'win32' },
    async () => {
      const p = await resolverProjeto(h.client, h.projeto.toUpperCase());
      assert.equal(p.id, projectId);
      assert.equal((await h.client.projects()).projects.length, 1);
    },
  );

  test('id prj_ desconhecido é erro "não encontrado" — nunca registra pasta com esse nome', async () => {
    await assert.rejects(
      resolverProjeto(h.client, 'prj_doesnotexist'),
      /projeto "prj_doesnotexist" não encontrado.*hub projects/,
    );
    assert.equal((await h.client.projects()).projects.length, 1);
  });

  test('caminho inexistente é recusado pelo daemon, sem registrar', async () => {
    await assert.rejects(resolverProjeto(h.client, path.join(h.raiz, 'nao-existe')), /não existe/);
    assert.equal((await h.client.projects()).projects.length, 1);
  });

  test('contemCaminho: prefixo de nome não é "dentro"', () => {
    assert.equal(contemCaminho(h.projeto, `${h.projeto}-irmao`), false);
    assert.equal(contemCaminho(h.projeto, path.join(h.projeto, 'x')), true);
  });
});

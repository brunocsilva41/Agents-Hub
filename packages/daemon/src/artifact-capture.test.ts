import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, describe, test } from 'node:test';
import { parseBrief, type Artifact, type EventEnvelope, type Session, type Task } from '@agents-hub/core';
import { captureBaseline, saveBaseline } from './diff-capture.js';
import { capturarMudancas, type CapturarMudancasDeps } from './artifact-capture.js';

const exec = promisify(execFile);

/**
 * `capturarMudancas`, extraída de `session-manager.ts` (dívida arquitetural
 * do arquivo grande) — sem teste próprio antes disso, só via integração.
 * `emit`/`store` chegam por dependência injetada, então dá para testar sem
 * subir um `SessionManager` inteiro. Cada teste usa seu próprio repositório
 * git e sua própria raiz de artefatos, para não vazar estado entre casos.
 */

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  }
});

async function repoNovo(): Promise<string> {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'hub-artifact-capture-'));
  dirs.push(repo);
  await exec('git', ['init', '-q'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'teste@local'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'Teste'], { cwd: repo });
  writeFileSync(path.join(repo, 'base.txt'), 'linha original\n', 'utf8');
  await exec('git', ['add', '-A'], { cwd: repo });
  await exec('git', ['commit', '-qm', 'inicial'], { cwd: repo });
  return repo;
}

function artifactRootNovo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hub-artifact-root-'));
  dirs.push(dir);
  return dir;
}

function sessionOf(id: string, workdir: string): Session {
  return {
    id,
    projectId: 'proj-teste',
    agentId: 'claude',
    nativeSessionId: null,
    rootId: id,
    parentId: null,
    depth: 0,
    path: [`claude:${id}`],
    state: 'running',
    mode: 'autonomous',
    isolation: 'none',
    workdir,
    title: 'sessão de teste',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: null,
    pid: null,
  };
}

function taskOf(id: string, sessionId: string): Task {
  const agora = new Date().toISOString();
  return {
    id,
    sessionId,
    requesterSessionId: null,
    brief: parseBrief({ agent: 'claude', objective: 'objetivo de teste' }),
    attempts: [],
    state: 'working',
    result: null,
    createdAt: agora,
    updatedAt: agora,
  };
}

function depsFalsos(artifactRoot: string): {
  deps: CapturarMudancasDeps;
  criados: Artifact[];
  emitidos: unknown[];
} {
  const criados: Artifact[] = [];
  const emitidos: unknown[] = [];
  const deps: CapturarMudancasDeps = {
    store: {
      artifacts: {
        create: (a: Artifact) => {
          criados.push(a);
          return a;
        },
        list: () => criados,
      },
    },
    artifactRoot,
    emit: (draft) => {
      emitidos.push(draft);
    },
  };
  return { deps, criados, emitidos };
}

describe('capturarMudancas', () => {
  test('árvore sem mudança nenhuma desde a linha de base: nem artefato, nem evento', async () => {
    const repo = await repoNovo();
    const artifactRoot = artifactRootNovo();
    const baseline = await captureBaseline(repo);
    await saveBaseline(artifactRoot, 'ses-sem-mudanca', baseline);

    const { deps, criados, emitidos } = depsFalsos(artifactRoot);
    const session = sessionOf('ses-sem-mudanca', repo);
    const ids = await capturarMudancas(deps, session, taskOf('task-sem-mudanca', session.id));

    assert.deepEqual(ids, []);
    assert.equal(criados.length, 0);
    assert.equal(emitidos.length, 0);
  });

  test('arquivo alterado depois da linha de base: cria artefato e emite file.changed', async () => {
    const repo = await repoNovo();
    const artifactRoot = artifactRootNovo();
    const baseline = await captureBaseline(repo);
    await saveBaseline(artifactRoot, 'ses-com-mudanca', baseline);

    writeFileSync(path.join(repo, 'base.txt'), 'linha modificada\n', 'utf8');

    const { deps, criados, emitidos } = depsFalsos(artifactRoot);
    const session = sessionOf('ses-com-mudanca', repo);
    const task = taskOf('task-com-mudanca', session.id);
    const ids = await capturarMudancas(deps, session, task);

    assert.equal(ids.length, 1);
    assert.equal(criados.length, 1);
    assert.equal(criados[0]?.id, ids[0]);
    assert.equal(criados[0]?.sessionId, session.id);
    assert.equal(criados[0]?.taskId, task.id);
    assert.equal(criados[0]?.kind, 'diff');
    assert.ok(criados[0]?.path, 'artefato precisa ter caminho do diff persistido');

    assert.equal(emitidos.length, 1);
    const evento = emitidos[0] as { type: EventEnvelope['type']; payload: Record<string, unknown> };
    assert.equal(evento.type, 'file.changed');
    assert.equal(evento.payload['artifactId'], ids[0]);
    assert.match(String(evento.payload['summary']), /arquivo/);
  });

  test('sem linha de base salva: todo tracked pendente conta (mesmo comportamento de captureDiff sem baseline)', async () => {
    const repo = await repoNovo();
    const artifactRoot = artifactRootNovo();
    // Nenhum `saveBaseline` chamado para esta sessão de propósito — é o caso
    // real de uma sessão cujo baseline nunca foi capturado (ex.: erro no
    // início da run). `captureDiff` sem baseline atribui tudo que está
    // pendente ao agente, então uma árvore SEM nenhuma mudança pendente
    // ainda deve resultar em "sem artefato".
    const { deps, criados, emitidos } = depsFalsos(artifactRoot);
    const session = sessionOf('ses-sem-baseline', repo);
    const ids = await capturarMudancas(deps, session, taskOf('task-sem-baseline', session.id));

    assert.deepEqual(ids, []);
    assert.equal(criados.length, 0);
    assert.equal(emitidos.length, 0);
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { DEFAULT_POLICY, type Project, type Session } from '@agents-hub/core';
import { PROJECT_CONFIG_RELATIVE } from './project-config.js';
import { policyFor, projectPolicyFor, type EffectivePolicyDeps } from './effective-policy.js';

/**
 * `policyFor`/`projectPolicyFor`, extraídas de `session-manager.ts` (dívida
 * arquitetural do arquivo grande) — sem teste próprio antes disso, cobertas
 * só indiretamente via integração. `store` chega como fake mínimo (só
 * `projects.get`/`sessions.get`), então dá para testar sem banco real.
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

let contadorDeProjeto = 0;

function projetoComOverrides(overridesYaml: string | null): Project {
  const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-effective-policy-'));
  dirs.push(raiz);
  if (overridesYaml !== null) {
    mkdirSync(path.join(raiz, '.agents-hub'), { recursive: true });
    writeFileSync(path.join(raiz, PROJECT_CONFIG_RELATIVE), overridesYaml, 'utf8');
  }
  contadorDeProjeto += 1;
  return {
    id: `proj-teste-${contadorDeProjeto}`,
    name: 'projeto de teste',
    path: raiz,
    defaultBranch: 'main',
    createdAt: new Date().toISOString(),
  };
}

function sessionOf(id: string, projectId: string, parentId: string | null): Session {
  return {
    id,
    projectId,
    agentId: 'claude',
    nativeSessionId: null,
    rootId: parentId ?? id,
    parentId,
    depth: parentId ? 1 : 0,
    path: [`claude:${id}`],
    state: 'running',
    mode: 'autonomous',
    isolation: 'none',
    workdir: '/tmp/x',
    title: 'sessão de teste',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: null,
    pid: null,
  };
}

function depsCom(
  projects: Record<string, Project>,
  sessions: Record<string, Session>,
): EffectivePolicyDeps {
  return {
    store: {
      projects: { get: (id: string) => projects[id] ?? null } as EffectivePolicyDeps['store']['projects'],
      sessions: { get: (id: string) => sessions[id] ?? null } as EffectivePolicyDeps['store']['sessions'],
    },
    globalPolicy: DEFAULT_POLICY,
  };
}

describe('projectPolicyFor', () => {
  test('projeto inexistente devolve a política global sem lançar', () => {
    const deps = depsCom({}, {});
    assert.equal(projectPolicyFor(deps, 'nao-existe'), DEFAULT_POLICY);
  });

  test('projeto sem config.yaml devolve a política global', () => {
    const projeto = projetoComOverrides(null);
    const deps = depsCom({ [projeto.id]: projeto }, {});
    const policy = projectPolicyFor(deps, projeto.id);
    assert.equal(policy.maxDepth, DEFAULT_POLICY.maxDepth);
  });

  test('projeto com override aperta a política global (nunca afrouxa)', () => {
    const projeto = projetoComOverrides('policy:\n  maxDepth: 1\n');
    const deps = depsCom({ [projeto.id]: projeto }, {});
    const policy = projectPolicyFor(deps, projeto.id);
    assert.equal(policy.maxDepth, 1);
  });
});

describe('policyFor', () => {
  test('sessão-raiz (sem parentId) usa só a política do próprio projeto', () => {
    const projeto = projetoComOverrides('policy:\n  maxDepth: 2\n');
    const raiz = sessionOf('ses-raiz', projeto.id, null);
    const deps = depsCom({ [projeto.id]: projeto }, { [raiz.id]: raiz });

    const engine = policyFor(deps, raiz);
    assert.equal(engine.policy.maxDepth, 2);
  });

  test('sessão filha herda a interseção com a política do pai (nunca supera)', () => {
    const projetoPai = projetoComOverrides('policy:\n  maxDepth: 2\n');
    const projetoFilho = projetoComOverrides('policy:\n  maxDepth: 5\n');
    const pai = sessionOf('ses-pai', projetoPai.id, null);
    const filho = sessionOf('ses-filho', projetoFilho.id, pai.id);

    const deps = depsCom(
      { [projetoPai.id]: projetoPai, [projetoFilho.id]: projetoFilho },
      { [pai.id]: pai, [filho.id]: filho },
    );

    const engine = policyFor(deps, filho);
    // O filho tentou 5, mas o pai só permitia 2 — a interseção é o mais restritivo.
    assert.equal(engine.policy.maxDepth, 2, 'filho não pode superar o teto do pai');
  });

  test('pai referenciado mas ausente no store: devolve só a política do próprio, sem lançar', () => {
    const projeto = projetoComOverrides(null);
    const filho = sessionOf('ses-orfao', projeto.id, 'pai-que-nao-existe');
    const deps = depsCom({ [projeto.id]: projeto }, { [filho.id]: filho });

    const engine = policyFor(deps, filho);
    assert.equal(engine.policy.maxDepth, DEFAULT_POLICY.maxDepth);
  });

  test('ciclo de sessões não entra em loop infinito (visited corta)', () => {
    const projeto = projetoComOverrides(null);
    // a→b→a: um ciclo malformado não deveria existir de verdade, mas a
    // função precisa terminar de qualquer jeito.
    const a = sessionOf('ses-a', projeto.id, 'ses-b');
    const b = sessionOf('ses-b', projeto.id, 'ses-a');
    const deps = depsCom({ [projeto.id]: projeto }, { [a.id]: a, [b.id]: b });

    const engine = policyFor(deps, a);
    assert.ok(engine, 'não deveria lançar nem travar em loop infinito');
  });
});

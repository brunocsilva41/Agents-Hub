import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULT_POLICY, mergePolicyLayer, PolicyEngine } from './policy.js';
import { clampedFields, diffPolicy, loosenedFields, policyLeaves } from './policy-edit.js';
import { matchSensitivePath } from './sensitive-paths.js';

describe('policy-edit (item 1.10): o que uma edição muda de verdade', () => {
  test('policyLeaves achata objetos e trata lista como folha', () => {
    const folhas = policyLeaves({ a: { b: 1, c: [1, 2] }, d: null });
    assert.equal(folhas.get('a.b'), '1');
    assert.equal(folhas.get('a.c'), '[1,2]');
    assert.equal(folhas.get('d'), 'null');
  });

  test('diffPolicy aponta só o que mudou', () => {
    const outra = mergePolicyLayer(DEFAULT_POLICY, { maxDepth: 1, defaultBudget: { usd: 1 } });
    assert.deepEqual(diffPolicy(DEFAULT_POLICY, outra), ['defaultBudget.usd', 'maxDepth']);
    assert.deepEqual(diffPolicy(DEFAULT_POLICY, DEFAULT_POLICY), []);
  });

  test('loosenedFields: só o que ficou MAIS permissivo', () => {
    const depois = mergePolicyLayer(DEFAULT_POLICY, {
      maxDepth: 1, // aperta
      defaultBudget: { usd: 50 }, // afrouxa
      risk: { irreversible: 'allow', exec: 'approve' }, // afrouxa / aperta
      commands: { deny: [] }, // afrouxa (remove a deny list)
      watch: { pauseOn: [] }, // afrouxa se o padrão pausa em algo
    });
    const afrouxados = loosenedFields(DEFAULT_POLICY, depois);
    assert.ok(afrouxados.includes('defaultBudget.usd'));
    assert.ok(afrouxados.includes('risk.irreversible'));
    if (DEFAULT_POLICY.commands.deny.length > 0) assert.ok(afrouxados.includes('commands.deny'));
    if (DEFAULT_POLICY.watch.pauseOn.length > 0) assert.ok(afrouxados.includes('watch.pauseOn'));
    assert.ok(!afrouxados.includes('maxDepth'));
    assert.ok(!afrouxados.includes('risk.exec'));
  });

  test('clampedFields: o que a camada de projeto pediu e não vale (mesmo clamp do 0.7)', () => {
    const campos = clampedFields(
      DEFAULT_POLICY,
      {
        maxDepth: 1,
        defaultBudget: { usd: 999 },
        commands: { allow: ['git status', 'nao-existe-na-global'] },
        validation: { command: 'node x.js' },
      },
      false,
    );
    assert.ok(campos.includes('defaultBudget.usd'));
    assert.ok(campos.includes('commands.allow'));
    assert.ok(campos.includes('validation.command'));
    assert.ok(!campos.includes('maxDepth'));

    const confiado = clampedFields(DEFAULT_POLICY, { validation: { command: 'node x.js' } }, true);
    assert.ok(!confiado.includes('validation.command'), 'com confiança o campo de execução vale');
  });
});

describe('operator-token é segredo para o gate (item 1.6)', () => {
  const arquivo = path.join(os.homedir(), '.agents-hub', 'operator-token');

  test('matchSensitivePath classifica o arquivo como segredo', () => {
    assert.equal(matchSensitivePath(arquivo)?.kind, 'secret');
    assert.equal(matchSensitivePath('C:\\Users\\x\\.agents-hub\\operator-token')?.kind, 'secret');
  });

  test('ler o token não passa direto em modo algum', () => {
    const engine = new PolicyEngine(DEFAULT_POLICY);
    for (const mode of ['supervised', 'semi', 'autonomous'] as const) {
      const leitura = engine.decide(
        { kind: 'file.read', path: arquivo },
        { workdir: os.tmpdir(), mode },
      );
      assert.notEqual(leitura.decision, 'allow', `file.read em ${mode}`);
      const cat = engine.decide(
        { kind: 'command', command: `cat ${arquivo}` },
        { workdir: os.tmpdir(), mode },
      );
      assert.notEqual(cat.decision, 'allow', `cat em ${mode}`);
    }
  });
});

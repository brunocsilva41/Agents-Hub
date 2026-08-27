import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULT_POLICY, PolicyEngine, watchForMode } from './policy.js';

const workdir = path.resolve('/tmp/hub/worktree');

describe('watchForMode', () => {
  test('modo semi para apenas no irreversível', () => {
    const watch = watchForMode(DEFAULT_POLICY.watch, 'semi');
    assert.deepEqual(watch.pauseOn, ['irreversible']);
  });

  test('modo supervisionado também para ao sair da allow list', () => {
    const watch = watchForMode(DEFAULT_POLICY.watch, 'supervised');
    assert.ok(watch.pauseOn.includes('irreversible'));
    assert.ok(watch.pauseOn.includes('escalate'));
  });

  test('modo autônomo não afrouxa o irreversível', () => {
    const watch = watchForMode(DEFAULT_POLICY.watch, 'autonomous');
    assert.ok(
      watch.pauseOn.includes('irreversible'),
      'nem em modo autônomo o irreversível pode passar batido',
    );
  });
});

describe('vigilância: o que pausa e o que só alerta', () => {
  const engine = new PolicyEngine();
  const ctx = { workdir, mode: 'semi' as const };

  test('git push pausa a sessão', () => {
    const { risk } = engine.classify({ kind: 'command', command: 'git push origin main' }, ctx);
    assert.ok(watchForMode(DEFAULT_POLICY.watch, 'semi').pauseOn.includes(risk));
  });

  test('comando fora da allow list só alerta em modo semi', () => {
    const { risk } = engine.classify({ kind: 'command', command: 'terraform plan' }, ctx);
    const watch = watchForMode(DEFAULT_POLICY.watch, 'semi');

    assert.equal(risk, 'escalate');
    assert.ok(!watch.pauseOn.includes(risk), 'não pode parar a sessão por isto');
    assert.ok(watch.flagOn.includes(risk), 'mas precisa ficar visível na timeline');
  });

  test('o mesmo comando pausa em modo supervisionado', () => {
    const { risk } = engine.classify({ kind: 'command', command: 'terraform plan' }, ctx);
    assert.ok(watchForMode(DEFAULT_POLICY.watch, 'supervised').pauseOn.includes(risk));
  });

  test('trabalho normal dentro do worktree não gera nada', () => {
    const watch = watchForMode(DEFAULT_POLICY.watch, 'semi');
    for (const command of ['npm test', 'git status', 'git commit -m "wip"']) {
      const { risk } = engine.classify({ kind: 'command', command }, ctx);
      assert.ok(!watch.pauseOn.includes(risk), `${command} não pode parar a sessão`);
      assert.ok(!watch.flagOn.includes(risk), `${command} não pode virar alerta`);
    }
  });
});

describe('vigilância herdada', () => {
  test('interseção soma o que o pai vigia (não corta)', () => {
    const parent = new PolicyEngine({
      ...DEFAULT_POLICY,
      watch: { pauseOn: ['irreversible', 'escalate'], flagOn: ['exec'] },
    });

    const effective = parent.intersect({
      ...DEFAULT_POLICY,
      watch: { pauseOn: ['irreversible'], flagOn: ['escalate'] },
    });

    assert.ok(
      effective.policy.watch.pauseOn.includes('escalate'),
      'o filho não pode deixar de parar no que o pai pararia',
    );
    assert.ok(effective.policy.watch.flagOn.includes('exec'));
  });
});

describe('portão de delegação', () => {
  const engine = new PolicyEngine();

  test('sessão supervisionada retém toda delegação', () => {
    const verdict = engine.decide(
      { kind: 'delegation', agent: 'codex' },
      { workdir, mode: 'supervised' },
    );
    assert.equal(verdict.decision, 'approve');
  });

  test('sessão semi delega livremente', () => {
    const verdict = engine.decide(
      { kind: 'delegation', agent: 'codex' },
      { workdir, mode: 'semi' },
    );
    assert.equal(verdict.decision, 'allow');
  });
});

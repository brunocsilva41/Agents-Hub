import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseBrief, renderBriefAsPrompt } from './brief.js';
import { objectiveHash } from './ids.js';

describe('fan-in no brief', () => {
  const base = {
    agent: 'codex',
    objective: 'Refatorar a lógica de backend conforme o plano',
  };

  test('o resultado do passo anterior aparece no prompt, antes dos critérios', () => {
    const brief = parseBrief({
      ...base,
      acceptanceCriteria: ['o build continua verde'],
      upstream: [
        {
          step: 'plan',
          agent: 'claude',
          summary: 'Extrair o módulo de billing para packages/billing',
          sessionRef: 'session:ses_abc',
        },
      ],
    });

    const prompt = renderBriefAsPrompt(brief);

    assert.match(prompt, /## O que os passos anteriores entregaram/);
    assert.match(prompt, /### plan \(claude\)/);
    assert.match(prompt, /Extrair o módulo de billing/);
    assert.match(prompt, /session:ses_abc/);

    // Um objetivo como "refatorar conforme o plano" é ininteligível sem o
    // plano: ele precisa vir antes dos critérios de aceite, não depois.
    assert.ok(
      prompt.indexOf('passos anteriores') < prompt.indexOf('Critérios de aceite'),
      'o fan-in tem de vir antes dos critérios de aceite',
    );
  });

  test('o fan-in NÃO entra no objetivo — senão a detecção de ciclo cega', () => {
    const semUpstream = parseBrief(base);
    const comUpstream = parseBrief({
      ...base,
      upstream: [{ step: 'plan', agent: 'claude', summary: 'qualquer coisa que o plano diga' }],
    });

    // `objectiveHash` é o que o CallGraph usa para reconhecer a MESMA tarefa
    // num ciclo. Se o resultado do passo anterior fosse concatenado ao
    // objetivo, duas execuções da mesma tarefa pareceriam tarefas diferentes
    // e o ciclo passaria batido.
    assert.equal(
      objectiveHash(comUpstream.objective),
      objectiveHash(semUpstream.objective),
    );
  });

  test('sem fan-in a seção não existe', () => {
    const prompt = renderBriefAsPrompt(parseBrief(base));
    assert.equal(prompt.includes('passos anteriores'), false);
  });
});

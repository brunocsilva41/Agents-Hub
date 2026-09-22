import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TaskAttempt } from './domain.js';
import {
  classifyOutcome,
  closeLastAttempt,
  failureContext,
  nextStep,
  novaTentativa,
  sleep,
} from './resilience.js';

const config = { maxRetries: 2, backoffMs: 1000, fallbackChain: ['claude', 'codex', 'opencode'] };

function attempt(n: number, agentId: string, error: string | null = 'erro'): TaskAttempt {
  return {
    n,
    agentId,
    startedAt: '2026-08-27T10:00:00.000Z',
    endedAt: '2026-08-27T10:01:00.000Z',
    outcome: error === null ? 'success' : 'error',
    error,
  };
}

describe('classifyOutcome', () => {
  test('saída limpa é sucesso', () => {
    assert.equal(
      classifyOutcome({ reason: 'exit', exitCode: 0, error: null }),
      'success',
    );
  });

  test('cancelamento nunca vira retry', () => {
    assert.equal(
      classifyOutcome({ reason: 'canceled', exitCode: null, error: null }),
      'canceled',
    );
  });

  test('run travada no heartbeat é transitória', () => {
    assert.equal(
      classifyOutcome({ reason: 'heartbeat', exitCode: null, error: 'sem eventos por 300s' }),
      'transient',
    );
  });

  test('rate limit é transitório', () => {
    assert.equal(
      classifyOutcome({ reason: 'error', exitCode: 1, error: 'API error 429: rate limit exceeded' }),
      'transient',
    );
  });

  test('erro determinístico é permanente', () => {
    assert.equal(
      classifyOutcome({ reason: 'exit', exitCode: 1, error: 'invalid model name' }),
      'permanent',
      'repetir um erro determinístico só queima orçamento',
    );
  });
});

describe('nextStep', () => {
  test('primeira falha transitória tenta de novo no mesmo agente', () => {
    const step = nextStep({ attempts: [attempt(1, 'claude')], currentAgentId: 'claude' }, 'transient', config);
    assert.equal(step.kind, 'retry');
    assert.equal(step.kind === 'retry' && step.agentId, 'claude');
    assert.equal(step.kind === 'retry' && step.backoffMs, 1000);
  });

  test('backoff cresce a cada tentativa do mesmo agente', () => {
    const step = nextStep(
      { attempts: [attempt(1, 'claude'), attempt(2, 'claude')], currentAgentId: 'claude' },
      'transient',
      config,
    );
    assert.equal(step.kind === 'retry' && step.backoffMs, 2000);
  });

  test('esgotadas as tentativas, passa para o próximo da cadeia', () => {
    const step = nextStep(
      {
        attempts: [attempt(1, 'claude'), attempt(2, 'claude'), attempt(3, 'claude')],
        currentAgentId: 'claude',
      },
      'transient',
      config,
    );
    assert.equal(step.kind, 'fallback');
    assert.equal(step.kind === 'fallback' && step.agentId, 'codex');
  });

  test('falha permanente pula o retry e vai direto ao fallback', () => {
    const step = nextStep({ attempts: [attempt(1, 'claude')], currentAgentId: 'claude' }, 'permanent', config);
    assert.equal(step.kind, 'fallback');
    assert.equal(step.kind === 'fallback' && step.agentId, 'codex');
  });

  test('nunca volta a um agente que já falhou', () => {
    const step = nextStep(
      { attempts: [attempt(1, 'claude'), attempt(2, 'codex')], currentAgentId: 'codex' },
      'permanent',
      config,
    );
    assert.equal(step.kind === 'fallback' && step.agentId, 'opencode');
  });

  test('cadeia esgotada termina em desistência, sem pendurar a task', () => {
    const step = nextStep(
      {
        attempts: [attempt(1, 'claude'), attempt(2, 'codex'), attempt(3, 'opencode')],
        currentAgentId: 'opencode',
      },
      'permanent',
      config,
    );
    assert.equal(step.kind, 'give_up');
    assert.match(step.reason, /todos os agentes/);
  });

  test('cancelamento desiste na hora, mesmo com cadeia disponível', () => {
    const step = nextStep({ attempts: [attempt(1, 'claude')], currentAgentId: 'claude' }, 'canceled', config);
    assert.equal(step.kind, 'give_up');
  });

  test('sem cadeia configurada, falha permanente desiste direto', () => {
    const step = nextStep({ attempts: [attempt(1, 'kimi')], currentAgentId: 'kimi' }, 'permanent', {
      ...config,
      fallbackChain: [],
    });
    assert.equal(step.kind, 'give_up');
  });
});

describe('failureContext', () => {
  test('resume as falhas para o próximo agente não repetir o caminho', () => {
    const text = failureContext([
      attempt(1, 'claude', 'timeout na compilação'),
      attempt(2, 'codex', 'teste X continuou vermelho'),
    ]);
    assert.match(text, /claude/);
    assert.match(text, /timeout na compilação/);
    assert.match(text, /codex/);
  });

  test('sem falhas, não polui o brief', () => {
    assert.equal(failureContext([attempt(1, 'claude', null)]), '');
  });
});

/**
 * `closeLastAttempt`/`novaTentativa`/`sleep`, extraídas de `session-manager.ts`
 * (dívida arquitetural do arquivo grande) — sem teste próprio antes disso,
 * cobertas só indiretamente via integração.
 */
describe('closeLastAttempt', () => {
  test('lista vazia devolve a mesma lista vazia', () => {
    assert.deepEqual(closeLastAttempt([], 'success', null), []);
  });

  test('fecha só a ÚLTIMA tentativa, preservando as anteriores intactas', () => {
    const anterior = attempt(1, 'claude', 'já tinha erro');
    const atual = novaTentativa(2, 'codex');
    const fechadas = closeLastAttempt([anterior, atual], 'success', null);

    assert.equal(fechadas[0], anterior, 'tentativa anterior não é tocada');
    assert.equal(fechadas[1]?.outcome, 'success');
    assert.equal(fechadas[1]?.error, null);
    assert.notEqual(fechadas[1]?.endedAt, null);
  });

  test('mapeia outcome de resiliência para o vocabulário de TaskAttempt', () => {
    const casos: Array<[Parameters<typeof closeLastAttempt>[1], TaskAttempt['outcome']]> = [
      ['success', 'success'],
      ['invalid', 'invalid'],
      ['canceled', null],
      ['transient', 'error'],
      ['permanent', 'error'],
    ];
    for (const [outcome, esperado] of casos) {
      const [fechada] = closeLastAttempt([novaTentativa(1, 'claude')], outcome, null);
      assert.equal(fechada?.outcome, esperado, `outcome ${outcome} deveria mapear para ${esperado}`);
    }
  });

  test('propaga a mensagem de erro', () => {
    const [fechada] = closeLastAttempt([novaTentativa(1, 'claude')], 'permanent', 'boom');
    assert.equal(fechada?.error, 'boom');
  });
});

describe('novaTentativa', () => {
  test('abre uma tentativa com o número e agente pedidos, sem desfecho ainda', () => {
    const t = novaTentativa(3, 'kimi');
    assert.equal(t.n, 3);
    assert.equal(t.agentId, 'kimi');
    assert.equal(t.outcome, null);
    assert.equal(t.error, null);
    assert.equal(t.endedAt, null);
    assert.notEqual(t.startedAt, null);
  });
});

describe('sleep', () => {
  test('resolve depois de aproximadamente o tempo pedido', async () => {
    const inicio = Date.now();
    await sleep(20);
    assert.ok(Date.now() - inicio >= 15, 'não pode resolver antes do tempo pedido');
  });
});

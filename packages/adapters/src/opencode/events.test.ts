import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SseDecoder,
  openCodeIdleSignal,
  openCodeSessionId,
  translateOpenCodeEvent,
} from './events.js';

const SESSAO = 'ses_abc123';

function evento(type: string, data: Record<string, unknown> = {}): unknown {
  return { id: 'evt_1', type, data: { sessionID: SESSAO, ...data } };
}

describe('SseDecoder', () => {
  test('extrai eventos completos de um bloco', () => {
    const decoder = new SseDecoder();
    const out = decoder.push('data: {"type":"a"}\n\ndata: {"type":"b"}\n\n');
    assert.equal(out.length, 2);
  });

  test('junta um evento partido entre dois chunks', () => {
    const decoder = new SseDecoder();
    assert.deepEqual(decoder.push('data: {"ty'), [], 'nada completo ainda');

    const out = decoder.push('pe":"session.idle"}\n\n');
    assert.equal(out.length, 1);
    assert.equal((out[0] as { type: string }).type, 'session.idle');
  });

  test('ignora comentário de heartbeat', () => {
    assert.deepEqual(new SseDecoder().push(': heartbeat\n\n'), []);
  });

  test('JSON inválido não derruba o decodificador', () => {
    const decoder = new SseDecoder();
    assert.deepEqual(decoder.push('data: {quebrado\n\n'), []);
    assert.equal(decoder.push('data: {"type":"ok"}\n\n').length, 1, 'segue funcionando depois');
  });
});

describe('translateOpenCodeEvent', () => {
  test('session.created revela o id nativo, que é o que faz o resume funcionar', () => {
    const [mapped] = translateOpenCodeEvent(evento('session.created'));
    assert.equal(mapped?.type, 'session.started');
    assert.equal(mapped?.nativeSessionId, SESSAO);
  });

  test('texto do agente vira mensagem', () => {
    const [mapped] = translateOpenCodeEvent(
      evento('session.next.text.ended', { text: 'terminei' }),
    );
    assert.equal(mapped?.type, 'message');
    assert.equal(mapped?.payload['text'], 'terminei');
  });

  test('passo encerrado traz custo e tokens — o ganho principal sobre a CLI', () => {
    const [, turno] = translateOpenCodeEvent(
      evento('session.next.step.ended', {
        finish: 'stop',
        cost: 0.0123,
        tokens: { input: 1200, output: 340, reasoning: 60, cache: { read: 800, write: 0 } },
        files: ['src/a.ts'],
      }),
    );

    assert.equal(turno?.type, 'turn.completed');
    assert.equal(turno?.cost?.usd, 0.0123);
    assert.equal(turno?.cost?.inputTokens, 1200);
    assert.equal(
      turno?.cost?.outputTokens,
      400,
      'reasoning é token gerado e cobrado como saída; separá-lo faria o total não bater',
    );
    assert.equal(turno?.cost?.cachedTokens, 800);
  });

  test('arquivos alterados no passo viram file.changed', () => {
    const eventos = translateOpenCodeEvent(
      evento('session.next.step.ended', { files: ['src/a.ts', 'src/b.ts'] }),
    );
    const alterados = eventos.filter((e) => e.type === 'file.changed');
    assert.equal(alterados.length, 2);
    assert.equal(alterados[0]?.payload['path'], 'src/a.ts');
  });

  test('shell executado é classificado como comando, não como tool genérica', () => {
    const [mapped] = translateOpenCodeEvent(
      evento('session.next.shell.started', { command: 'npm test', callID: 'c1' }),
    );
    assert.equal(mapped?.type, 'command.executed');
    assert.equal(mapped?.payload['command'], 'npm test');
  });

  test('passo que falha vira erro com a mensagem do servidor', () => {
    const [mapped] = translateOpenCodeEvent(
      evento('session.next.step.failed', { error: { message: 'modelo não suportado' } }),
    );
    assert.equal(mapped?.type, 'error');
    assert.equal(mapped?.payload['message'], 'modelo não suportado');
  });

  test('evento desconhecido de uma sessão vira log, nunca some', () => {
    const [mapped] = translateOpenCodeEvent(evento('session.next.algo.novo', { x: 1 }));
    assert.equal(mapped?.type, 'log');
    assert.equal(mapped?.payload['opencodeType'], 'session.next.algo.novo');
  });

  test('ruído global sem sessão é descartado', () => {
    assert.deepEqual(
      translateOpenCodeEvent({ id: 'evt', type: 'lsp.diagnostics', data: {} }),
      [],
      'o stream é do servidor inteiro e carrega evento que não é de run nenhuma',
    );
  });

  test('file.edited é descartado porque não diz de qual sessão veio', () => {
    assert.deepEqual(
      translateOpenCodeEvent({ id: 'evt', type: 'file.edited', data: { file: 'a.ts' } }),
      [],
      'atribuí-lo a uma sessão num servidor compartilhado seria chute',
    );
  });

  test('entrada malformada não lança', () => {
    for (const lixo of [null, undefined, 42, 'texto', [], {}]) {
      assert.doesNotThrow(() => translateOpenCodeEvent(lixo));
    }
  });
});

describe('fim de turno', () => {
  test('session.idle é sinal de fim', () => {
    assert.equal(openCodeIdleSignal(evento('session.idle')), true);
  });

  test('session.status com status idle também', () => {
    assert.equal(
      openCodeIdleSignal(evento('session.status', { status: { type: 'idle' } })),
      true,
    );
  });

  test('status de retry não encerra o turno', () => {
    assert.equal(
      openCodeIdleSignal(evento('session.status', { status: { type: 'retry' } })),
      false,
    );
  });
});

describe('openCodeSessionId', () => {
  test('extrai o id quando o evento pertence a uma sessão', () => {
    assert.equal(openCodeSessionId(evento('session.idle')), SESSAO);
  });

  test('devolve null para evento global', () => {
    assert.equal(openCodeSessionId({ type: 'server.connected', data: {} }), null);
  });
});

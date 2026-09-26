import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EventEnvelope } from '@agents-hub/core';
import { EventHistory, type FetchOptions } from './eventHistory.js';
import { appendLive, HISTORY_PAGE, mergeBySeq, retryDelayMs } from './eventMerge.js';
import { FakeClock, flushMicrotasks } from './fakeClock.js';

function ev(seq: number, sessionId = 'ses_a'): EventEnvelope {
  return {
    id: `evt_${sessionId}_${seq}`,
    seq,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    sessionId,
    taskId: null,
    agentId: 'claude',
    type: 'message',
    payload: { text: `m${seq}` },
    cost: null,
    raw: null,
  };
}

/** Daemon falso: `total` eventos, responde tail/before/since como o real. */
function daemon(total: number) {
  const all = Array.from({ length: total }, (_, i) => ev(i + 1));
  const calls: FetchOptions[] = [];
  let failNext = 0;
  const pending: Array<() => void> = [];
  let hold = false;
  const fetch = async (_id: string, o: FetchOptions): Promise<EventEnvelope[]> => {
    calls.push(o);
    if (hold) await new Promise<void>((r) => pending.push(r));
    if (failNext > 0) {
      failNext -= 1;
      throw new TypeError('Failed to fetch');
    }
    if (o.since !== undefined) return all.filter((e) => e.seq > (o.since as number)).slice(0, o.limit);
    if (o.before !== undefined) return all.filter((e) => e.seq < (o.before as number)).slice(-o.limit);
    if (o.tail) return all.slice(-o.limit);
    return all.slice(0, o.limit);
  };
  return {
    all,
    calls,
    fetch,
    failTimes(n: number) {
      failNext = n;
    },
    hold(on: boolean) {
      hold = on;
      if (!on) for (const r of pending.splice(0)) r();
    },
  };
}

describe('timeline: mescla e paginação (6.3)', () => {
  test('abre pelo FIM: sessão com 1200 eventos mostra os 500 mais recentes', async () => {
    const d = daemon(1200);
    const h = new EventHistory({ fetch: d.fetch, onChange: () => {} });
    h.ensure('ses_a');
    await flushMicrotasks();
    const seqs = h.events('ses_a').map((e) => e.seq);
    assert.equal(seqs.length, HISTORY_PAGE);
    assert.equal(seqs[0], 701);
    assert.equal(seqs[seqs.length - 1], 1200);
    assert.equal(h.history('ses_a').hasMoreBefore, true);
  });

  test('pagina para trás até o começo, sem buraco nem duplicata', async () => {
    const d = daemon(1200);
    const h = new EventHistory({ fetch: d.fetch, onChange: () => {} });
    h.ensure('ses_a');
    await flushMicrotasks();
    await h.loadOlder('ses_a');
    await h.loadOlder('ses_a');
    const seqs = h.events('ses_a').map((e) => e.seq);
    assert.deepEqual(seqs, d.all.map((e) => e.seq));
    assert.equal(h.history('ses_a').hasMoreBefore, false);
    // Sem mais nada, não pede de novo.
    const antes = d.calls.length;
    await h.loadOlder('ses_a');
    assert.equal(d.calls.length, antes);
  });

  test('evento SSE que chega ANTES da abertura não impede buscar o histórico', async () => {
    const d = daemon(50);
    const h = new EventHistory({ fetch: d.fetch, onChange: () => {} });
    h.pushLive(ev(51));
    h.ensure('ses_a');
    await flushMicrotasks();
    const seqs = h.events('ses_a').map((e) => e.seq);
    assert.equal(seqs.length, 51);
    assert.equal(seqs[0], 1);
    assert.equal(seqs[50], 51);
  });

  test('evento SSE que chega DURANTE a busca não é descartado pela resposta', async () => {
    const d = daemon(10);
    const h = new EventHistory({ fetch: d.fetch, onChange: () => {} });
    d.hold(true);
    h.ensure('ses_a');
    await flushMicrotasks();
    h.pushLive(ev(11));
    h.pushLive(ev(12));
    d.hold(false);
    await flushMicrotasks();
    assert.deepEqual(
      h.events('ses_a').map((e) => e.seq),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
  });

  test('falha de rede é repetida sozinha com espera crescente, e para depois do limite', async () => {
    const clock = new FakeClock();
    const d = daemon(5);
    const h = new EventHistory({ fetch: d.fetch, onChange: () => {}, clock });
    d.failTimes(2);
    h.ensure('ses_a');
    await flushMicrotasks();
    assert.equal(h.history('ses_a').status, 'failed');
    assert.equal(h.history('ses_a').nextRetryAt, 1000);

    await clock.advance(1000); // 2ª tentativa: falha de novo
    assert.equal(h.history('ses_a').failures, 2);
    assert.equal(h.history('ses_a').nextRetryAt, 1000 + 2000);

    await clock.advance(2000); // 3ª: funciona
    assert.equal(h.history('ses_a').status, 'ready');
    assert.equal(h.events('ses_a').length, 5);
    assert.equal(d.calls.length, 3);
  });

  test('depois de esgotar as tentativas automáticas, só o clique busca de novo', async () => {
    const clock = new FakeClock();
    const d = daemon(5);
    const h = new EventHistory({ fetch: d.fetch, onChange: () => {}, clock });
    d.failTimes(100);
    h.ensure('ses_a');
    await flushMicrotasks();
    await clock.advance(10 * 60_000);
    const tentativas = d.calls.length;
    assert.equal(tentativas, 6, 'uma inicial + 5 automáticas');
    assert.equal(h.history('ses_a').nextRetryAt, null);
    assert.equal(clock.pendingTimers, 0);

    d.failTimes(0);
    h.retry('ses_a');
    await flushMicrotasks();
    assert.equal(h.history('ses_a').status, 'ready');
    assert.equal(h.history('ses_a').failures, 0);
  });

  test('reconexão repõe o buraco a partir do último seq conhecido', async () => {
    const d = daemon(10);
    const h = new EventHistory({ fetch: d.fetch, onChange: () => {} });
    h.ensure('ses_a');
    await flushMicrotasks();
    d.all.push(ev(11), ev(12));
    await h.resync();
    assert.deepEqual(d.calls.at(-1), { since: 10, limit: 5000 });
    assert.equal(h.events('ses_a').at(-1)?.seq, 12);
  });
});

describe('mescla por seq', () => {
  test('duplicado ao vivo devolve a MESMA referência (sem render à toa)', () => {
    const base = [ev(1), ev(2), ev(3)];
    const r = appendLive(base, ev(2));
    assert.equal(r.events, base);
  });

  test('teto corta o começo e avisa', () => {
    const base = [ev(1), ev(2), ev(3)];
    const r = appendLive(base, ev(4), 3);
    assert.deepEqual(r.events.map((e) => e.seq), [2, 3, 4]);
    assert.equal(r.trimmed, true);
  });

  test('intercalado sai ordenado e sem repetição', () => {
    const merged = mergeBySeq([ev(1), ev(3), ev(5)], [ev(4), ev(2), ev(3)]);
    assert.deepEqual(merged.map((e) => e.seq), [1, 2, 3, 4, 5]);
  });

  test('espera entre tentativas: 1 s, 2 s, 4 s… e nula após o limite', () => {
    assert.equal(retryDelayMs(1), 1000);
    assert.equal(retryDelayMs(2), 2000);
    assert.equal(retryDelayMs(5), 16000);
    assert.equal(retryDelayMs(6), null);
  });
});

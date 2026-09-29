import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { makeEvent, newId, nowIso, type EventEnvelope, type Session, type Task } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

interface BlocoSse {
  id: string | null;
  event: EventEnvelope;
}

/**
 * Lê blocos `id:`/`data:` do stream até ele fechar ou `parar` dizer chega.
 * Espera por CONDIÇÃO (fim do stream ou bloco esperado), nunca por tempo: o
 * `timeoutMs` só existe para o teste falhar em vez de travar.
 */
async function lerSse(
  res: Response,
  parar: (blocos: BlocoSse[]) => boolean = () => false,
  timeoutMs = 10_000,
): Promise<{ blocos: BlocoSse[]; fechou: boolean }> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
  assert.ok(reader, 'stream deveria ter corpo legível');
  const decoder = new TextDecoder();
  const blocos: BlocoSse[] = [];
  let buffer = '';
  const timer = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    for (;;) {
      if (parar(blocos)) {
        await reader.cancel();
        return { blocos, fechou: false };
      }
      const { value, done } = await reader.read();
      if (done) return { blocos, fechou: true };
      buffer += decoder.decode(value, { stream: true });
      let fim: number;
      while ((fim = buffer.indexOf('\n\n')) >= 0) {
        const linhas = buffer.slice(0, fim).split('\n');
        buffer = buffer.slice(fim + 2);
        const data = linhas.find((l) => l.startsWith('data: '));
        if (!data) continue;
        const id = linhas.find((l) => l.startsWith('id: '));
        blocos.push({
          id: id ? id.slice(4) : null,
          event: JSON.parse(data.slice(6)) as EventEnvelope,
        });
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * R13-13: `/api/tasks/:id/events` com `Last-Event-ID`.
 *
 * O cenário que importa é o fallback: a task começa na sessão A, o substituto
 * B assume, e A ainda emite o próprio fim DEPOIS do primeiro evento de B. Um
 * id que fosse só o `seq` (ou só o último par sessão:seq) perderia ou
 * repetiria evento na reconexão — o cursor composto não.
 */
describe('SSE de /api/tasks/:id/events — reconexão com Last-Event-ID', () => {
  let raiz: string;
  let hub: Hub;
  let baseUrl: string;
  let projectId: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-sse-task-'));
    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: path.join(raiz, 'sem-manifestos'),
      webRoot: path.join(raiz, 'sem-web'),
      port: 0,
    });
    const { host, port } = await hub.start();
    baseUrl = `http://${host}:${port}`;
    projectId = hub.sessions.registerProject(raiz, 'projeto-sse-task').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function criarSessao(rootId?: string): Session {
    const id = newId('ses');
    const session: Session = {
      id,
      projectId,
      agentId: 'fantasma',
      nativeSessionId: null,
      rootId: rootId ?? id,
      parentId: null,
      depth: 0,
      path: [],
      state: 'running',
      mode: 'semi',
      isolation: 'none',
      workdir: raiz,
      title: 'sessão do SSE da task',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      pid: null,
    };
    hub.store.sessions.create(session);
    // O bus roteia por raiz a partir deste registro — sem ele o ao vivo não chega.
    hub.bus.registerSession(id, session.rootId);
    return session;
  }

  function criarTask(sessionId: string, state: Task['state']): Task {
    const task: Task = {
      id: newId('tsk'),
      sessionId,
      requesterSessionId: null,
      brief: { agent: 'fantasma', objective: 'x' } as Task['brief'],
      state,
      attempts: [],
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    hub.store.tasks.create(task);
    return task;
  }

  /** `ts` explícito: a ordem entre sessões no replay é por `ts`. */
  function gravar(sessionId: string, taskId: string, seq: number, ts: string): EventEnvelope {
    const event = {
      ...makeEvent({ sessionId, taskId, agentId: 'fantasma', type: 'log', payload: { seq } }, seq),
      ts,
    };
    hub.store.events.append(event);
    return event;
  }

  const instante = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

  /**
   * A: 1, 2 | B: 1 | A: 3 (fim da original depois do início do substituto) |
   * B: 2. Task já no substituto e terminal — o stream faz replay e fecha.
   */
  function semearFallback(): { a: Session; b: Session; task: Task } {
    const a = criarSessao();
    const b = criarSessao(a.id);
    const task = criarTask(a.id, 'working');
    gravar(a.id, task.id, 1, instante(1));
    gravar(a.id, task.id, 2, instante(2));
    gravar(b.id, task.id, 1, instante(3));
    gravar(a.id, task.id, 3, instante(4));
    gravar(b.id, task.id, 2, instante(5));
    hub.store.tasks.update(task.id, { sessionId: b.id, state: 'completed' });
    return { a, b, task };
  }

  const rotulos = (blocos: BlocoSse[], a: Session): string[] =>
    blocos.map((x) => `${x.event.sessionId === a.id ? 'A' : 'B'}${x.event.seq}`);

  test('sem Last-Event-ID: replay das duas sessões, cada evento com o cursor de todas', async () => {
    const { a, b, task } = semearFallback();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`);
    assert.equal(res.status, 200);
    const { blocos, fechou } = await lerSse(res);

    assert.ok(fechou, 'task terminal: o stream fecha depois do replay');
    assert.deepEqual(rotulos(blocos, a), ['A1', 'A2', 'B1', 'A3', 'B2']);
    assert.deepEqual(
      blocos.map((x) => x.id),
      [`${a.id}:1`, `${a.id}:2`, `${a.id}:2,${b.id}:1`, `${a.id}:3,${b.id}:1`, `${a.id}:3,${b.id}:2`],
    );
  });

  test('reconexão depois do 1º evento do substituto entrega o fim da original e o resto, sem repetir', async () => {
    const { a, b, task } = semearFallback();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, {
      headers: { 'Last-Event-ID': `${a.id}:2,${b.id}:1` },
    });
    assert.equal(res.status, 200);
    const { blocos } = await lerSse(res);

    assert.deepEqual(rotulos(blocos, a), ['A3', 'B2']);
    // O cursor carrega adiante a posição das duas sessões.
    assert.equal(blocos.at(-1)?.id, `${a.id}:3,${b.id}:2`);
  });

  test('reconexão com o cursor do último evento não reenvia nada', async () => {
    const { a, b, task } = semearFallback();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, {
      headers: { 'Last-Event-ID': `${a.id}:3,${b.id}:2` },
    });
    assert.equal(res.status, 200);
    const { blocos, fechou } = await lerSse(res);
    assert.ok(fechou);
    assert.deepEqual(blocos, []);
  });

  test('Last-Event-ID malformado é 400 INVALID_QUERY antes de abrir o stream', async () => {
    const { a, task } = semearFallback();
    for (const valor of ['20', 'abc', `${a.id}:x`, `${a.id}:1,${a.id}:2`, `${a.id}:1,`]) {
      const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, {
        headers: { 'Last-Event-ID': valor },
      });
      assert.equal(res.status, 400, `"${valor}" deveria ser recusado`);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'INVALID_QUERY');
    }
  });

  test('Last-Event-ID de sessão que não é da task é 400', async () => {
    const { task } = semearFallback();
    const outra = criarSessao();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, {
      headers: { 'Last-Event-ID': `${outra.id}:1` },
    });
    assert.equal(res.status, 400);
  });

  test('ao vivo: só o que passa do cursor sai, e o id avança', async () => {
    const a = criarSessao();
    const task = criarTask(a.id, 'working');
    gravar(a.id, task.id, 1, instante(1));
    gravar(a.id, task.id, 2, instante(2));

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, {
      headers: { 'Last-Event-ID': `${a.id}:2` },
    });
    assert.equal(res.status, 200);

    // Um reenvio do bus de algo que o cliente já tem (seq 2) não pode sair.
    const repetido = hub.store.events.list({ sessionId: a.id }).find((e) => e.seq === 2);
    assert.ok(repetido);
    hub.bus.publish(repetido);
    hub.bus.publish(gravar(a.id, task.id, 3, instante(3)));
    const { blocos } = await lerSse(res, (b) => b.length >= 1);

    assert.deepEqual(
      blocos.map((x) => x.event.seq),
      [3],
    );
    assert.equal(blocos[0]?.id, `${a.id}:3`);
  });

  test('replay maior que o teto: avisa, fecha, e a reconexão com o cursor continua de onde parou', async () => {
    const a = criarSessao();
    const task = criarTask(a.id, 'completed');
    for (let seq = 1; seq <= 520; seq += 1) gravar(a.id, task.id, seq, instante(seq));

    const primeira = await lerSse(await fetch(`${baseUrl}/api/tasks/${task.id}/events`));
    assert.ok(primeira.fechou, 'replay cortado fecha para o cliente reconectar com o cursor');
    const reais = primeira.blocos.filter((b) => b.id !== null);
    assert.equal(reais.length, 500);
    const aviso = primeira.blocos.at(-1);
    assert.equal(aviso?.id, null, 'o aviso sintético não mexe no Last-Event-ID');
    assert.equal(aviso?.event.payload['truncated'], true);

    const segunda = await lerSse(
      await fetch(`${baseUrl}/api/tasks/${task.id}/events`, {
        headers: { 'Last-Event-ID': reais.at(-1)?.id ?? '' },
      }),
    );
    assert.deepEqual(
      segunda.blocos.map((b) => b.event.seq),
      Array.from({ length: 20 }, (_, i) => 501 + i),
    );
  });
});

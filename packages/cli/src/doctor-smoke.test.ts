import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { HubClient } from '@agents-hub/client';
import { smokeTestAgent, smokeTestAll } from './doctor-smoke.js';

/**
 * `hub doctor --smoke` gasta tokens/créditos reais a cada execução — por
 * isso este teste NUNCA sobe um agente de verdade. Em vez disso, sobe um
 * daemon falso (HTTP puro) que imita as rotas que `smokeTestAgent` consome
 * (`POST /sessions`, `GET /sessions/:id[/events|/tasks]`, `GET /budget/:id`)
 * e simula três comportamentos: agente que responde normalmente, agente que
 * nunca sai de "running" (timeout) e agente cujo `POST /sessions` falha.
 */

interface SessaoFalsa {
  agentId: string;
  nativeSessionId: string | null;
  events: Array<{ type: string }>;
  taskState: string;
  usage: { usd: number; tokens: number } | null;
}

function montarDaemonFalso(): { server: Server; sessions: Map<string, SessaoFalsa> } {
  const sessions = new Map<string, SessaoFalsa>();
  let seq = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      try {
        if (req.method === 'POST' && url.pathname === '/sessions') {
          const parsed = JSON.parse(body) as { projectId: string; brief: { agent: string } };
          const agentId = parsed.brief.agent;

          if (agentId === 'fails-to-start') {
            send(400, { error: { message: 'binário não respondeu', code: 'AGENT_DOWN' } });
            return;
          }

          seq += 1;
          const id = `sess-${agentId}-${seq}`;
          sessions.set(id, {
            agentId,
            nativeSessionId: null,
            events: [],
            taskState: 'running',
            usage: null,
          });
          send(200, {
            session: sessaoDto(id, agentId, null, 'running'),
            task: { id: `${id}-task`, sessionId: id, state: 'running' },
            budget: budgetDto(0, 0),
          });
          return;
        }

        const alvo = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(events|tasks))?$/);
        if (req.method === 'GET' && alvo) {
          const id = alvo[1] as string;
          const sub = alvo[2];
          const fake = sessions.get(id);
          if (!fake) {
            send(404, { error: { message: 'sessão não encontrada' } });
            return;
          }

          if (sub === 'events') {
            // Agente feliz: no primeiro poll já respondeu; no segundo, a task fechou.
            if (fake.agentId.startsWith('fake-ok')) {
              if (fake.events.length === 0) {
                fake.events = [{ type: 'turn.completed' }];
                fake.nativeSessionId = 'native-abc-123';
              } else if (fake.taskState === 'running') {
                fake.taskState = 'completed';
                fake.usage = { usd: 0.01, tokens: 120 };
              }
            }
            send(200, {
              events: fake.events.map((e, i) => ({
                id: String(i),
                type: e.type,
                sessionId: id,
                ts: new Date().toISOString(),
                payload: {},
              })),
            });
            return;
          }

          if (sub === 'tasks') {
            send(200, {
              tasks: [
                {
                  id: `${id}-task`,
                  sessionId: id,
                  requesterSessionId: null,
                  state: fake.taskState,
                  brief: { agent: fake.agentId, objective: '', acceptanceCriteria: [] },
                  attempts: [],
                  result: fake.usage
                    ? { summary: 'OK', artifacts: [], usage: { ...fake.usage, seconds: 1 } }
                    : null,
                  createdAt: '',
                  updatedAt: '',
                },
              ],
            });
            return;
          }

          // GET /sessions/:id
          send(200, { session: sessaoDto(id, fake.agentId, fake.nativeSessionId, fake.taskState), live: true });
          return;
        }

        if (req.method === 'GET' && url.pathname.startsWith('/budget/')) {
          send(200, { budget: budgetDto(0, 0) });
          return;
        }

        send(404, { error: { message: `rota não implementada no fake: ${url.pathname}` } });
      } catch (err) {
        send(500, { error: { message: (err as Error).message } });
      }
    });
  });

  return { server, sessions };
}

function sessaoDto(id: string, agentId: string, nativeSessionId: string | null, state: string) {
  return {
    id,
    projectId: 'proj-fake',
    agentId,
    nativeSessionId,
    rootId: id,
    parentId: null,
    depth: 0,
    state,
    mode: 'supervised',
    isolation: 'worktree',
    title: null,
    workdir: 'C:/tmp/fake',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: null,
  };
}

function budgetDto(usd: number, tokens: number) {
  return {
    limits: { usd: 5, tokens: 0, seconds: 0 },
    consumed: { usd, tokens, seconds: 0 },
    reserved: { usd: 0, tokens: 0, seconds: 0 },
    remaining: { usd: 5 - usd, tokens: 0, seconds: 0 },
    pressure: 0,
    exhausted: false,
  };
}

describe('hub doctor --smoke — lógica isolada de qualquer binário real', () => {
  let ambiente: { server: Server; sessions: Map<string, SessaoFalsa> };
  let client: HubClient;

  before(async () => {
    ambiente = montarDaemonFalso();
    await new Promise<void>((resolve) => ambiente.server.listen(0, resolve));
    const { port } = ambiente.server.address() as AddressInfo;
    client = new HubClient(`http://127.0.0.1:${port}`);
  });

  after(async () => {
    await new Promise<void>((resolve) => ambiente.server.close(() => resolve()));
  });

  test('agente saudável: processo sobe, turn.completed aparece, custo e nativeSessionId capturados', async () => {
    const outcome = await smokeTestAgent(client, 'fake-ok-solo', {
      projectId: 'proj-fake',
      pollMs: 5,
      timeoutMs: 5000,
    });

    assert.equal(outcome.agentId, 'fake-ok-solo');
    assert.equal(outcome.processStarted, true);
    assert.equal(outcome.turnCompleted, true);
    assert.equal(outcome.costCaptured, true);
    assert.equal(outcome.nativeSessionIdCaptured, true);
    assert.equal(outcome.finalState, 'completed');
    assert.equal(outcome.error, null);
  });

  test('agente cujo POST /sessions falha: processStarted fica falso e o erro é reportado, sem tentar poll', async () => {
    const outcome = await smokeTestAgent(client, 'fails-to-start', {
      projectId: 'proj-fake',
      pollMs: 5,
      timeoutMs: 5000,
    });

    assert.equal(outcome.processStarted, false);
    assert.equal(outcome.turnCompleted, false);
    assert.equal(outcome.finalState, null);
    assert.match(outcome.error ?? '', /binário não respondeu/);
  });

  test('agente que nunca sai de "running": estoura o timeout e reporta em vez de travar para sempre', async () => {
    const outcome = await smokeTestAgent(client, 'fake-hang', {
      projectId: 'proj-fake',
      pollMs: 15,
      timeoutMs: 80,
    });

    assert.equal(outcome.processStarted, true);
    assert.equal(outcome.turnCompleted, false);
    assert.equal(outcome.costCaptured, false);
    assert.equal(outcome.nativeSessionIdCaptured, false);
    assert.equal(outcome.finalState, null);
    assert.match(outcome.error ?? '', /sem estado terminal/);
  });

  test('smokeTestAll roda vários agentes em lotes de concorrência 2 e devolve um outcome por agente, na ordem', async () => {
    const ids = ['fake-ok-a', 'fake-ok-b', 'fake-ok-c', 'fake-ok-d', 'fake-ok-e'];
    const outcomes = await smokeTestAll(
      client,
      ids,
      { projectId: 'proj-fake', pollMs: 5, timeoutMs: 5000 },
      2,
    );

    assert.deepEqual(
      outcomes.map((o) => o.agentId),
      ids,
    );
    for (const outcome of outcomes) {
      assert.equal(outcome.processStarted, true, `${outcome.agentId} deveria ter subido`);
      assert.equal(outcome.finalState, 'completed', `${outcome.agentId} deveria ter completado`);
    }
  });
});

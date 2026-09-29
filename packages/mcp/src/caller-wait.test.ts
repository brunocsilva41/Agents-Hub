import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import os from 'node:os';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HubApiError, HubClient, type SessionSummary } from '@agents-hub/client';
import { CallerIdentity } from './caller.js';
import { buildMcpServer } from './server.js';

interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const textOf = (r: unknown): string => (r as ToolTextResult).content.map((c) => c.text).join('\n');

function sessao(id: string): SessionSummary {
  return { id } as SessionSummary;
}

/**
 * Identidade do chamador externo (vistoria 2026-09-25, 08-mcp-hooks, achados
 * 7 e 13; item 2.8 do GOAL).
 */
describe('CallerIdentity', () => {
  test('adoção que falhou NÃO fica cacheada: quando o daemon volta, a próxima tool adota', async () => {
    let tentativas = 0;
    const client = {
      adopt: async () => {
        tentativas += 1;
        if (tentativas === 1) throw new Error('O daemon do Agents-Hub não está rodando');
        return { session: sessao('ses_adotada1') };
      },
    } as unknown as HubClient;
    const caller = new CallerIdentity(client, 'externo', os.tmpdir());

    await assert.rejects(caller.resolve(), /não está rodando/);
    assert.equal(await caller.resolve(), 'ses_adotada1');
    assert.equal(tentativas, 2);
  });

  test('sinal de vida recusado (raiz expirou) faz a próxima tool adotar uma raiz nova', async () => {
    let adocoes = 0;
    const batimentos: string[] = [];
    const client = {
      adopt: async () => {
        adocoes += 1;
        return { session: sessao(`ses_raiz${adocoes}`) };
      },
      heartbeat: async (id: string) => {
        batimentos.push(id);
        if (id === 'ses_raiz1') {
          throw new HubApiError('A raiz adotada já terminou', 'ILLEGAL_STATE', 409);
        }
        return { ok: true, leaseMs: 1000 };
      },
    } as unknown as HubClient;
    const caller = new CallerIdentity(client, 'externo', os.tmpdir());

    await caller.heartbeat(); // sem adoção ainda: não faz nada
    assert.deepEqual(batimentos, []);

    assert.equal(await caller.resolve(), 'ses_raiz1');
    await caller.heartbeat();
    assert.equal(await caller.resolve(), 'ses_raiz2', 'raiz morta não pode continuar sendo usada');
    await caller.heartbeat();
    assert.deepEqual(batimentos, ['ses_raiz1', 'ses_raiz2']);
    assert.equal(await caller.resolve(), 'ses_raiz2');
  });

  test('falha de rede no sinal de vida não descarta a raiz', async () => {
    const client = {
      adopt: async () => ({ session: sessao('ses_raiz9') }),
      heartbeat: async () => {
        throw new TypeError('fetch failed');
      },
    } as unknown as HubClient;
    const caller = new CallerIdentity(client, 'externo', os.tmpdir());
    await caller.resolve();
    await caller.heartbeat();
    assert.equal(await caller.resolve(), 'ses_raiz9');
  });
});

/**
 * `hub_agent_wait` cancelado pelo cliente seguia consultando o daemon (achado
 * 8). Relógio falso para o backoff do laço (1,5 s, 2,1 s, ...) e daemon falso
 * EM PROCESSO: cada consulta é contada na hora, sem rede, então "nenhuma
 * consulta depois do cancelamento" é verificável sem esperar tempo de parede.
 *
 * O daemon falso responde com uma sessão do fluxo de quem chama: a versão
 * anterior deste teste respondia `session: null`, a espera morria na primeira
 * consulta por erro de escopo e o teste passava mesmo com o laço ignorando o
 * cancelamento.
 */
describe('MCP: hub_agent_wait cancelável', () => {
  test('para de consultar o daemon quando o cliente cancela', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let consultas = 0;
    let avisarConsulta: () => void = () => {};
    const proximaConsulta = (): Promise<void> =>
      new Promise((resolve) => {
        avisarConsulta = resolve;
      });
    const sessaoDoFluxo = { id: 'ses_chamador1', rootId: 'ses_raiz1' } as SessionSummary;
    const hubClient = {
      task: async (id: string) => {
        consultas += 1;
        avisarConsulta();
        return {
          task: { id, state: 'working', attempts: [], result: null },
          session: sessaoDoFluxo,
        };
      },
      session: async () => ({ session: sessaoDoFluxo }),
    } as unknown as HubClient;
    const caller = new CallerIdentity(hubClient, 'agente-mcp', os.tmpdir(), 'ses_chamador1');
    const server = buildMcpServer(hubClient, caller);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'teste-wait-cancelado', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    t.after(() => client.close());
    // O transporte em memória e o laço só usam microtarefas: uma volta do
    // event loop basta para tudo o que o relógio liberou acontecer.
    const drenar = (): Promise<void> => new Promise((r) => setImmediate(r));

    const controle = new AbortController();
    const primeira = proximaConsulta();
    const chamada = client
      .callTool(
        { name: 'hub_agent_wait', arguments: { task_id: 'tsk_abc123', timeout_seconds: 0 } },
        undefined,
        { signal: controle.signal },
      )
      .catch((err: unknown) => err);
    await primeira;

    // Controle positivo: sem cancelar, o relógio falso governa o backoff e o
    // laço consulta de novo — prova que o silêncio lá embaixo não é de graça.
    const segunda = proximaConsulta();
    await drenar(); // o laço agenda o backoff depois da consulta; o tick tem de vir depois
    t.mock.timers.tick(1500);
    await segunda;
    assert.equal(consultas, 2);

    controle.abort();
    await chamada;
    await drenar();
    const noCancelamento = consultas;

    // Sem a correção, o laço segue consultando (2,1 s, 2,9 s, ...) para sempre.
    for (let i = 0; i < 12; i += 1) {
      t.mock.timers.tick(10_000);
      await drenar();
    }
    assert.equal(consultas, noCancelamento, 'consultas depois do cancelamento');
  });
});

/**
 * `hub_agent_call` aceitava objetivo de 2 milhões de caracteres (achado 11).
 * Servidor HTTP falso que conta as requisições.
 */
describe('MCP: limites do hub_agent_call', () => {
  let fake: HttpServer;
  let client: Client;
  const recebidos: string[] = [];

  before(async () => {
    fake = createHttpServer((req, res) => {
      recebidos.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            task: { id: 'tsk_abc123', state: 'working', attempts: [], result: null },
            session: null,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const endereco = fake.address();
    const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
    const hubClient = new HubClient(`http://127.0.0.1:${porta}`);
    const caller = new CallerIdentity(hubClient, 'agente-mcp', os.tmpdir(), 'ses_chamador1');
    const server = buildMcpServer(hubClient, caller);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'teste-wait', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client.close();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });

  test('hub_agent_call recusa objetivo gigante sem chegar ao daemon', async () => {
    recebidos.length = 0;
    const resultado = (await client
      .callTool({
        name: 'hub_agent_call',
        arguments: { agent: 'codex', objective: 'x'.repeat(2_000_000) },
      })
      .catch((err: unknown) => ({
        content: [{ type: 'text', text: String(err) }],
        isError: true,
      }))) as ToolTextResult;
    assert.equal(resultado.isError, true);
    assert.match(textOf(resultado), /objetivo acima de|too_big|20000/i);
    assert.deepEqual(recebidos, []);
  });

  test('hub_agent_call recusa artefato fora do projeto e listas enormes', async () => {
    recebidos.length = 0;
    for (const args of [
      { artifacts: [{ path: '../../../etc/passwd', mode: 'write' }] },
      { artifacts: [{ path: 'C:\\Windows\\system32\\drivers\\etc\\hosts' }] },
      { constraints: Array.from({ length: 51 }, (_, i) => `restrição ${i}`) },
      { acceptance_criteria: ['y'.repeat(2001)] },
    ]) {
      const resultado = (await client
        .callTool({
          name: 'hub_agent_call',
          arguments: { agent: 'codex', objective: 'objetivo curto e válido', ...args },
        })
        .catch((err: unknown) => ({
          content: [{ type: 'text', text: String(err) }],
          isError: true,
        }))) as ToolTextResult;
      assert.equal(resultado.isError, true, `deveria recusar ${JSON.stringify(args).slice(0, 80)}`);
    }
    assert.deepEqual(recebidos, []);
  });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { newId, nowIso, type Session } from '@agents-hub/core';
import { createHub, type Hub } from '@agents-hub/daemon';
import { HubClient } from '@agents-hub/client';
import { CallerIdentity } from './caller.js';
import { buildMcpServer } from './server.js';

interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function textOf(result: unknown): string {
  const r = result as ToolTextResult;
  return r.content.map((c) => c.text).join('\n');
}

/**
 * As duas ferramentas novas do audit de consistência: `hub_session_pause`
 * (rota HTTP e client já existiam, nenhuma superfície MCP expunha) e
 * `hub_workflow_run` (o motor de workflow só era acionável pela CLI). Os dois
 * testes rodam contra um daemon real — via `InMemoryTransport`, sem stdio —
 * porque é o daemon quem decide os desfechos que importam (estado terminal,
 * validação do workflow, orquestração de passos).
 */
describe('MCP: hub_session_pause e hub_workflow_run', () => {
  let hub: Hub;
  let raiz: string;
  let client: Client;
  let hubClient: HubClient;
  let projectId: string;
  let projetoPath: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-'));
    const manifestos = path.join(raiz, 'manifests');
    projetoPath = path.join(raiz, 'projeto');
    mkdirSync(manifestos, { recursive: true });
    mkdirSync(projetoPath, { recursive: true });

    const script = path.join(raiz, 'agente.cjs');
    writeFileSync(
      script,
      `
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
process.stdout.write('AGENTE OK\\n');
process.exit(0);
`,
      'utf8',
    );
    writeFileSync(
      path.join(manifestos, 'agente-mcp.yaml'),
      `
id: agente-mcp
name: agente-mcp
vendor: Test
description: Agente de teste para as tools de MCP
bin: node
invoke:
  oneShot: ["${script.replace(/\\/g, '\\\\')}"]
  interactive: false
detect:
  args: ["${script.replace(/\\/g, '\\\\')}", "--version"]
capabilities:
  - code-edit
caveats:
  - "${'primeira limitação comprida '.repeat(12)}"
  - "LIMITACAO-SEGUNDA-SO-NO-VERBOSE"
session:
  strategy: replay
stream:
  format: text
  mapper: generic-text
defaults:
  isolation: none
  timeoutSeconds: 30
`,
      'utf8',
    );

    hub = createHub({
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      port: 0,
    });
    const { host, port } = await hub.start();
    hubClient = new HubClient(`http://${host}:${port}`);
    projectId = hub.sessions.registerProject(projetoPath, 'Projeto MCP').id;

    // Chamador real: as tools só alcançam o fluxo dele (vistoria 08, achado 14),
    // então as sessões semeadas abaixo nascem como filhas desta raiz.
    raizDoChamador = semear({ raiz: true });
    const caller = new CallerIdentity(hubClient, 'agente-mcp', projetoPath, raizDoChamador.id);
    const server = buildMcpServer(hubClient, caller);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'teste', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client.close();
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  let raizDoChamador: Session;

  /**
   * Semeia uma sessão. Por padrão, filha de `pai` (a raiz do chamador); com
   * `raiz: true`, raiz de um fluxo novo — outro fluxo, do ponto de vista do
   * chamador.
   */
  function semear(
    o: { raiz?: boolean; pai?: Session; state?: Session['state']; title?: string } = {},
  ): Session {
    const id = newId('ses');
    const pai = o.raiz ? null : (o.pai ?? raizDoChamador);
    const session: Session = {
      id,
      projectId,
      agentId: 'agente-mcp',
      parentId: pai?.id ?? null,
      rootId: pai?.rootId ?? id,
      depth: pai ? pai.depth + 1 : 0,
      path: [...(pai?.path ?? []), `agente-mcp:${id}`],
      state: o.state ?? 'running',
      mode: 'semi',
      isolation: 'none',
      workdir: projetoPath,
      nativeSessionId: null,
      title: o.title ?? 'sessão de teste do MCP',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: o.state && o.state !== 'running' ? nowIso() : null,
      pid: null,
    };
    hub.store.sessions.create(session);
    return session;
  }

  const semearRodando = (): Session => semear();

  test('hub_session_pause pausa uma sessão rodando', async () => {
    const session = semearRodando();

    const result = await client.callTool({
      name: 'hub_session_pause',
      arguments: { session_id: session.id },
    });

    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /pausada/);
    assert.equal(hub.store.sessions.get(session.id)?.state, 'paused');
  });

  test('hub_session_pause devolve erro descritivo para sessão já terminada', async () => {
    const { id } = semear({ state: 'completed', title: 'sessão já concluída' });

    const result = await client.callTool({
      name: 'hub_session_pause',
      arguments: { session_id: id },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /já terminou/i);
    assert.equal(hub.store.sessions.get(id)?.state, 'completed');
  });

  test('hub_workflow_run recusa YAML inválido sem despachar nenhuma sessão', async () => {
    const antes = hub.store.sessions.list().length;

    const result = await client.callTool({
      name: 'hub_workflow_run',
      arguments: {
        yaml: 'name: workflow-quebrado\nsteps: []\n',
        project: projetoPath,
      },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /inválido/i);
    assert.equal(hub.store.sessions.list().length, antes, 'não deveria ter criado nenhuma sessão');
  });

  test(
    'hub_workflow_run executa um workflow de um passo só até o fim',
    { timeout: 30_000 },
    async () => {
      const yaml = `
name: workflow-de-um-passo
steps:
  - id: unico
    agent: agente-mcp
    objective: "Fazer a única coisa que este workflow pede, de ponta a ponta"
    isolation: none
`;

      const result = await client.callTool({
        name: 'hub_workflow_run',
        arguments: { yaml, project: projetoPath },
      });

      const texto = textOf(result);
      assert.equal(result.isError, undefined, texto);
      assert.match(texto, /workflow "workflow-de-um-passo"/);
      assert.match(texto, /1\/1 passos concluídos/);
      assert.match(texto, /unico \(agente-mcp\): ok/);
    },
  );

  test(
    'hub_workflow_run: passo dependente em worktree recebe baseSessionIds da dependência',
    { timeout: 30_000 },
    async () => {
      // Demo ampliada (8.3): o passo seguinte precisa partir do branch
      // `hub/<id>` do anterior. Espia o que o MCP manda ao daemon.
      const repo = path.join(raiz, 'repo-workflow');
      mkdirSync(repo, { recursive: true });
      const git = (...args: string[]): void => {
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@l', '-c', 'commit.gpgsign=false', ...args],
          {
            cwd: repo,
          },
        );
      };
      git('init', '-q');
      writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');

      const enviados: Array<{ baseSessionIds: string[] | undefined; sessao: string }> = [];
      const original = hubClient.startSession.bind(hubClient);
      hubClient.startSession = async (body) => {
        const res = await original(body);
        enviados.push({ baseSessionIds: body.baseSessionIds, sessao: res.session.id });
        return res;
      };
      try {
        const yaml = `
name: dois-passos-worktree
steps:
  - id: plano
    agent: agente-mcp
    objective: "Escrever o plano de ponta a ponta para o passo seguinte"
    isolation: worktree
  - id: execucao
    agent: agente-mcp
    objective: "Executar o plano escrito pelo passo anterior, sem desviar"
    isolation: worktree
    dependsOn: [plano]
`;
        const result = await client.callTool({
          name: 'hub_workflow_run',
          arguments: { yaml, project: repo },
        });
        assert.equal(enviados.length, 2, textOf(result));
        assert.equal(enviados[0]?.baseSessionIds, undefined);
        assert.deepEqual(enviados[1]?.baseSessionIds, [enviados[0]?.sessao]);
      } finally {
        hubClient.startSession = original;
      }
    },
  );

  test('hub_agent_call com brief inválido devolve o campo e a mensagem, não só o código genérico', async () => {
    // `hub_agent_call` delega a partir da sessão do CHAMADOR (resolvida por
    // `caller.resolve()`), e a fixture principal usa um id de sessão fixo que
    // não bate o formato "ses_..." exigido pela rota — então este teste monta
    // seu próprio par cliente/servidor MCP com uma sessão real semeada como
    // chamadora, só para isolar o comportamento de `hub_agent_call`.
    const sessaoChamadora = semearRodando();
    const callerReal = new CallerIdentity(hubClient, 'agente-mcp', projetoPath, sessaoChamadora.id);
    const serverReal = buildMcpServer(hubClient, callerReal);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const clientReal = new Client({ name: 'teste-brief-invalido', version: '0.0.1' });
    await Promise.all([serverReal.connect(serverTransport), clientReal.connect(clientTransport)]);

    try {
      // `agent: ""` passa pelo schema da tool MCP (que não exige mínimo), mas é
      // rejeitado pelo `BriefSchema` do daemon (`agent: z.string().min(1)`) —
      // exatamente o caso do Achado 1: sem a correção, o agente chamador só via
      // "INVALID_BRIEF: Brief inválido" e nunca descobria qual campo falhou.
      const result = await clientReal.callTool({
        name: 'hub_agent_call',
        arguments: { agent: '', objective: 'objetivo longo o suficiente para passar' },
      });

      assert.equal(result.isError, true);
      const texto = textOf(result);
      assert.match(texto, /INVALID_BRIEF/);
      assert.match(texto, /campos inválidos/i);
      assert.match(texto, /agent:/);
    } finally {
      await clientReal.close();
    }
  });

  test('hub_session_interrupt interrompe o turno sem encerrar a sessão', async () => {
    const session = semearRodando();

    const result = await client.callTool({
      name: 'hub_session_interrupt',
      arguments: { session_id: session.id },
    });

    assert.equal(result.isError, undefined, textOf(result));
    // Sem turno nativo em andamento no fake do teste, `interrupted` vem
    // `false` — o texto precisa dizer isso, e a sessão precisa continuar viva
    // (diferente de hub_agent_cancel).
    assert.match(textOf(result), /não tinha turno em andamento/);
    assert.equal(hub.store.sessions.get(session.id)?.state, 'running');
  });

  test('hub_session_interrupt devolve erro descritivo para sessão inexistente', async () => {
    // Formato válido (bate o regex de `SessionIdSchema`) mas nenhuma sessão
    // criada com este id — é o `SESSION_NOT_FOUND` do domínio, não um 422 de
    // borda por id malformado.
    const result = await client.callTool({
      name: 'hub_session_interrupt',
      arguments: { session_id: 'ses_naoexiste000' },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /SESSION_NOT_FOUND|não encontrada|not found/i);
  });

  test('hub_session_diff avisa quando a sessão não alterou nenhum arquivo', async () => {
    const session = semearRodando();

    const result = await client.callTool({
      name: 'hub_session_diff',
      arguments: { session_id: session.id },
    });

    assert.equal(result.isError, undefined, textOf(result));
    assert.match(textOf(result), /não alterou nenhum arquivo/i);
  });

  test('hub_session_diff devolve o patch quando há um diff capturado', async () => {
    const session = semearRodando();
    const diffPath = path.join(raiz, `${session.id}.diff`);
    const patch = [
      'diff --git a/foo.txt b/foo.txt',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1 +1 @@',
      '-antes',
      '+depois',
      '',
    ].join('\n');
    writeFileSync(diffPath, patch, 'utf8');
    hub.store.artifacts.create({
      id: newId('art'),
      sessionId: session.id,
      taskId: null,
      kind: 'diff',
      path: diffPath,
      hash: null,
      createdAt: nowIso(),
    });

    const result = await client.callTool({
      name: 'hub_session_diff',
      arguments: { session_id: session.id },
    });

    assert.equal(result.isError, undefined, textOf(result));
    assert.match(textOf(result), /diff --git a\/foo\.txt/);
    assert.match(textOf(result), /\+depois/);
  });

  test('hub_session_diff para sessão inexistente devolve SESSION_NOT_FOUND', async () => {
    // A rota `/sessions/:id/diff` do daemon não checa se a sessão existe; o
    // escopo por fluxo (achado 14) lê a sessão antes, e daí vem o erro claro
    // em vez de "não alterou nenhum arquivo" sobre coisa nenhuma.
    const result = await client.callTool({
      name: 'hub_session_diff',
      arguments: { session_id: 'ses_naoexiste000' },
    });

    assert.equal(result.isError, true, textOf(result));
    assert.match(textOf(result), /SESSION_NOT_FOUND|não encontrada/i);
  });

  // ------------------------------------------------ escopo por fluxo (achado 14)

  test('escopo: tools recusam sessão de OUTRO fluxo, sem efeito nela', async () => {
    const outraRaiz = semear({ raiz: true, title: 'SEGREDO-DE-OUTRO-PROJETO' });
    const outraFilha = semear({ pai: outraRaiz });

    const chamadas: Array<[string, Record<string, unknown>]> = [
      ['hub_agent_cancel', { session_id: outraFilha.id }],
      ['hub_session_pause', { session_id: outraFilha.id }],
      ['hub_session_interrupt', { session_id: outraFilha.id }],
      ['hub_session_send', { session_id: outraFilha.id, text: 'oi' }],
      ['hub_session_handoff', { session_id: outraFilha.id, target_agent: 'agente-mcp' }],
      ['hub_agent_events', { session_id: outraFilha.id }],
      ['hub_session_diff', { session_id: outraFilha.id }],
      ['hub_graph', { root_id: outraRaiz.id }],
      ['hub_budget', { root_id: outraRaiz.id }],
      ['hub_context_fetch', { ref: `session:${outraFilha.id}` }],
    ];
    for (const [nome, args] of chamadas) {
      const result = await client.callTool({ name: nome, arguments: args });
      assert.equal(result.isError, true, `${nome} deveria recusar, veio: ${textOf(result)}`);
      assert.match(textOf(result), /OUT_OF_FLOW/, nome);
      assert.doesNotMatch(textOf(result), /SEGREDO/, nome);
    }
    assert.equal(hub.store.sessions.get(outraFilha.id)?.state, 'running');
  });

  test('escopo: hub_session_list mostra só o fluxo do chamador', async () => {
    semear({ raiz: true, title: 'SEGREDO-LISTADO-DE-OUTRO-FLUXO' });
    const minha = semear({ title: 'filha-visivel-do-chamador' });

    const texto = textOf(await client.callTool({ name: 'hub_session_list', arguments: {} }));
    assert.match(texto, new RegExp(minha.id));
    assert.doesNotMatch(texto, /SEGREDO-LISTADO/);
  });

  test('escopo: hub_session_list avisa quando corta a lista', async () => {
    const pai = semear({ title: 'pai-com-muitos-filhos' });
    for (let i = 0; i < 45; i += 1) semear({ pai, state: 'completed' });

    const texto = textOf(await client.callTool({ name: 'hub_session_list', arguments: {} }));
    assert.match(texto, /mais \d+ sessões não mostradas/);
  });

  test('escopo: agente delegado controla só o que está ABAIXO dele, lê o fluxo todo', async () => {
    const eu = semear({ title: 'agente delegado' });
    const irmao = semear({ title: 'irmão' });
    const neto = semear({ pai: semear({ pai: eu }) });

    const callerFilho = new CallerIdentity(hubClient, 'agente-mcp', projetoPath, eu.id);
    const [st, ct] = InMemoryTransport.createLinkedPair();
    const clienteFilho = new Client({ name: 'teste-escopo-filho', version: '0.0.1' });
    await Promise.all([buildMcpServer(hubClient, callerFilho).connect(st), clienteFilho.connect(ct)]);
    try {
      for (const alvo of [raizDoChamador, irmao, eu]) {
        const r = await clienteFilho.callTool({
          name: 'hub_agent_cancel',
          arguments: { session_id: alvo.id },
        });
        assert.equal(r.isError, true, `cancelar ${alvo.title} deveria ser recusado: ${textOf(r)}`);
        assert.match(textOf(r), /não está abaixo de você/);
        assert.equal(hub.store.sessions.get(alvo.id)?.state, 'running');
      }

      // Ler o irmão (mesmo fluxo) continua permitido.
      const leitura = await clienteFilho.callTool({
        name: 'hub_agent_events',
        arguments: { session_id: irmao.id },
      });
      assert.equal(leitura.isError, undefined, textOf(leitura));

      // O neto foi delegado (indiretamente) por ele: pode pausar.
      const pausa = await clienteFilho.callTool({
        name: 'hub_session_pause',
        arguments: { session_id: neto.id },
      });
      assert.equal(pausa.isError, undefined, textOf(pausa));
      assert.equal(hub.store.sessions.get(neto.id)?.state, 'paused');
    } finally {
      await clienteFilho.close();
    }
  });

  // --------------------------------------- hub_workflow_run (achado 15)

  test('hub_workflow_run recusa path fora do projeto sem ler nem ecoar o arquivo', async () => {
    const fora = path.join(raiz, 'segredo.yaml');
    writeFileSync(fora, 'token: CONTEUDO-SECRETO-QUE-NAO-PODE-VOLTAR\n', 'utf8');
    for (const p of [fora, '../segredo.yaml', path.join(raiz, 'manifests', 'agente-mcp.yaml')]) {
      const result = await client.callTool({
        name: 'hub_workflow_run',
        arguments: { path: p, project: projetoPath },
      });
      assert.equal(result.isError, true, textOf(result));
      assert.match(textOf(result), /dentro do projeto/);
      assert.doesNotMatch(textOf(result), /CONTEUDO-SECRETO|agente-mcp\.yaml.*bin/);
    }
  });

  test('hub_workflow_run: YAML quebrado diz a linha, sem ecoar o trecho', async () => {
    const arquivo = path.join(projetoPath, 'quebrado.yaml');
    writeFileSync(arquivo, 'name: x\nsteps: [TRECHO-ECOADO-bad: [unclosed\n', 'utf8');
    const result = await client.callTool({
      name: 'hub_workflow_run',
      arguments: { path: 'quebrado.yaml', project: projetoPath },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /YAML malformado na linha \d+/);
    assert.doesNotMatch(textOf(result), /TRECHO-ECOADO|unclosed/);
  });

  test('hub_workflow_run: workflow fora do esquema diz QUAL campo falhou', async () => {
    const result = await client.callTool({
      name: 'hub_workflow_run',
      arguments: { yaml: 'not: a workflow\n', project: projetoPath },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /campos inválidos/);
    assert.match(textOf(result), /- name:/);
    assert.match(textOf(result), /- steps:/);
  });

  test(
    'hub_workflow_run: quem rodou acompanha os passos (raízes próprias) pelas tools',
    { timeout: 30_000 },
    async () => {
      const yaml = `
name: workflow-acompanhado
steps:
  - id: passo
    agent: agente-mcp
    objective: "Fazer a coisa do passo para o teste de escopo do workflow"
    isolation: none
`;
      const texto = textOf(
        await client.callTool({ name: 'hub_workflow_run', arguments: { yaml, project: projetoPath } }),
      );
      const sessao = /\[sessão (ses_[a-z0-9]+)\]/i.exec(texto)?.[1];
      assert.ok(sessao, texto);
      const eventos = await client.callTool({
        name: 'hub_agent_events',
        arguments: { session_id: sessao },
      });
      assert.equal(eventos.isError, undefined, textOf(eventos));
    },
  );

  // ------------------------------------------------ saídas enxutas (achado 16)

  test('hub_agent_list resume limitações por padrão e mostra tudo com verbose', async () => {
    // Os caveats vêm do manifesto de teste (ver `before`).
    const curto = textOf(await client.callTool({ name: 'hub_agent_list', arguments: {} }));
    assert.doesNotMatch(curto, /LIMITACAO-SEGUNDA/);
    assert.match(curto, /\(\+1; verbose: true para ver\)/);
    const longo = textOf(
      await client.callTool({ name: 'hub_agent_list', arguments: { verbose: true } }),
    );
    assert.match(longo, /LIMITACAO-SEGUNDA-SO-NO-VERBOSE/);
    assert.ok(curto.length < longo.length);
  });
});

/**
 * Path traversal pelo argumento da tool (vistoria 08, seção 1): o client
 * montava `/sessions/${id}/cancel` sem validar nem codificar, e
 * `session_id: "../shutdown#"` resolvia para `POST /shutdown` — o daemon caía e
 * a tool respondia "sessão encerrada". Roda contra um servidor HTTP falso que
 * registra os caminhos, justamente para o teste vermelho não derrubar nada.
 */
describe('MCP: id malformado em argumento de tool', () => {
  let fake: HttpServer;
  let client: Client;
  const recebidos: string[] = [];
  const chamador = newId('ses');
  let modoDoSend = 'live';

  /** Sessão falsa: a do chamador é raiz; qualquer outra é filha dela. */
  const sessaoFalsa = (id: string): Record<string, unknown> => ({
    id,
    rootId: chamador,
    parentId: id === chamador ? null : chamador,
    agentId: 'agente-mcp',
    state: 'running',
    depth: id === chamador ? 0 : 1,
  });

  before(async () => {
    fake = createHttpServer((req, res) => {
      recebidos.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const url = new URL(req.url ?? '/', 'http://x');
        const sessao = /^\/sessions\/(ses_[a-z0-9]+)$/i.exec(url.pathname);
        if (req.method === 'GET' && sessao) {
          res.end(JSON.stringify({ session: sessaoFalsa(sessao[1] as string), live: true }));
        } else if (req.method === 'GET' && url.pathname === '/sessions') {
          res.end(JSON.stringify({ sessions: [sessaoFalsa(chamador), sessaoFalsa('ses_abc123')] }));
        } else {
          res.end(JSON.stringify({ ok: true, interrupted: false, mode: modoDoSend }));
        }
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const endereco = fake.address();
    const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
    const hubClient = new HubClient(`http://127.0.0.1:${porta}`);
    const caller = new CallerIdentity(hubClient, 'agente-mcp', os.tmpdir(), chamador);
    const server = buildMcpServer(hubClient, caller);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'teste-traversal', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client.close();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });

  /** O SDK pode recusar a entrada como resultado `isError` ou como exceção. */
  async function chamar(name: string, args: Record<string, unknown>): Promise<ToolTextResult> {
    try {
      return (await client.callTool({ name, arguments: args })) as ToolTextResult;
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  }

  test('hub_agent_cancel com session_id="../shutdown#" devolve erro e não chega a /shutdown', async () => {
    recebidos.length = 0;
    const result = await chamar('hub_agent_cancel', { session_id: '../shutdown#' });
    assert.equal(result.isError, true, `deveria falhar, veio: ${textOf(result)}`);
    assert.doesNotMatch(textOf(result), /encerrada/);
    assert.deepEqual(recebidos, [], 'nenhuma requisição deveria ter saído');
  });

  test('todas as tools com id recusam traversal sem requisição', async () => {
    recebidos.length = 0;
    const chamadas: Array<[string, Record<string, unknown>]> = [
      ['hub_agent_status', { task_id: '../shutdown#' }],
      ['hub_agent_wait', { task_id: '../shutdown#', timeout_seconds: 1 }],
      ['hub_agent_events', { session_id: '../shutdown#' }],
      ['hub_session_diff', { session_id: '../shutdown#' }],
      ['hub_session_interrupt', { session_id: '../shutdown#' }],
      ['hub_session_pause', { session_id: '../shutdown#' }],
      ['hub_session_send', { session_id: '../shutdown#', text: 'oi' }],
      ['hub_session_handoff', { session_id: '../shutdown#', target_agent: 'codex' }],
      ['hub_graph', { root_id: '../shutdown#' }],
      ['hub_budget', { root_id: '../shutdown#' }],
    ];
    const { tools } = await client.listTools();
    const existentes = new Set(tools.map((t) => t.name));
    for (const [nome, args] of chamadas) {
      assert.ok(existentes.has(nome), `tool ${nome} não existe — ajuste o teste`);
      const result = await chamar(nome, args);
      assert.equal(result.isError, true, `${nome} deveria falhar, veio: ${textOf(result)}`);
    }
    assert.deepEqual(recebidos, []);
  });

  test('id válido segue normalmente até o daemon', async () => {
    recebidos.length = 0;
    const result = await chamar('hub_agent_cancel', { session_id: 'ses_abc123' });
    assert.equal(result.isError, undefined, textOf(result));
    // Antes do cancel, o escopo lê a sessão (e o fluxo) — só GETs.
    assert.equal(recebidos.at(-1), 'POST /sessions/ses_abc123/cancel');
    assert.ok(
      recebidos.slice(0, -1).every((r) => r.startsWith('GET /sessions')),
      recebidos.join(', '),
    );
  });

  test('hub_session_send com modo desconhecido não responde "undefined" (achado 16)', async () => {
    modoDoSend = 'modo-futuro';
    try {
      const result = await chamar('hub_session_send', { session_id: 'ses_abc123', text: 'oi' });
      assert.equal(result.isError, undefined, textOf(result));
      assert.doesNotMatch(textOf(result), /undefined/);
      assert.match(textOf(result), /modo-futuro/);
    } finally {
      modoDoSend = 'live';
    }
  });
});

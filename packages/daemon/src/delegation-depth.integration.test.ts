import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_POLICY, HubError, rollupCost, type GraphNode } from '@agents-hub/core';
import { esperarAte } from './esperar-ate.js';
import { createHub, type Hub } from './hub.js';

/**
 * Integração da delegação em profundidade com agentes FALSOS (custo zero).
 *
 * Cada agente falso emite UM evento `result` no formato do Claude (com custo e
 * tokens conhecidos) e então fica vivo até ser cancelado. Ficar vivo importa:
 * o Hub recusa delegar a partir de sessão terminal, e a cadeia A→B→C precisa de
 * pais vivos.
 */

const AGENTE_FALSO = `
if (process.argv.includes('--version')) {
  process.stdout.write('9.9.9\\n');
  process.exit(0);
}
const usd = Number(process.env.FAKE_USD || 0);
const tokens = Number(process.env.FAKE_TOKENS || 0);
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'ok',
  total_cost_usd: usd,
  usage: { input_tokens: tokens, output_tokens: 0 },
}) + '\\n');
// Vivo até o teste cancelar; o timer evita que o processo vire órfão para sempre.
setTimeout(() => process.exit(0), 60000);
setInterval(() => {}, 1000);
`;

// Custo por agente, distinto em cada um para a soma só bater se todos entrarem.
const CUSTOS: Record<string, { usd: number; tokens: number }> = {
  a: { usd: 0.25, tokens: 1000 },
  b: { usd: 0.5, tokens: 2000 },
  c: { usd: 1, tokens: 4000 },
  d: { usd: 2, tokens: 8000 },
  e: { usd: 4, tokens: 16000 },
};

const MAX_DEPTH = 3;

interface Ambiente {
  hub: Hub;
  raiz: string;
  projetoId: string;
}

function esc(p: string): string {
  return p.replaceAll('\\', '\\\\');
}

function montarAmbiente(): Ambiente {
  const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-profundidade-'));
  const manifestos = path.join(raiz, 'manifests');
  const projeto = path.join(raiz, 'projeto');
  const script = path.join(raiz, 'agente-falso.cjs');
  for (const dir of [manifestos, projeto]) mkdirSync(dir, { recursive: true });
  writeFileSync(script, AGENTE_FALSO, 'utf8');

  for (const [id, custo] of Object.entries(CUSTOS)) {
    writeFileSync(
      path.join(manifestos, `${id}.yaml`),
      [
        `id: ${id}`,
        `name: Agente falso ${id}`,
        'bin: node',
        'detect:',
        `  args: ["${esc(script)}", "--version"]`,
        'invoke:',
        `  oneShot: ["${esc(script)}"]`,
        '  stdinPrompt: true',
        '  env:',
        `    FAKE_USD: "${custo.usd}"`,
        `    FAKE_TOKENS: "${custo.tokens}"`,
        'session:',
        '  strategy: replay',
        'stream:',
        '  format: jsonl',
        '  mapper: claude',
        'capabilities: [tarefa-falsa]',
        'defaults:',
        '  isolation: none',
        '  timeoutSeconds: 60',
        // O padrão é o mais permissivo de propósito: se a herança quebrar, o
        // filho enxerga "autonomous" e o teste de supervisão fica vermelho.
        '  supervision: autonomous',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  const hub = createHub({
    home: raiz,
    manifestsDir: manifestos,
    webRoot: path.join(raiz, 'sem-web'),
    policy: {
      ...DEFAULT_POLICY,
      maxDepth: MAX_DEPTH,
      maxConcurrency: 20,
      maxConcurrencyPerAgent: 20,
      watch: { pauseOn: [], flagOn: [] },
    },
  });
  const projetoId = hub.sessions.registerProject(projeto, 'projeto-falso').id;
  return { hub, raiz, projetoId };
}

function achatar(nos: GraphNode[]): GraphNode[] {
  return nos.flatMap((n) => [n, ...achatar(n.children)]);
}

async function codigoDoErro(promessa: Promise<unknown>): Promise<HubError> {
  try {
    await promessa;
  } catch (err) {
    assert.ok(err instanceof HubError, `esperava HubError, veio ${String(err)}`);
    return err;
  }
  throw new assert.AssertionError({ message: 'a delegação deveria ter sido rejeitada' });
}

describe('delegação em profundidade (agentes falsos)', () => {
  let amb: Ambiente;
  const raizesAbertas: string[] = [];

  before(() => {
    amb = montarAmbiente();
  });

  after(async () => {
    await amb.hub.shutdown();
    try {
      rmSync(amb.raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  /** Cada teste abre o seu fluxo e o cancela no fim, liberando os processos. */
  async function abrirRaiz(agent: string, objective: string, supervision?: 'semi' | 'supervised') {
    const { session } = await amb.hub.sessions.start({
      projectId: amb.projetoId,
      agentId: '',
      brief: { agent, objective, isolation: 'none', ...(supervision ? { supervision } : {}) },
    });
    raizesAbertas.push(session.id);
    return session;
  }

  function delegar(
    pai: string,
    agent: string,
    objective: string,
    supervision?: 'semi' | 'supervised' | 'autonomous',
  ) {
    return amb.hub.sessions.start({
      projectId: amb.projetoId,
      agentId: '',
      requesterSessionId: pai,
      brief: { agent, objective, isolation: 'none', ...(supervision ? { supervision } : {}) },
    });
  }

  async function encerrar(rootId: string): Promise<void> {
    await amb.hub.sessions.cancel(rootId, 'fim do teste');
  }

  test('A→B→C: profundidade 2 funciona, grafo mostra a cadeia e o custo consolida na raiz', async () => {
    const a = await abrirRaiz('a', 'objetivo-cadeia', 'semi');
    try {
      const b = (await delegar(a.id, 'b', 'sub-b-cadeia')).session;
      const c = (await delegar(b.id, 'c', 'sub-c-cadeia')).session;

      assert.deepEqual([a.depth, b.depth, c.depth], [0, 1, 2]);
      assert.equal(b.parentId, a.id);
      assert.equal(c.parentId, b.id);
      assert.equal(b.rootId, a.id);
      assert.equal(c.rootId, a.id, 'neto pertence ao mesmo fluxo da raiz');

      // Grafo: uma árvore só, A→B→C.
      const grafo = amb.hub.sessions.graph(a.id);
      assert.equal(grafo.length, 1);
      const raiz = grafo[0];
      assert.ok(raiz);
      assert.equal(raiz.agentId, 'a');
      assert.equal(raiz.children.length, 1);
      assert.equal(raiz.children[0]?.agentId, 'b');
      assert.equal(raiz.children[0]?.children.length, 1);
      assert.equal(raiz.children[0]?.children[0]?.agentId, 'c');
      assert.equal(raiz.children[0]?.children[0]?.children.length, 0);

      // Custo: os eventos chegam de forma assíncrona; espera o livro-caixa da
      // RAIZ enxergar os três agentes (1000 + 2000 + 4000 tokens).
      const esperado = CUSTOS['a']!.tokens + CUSTOS['b']!.tokens + CUSTOS['c']!.tokens;
      await esperarAte(
        () => amb.hub.sessions.budget(a.id).consumed.tokens >= esperado,
        'custo dos três agentes consolidado na raiz',
      );

      const orcamento = amb.hub.sessions.budget(a.id);
      assert.equal(orcamento.consumed.tokens, esperado);
      assert.ok(Math.abs(orcamento.consumed.usd - (0.25 + 0.5 + 1)) < 1e-9);

      // O rollup do grafo (fonte independente: eventos no banco) concorda com o
      // livro-caixa, e cada nível carrega só o custo do próprio agente.
      const total = rollupCost(amb.hub.sessions.graph(a.id)[0]!);
      assert.equal(total.tokens, esperado);
      assert.ok(Math.abs(total.usd - 1.75) < 1e-9);
      const porAgente = new Map(achatar(amb.hub.sessions.graph(a.id)).map((n) => [n.agentId, n]));
      assert.equal(porAgente.get('a')?.tokens, 1000);
      assert.equal(porAgente.get('c')?.tokens, 4000);
    } finally {
      await encerrar(a.id);
    }
  });

  test('herança de supervisão: filho e neto nunca afrouxam o modo do pai', async () => {
    // A: manifesto autonomous, mas o Brief da raiz estreita para semi.
    const a = await abrirRaiz('a', 'objetivo-modo', 'semi');
    try {
      assert.equal(a.mode, 'semi');

      // B pede autonomous (mais solto que o pai) E o manifesto dele também é
      // autonomous: mesmo assim tem de ficar em semi.
      const b = (await delegar(a.id, 'b', 'sub-b-modo', 'autonomous')).session;
      assert.equal(b.mode, 'semi', 'pedir autonomous não afrouxa o pai semi');

      // Sem pedir nada, herda o do pai — não o default do manifesto (autonomous).
      const c = (await delegar(b.id, 'c', 'sub-c-modo')).session;
      assert.equal(c.mode, 'semi', 'neto herda o modo do pai, não o default do manifesto');

      // Endurecer é permitido: o filho pode pedir mais supervisão.
      const d = (await delegar(c.id, 'd', 'sub-d-modo', 'supervised')).session;
      assert.equal(d.mode, 'supervised', 'filho pode pedir supervisão MAIS estrita');
    } finally {
      await encerrar(a.id);
    }
  });

  test('pai supervised não delega sem aprovação: o filho nasce retido, sem processo', async () => {
    const a = await abrirRaiz('a', 'objetivo-supervisionado', 'supervised');
    try {
      assert.equal(a.mode, 'supervised');
      const r = await delegar(a.id, 'b', 'sub-b-supervisionado');

      assert.ok(r.approval, 'delegação de sessão supervisionada exige aprovação');
      assert.equal(r.session.state, 'waiting_approval');
      assert.equal(r.session.mode, 'supervised', 'o filho retido também é supervisionado');
      assert.equal(
        amb.hub.sessions.isLive(r.session.id),
        false,
        'nenhum processo subiu antes da aprovação',
      );
    } finally {
      await encerrar(a.id);
    }
  });

  test('ciclo semântico: C delegar de volta a A (mesmo agente e objetivo) é rejeitado', async () => {
    const objetivoRaiz = 'objetivo-ciclo';
    const a = await abrirRaiz('a', objetivoRaiz, 'semi');
    try {
      const b = (await delegar(a.id, 'b', 'sub-b-ciclo')).session;
      const c = (await delegar(b.id, 'c', 'sub-c-ciclo')).session;
      const antes = achatar(amb.hub.sessions.graph(a.id)).length;
      assert.equal(antes, 3);

      // depth 3 == maxDepth: só o ciclo pode barrar. Se a checagem de ciclo
      // for removida, esta delegação passa e o teste fica vermelho.
      const erro = await codigoDoErro(delegar(c.id, 'a', objetivoRaiz));
      assert.equal(erro.code, 'CYCLE_DETECTED');
      assert.match(erro.message, /Ciclo detectado/);
      assert.match(erro.message, /\ba\b/);

      // Rejeição limpa: nenhuma sessão nova e nada reservado no orçamento.
      assert.equal(achatar(amb.hub.sessions.graph(a.id)).length, antes);

      // A regra é SEMÂNTICA: o mesmo agente com OUTRO objetivo é trabalho novo
      // e passa (controle contra uma regra que barrasse qualquer volta a `a`).
      const ok = await delegar(c.id, 'a', 'objetivo-diferente');
      assert.equal(ok.session.agentId, 'a');
      assert.equal(ok.session.depth, 3);
    } finally {
      await encerrar(a.id);
    }
  });

  test('estouro de maxDepth: a delegação além do teto é rejeitada com DEPTH_EXCEEDED', async () => {
    const a = await abrirRaiz('a', 'objetivo-profundo', 'semi');
    try {
      const b = (await delegar(a.id, 'b', 'nivel-um')).session;
      const c = (await delegar(b.id, 'c', 'nivel-dois')).session;
      const d = (await delegar(c.id, 'd', 'nivel-tres')).session; // depth 3 == teto: cabe
      assert.equal(d.depth, MAX_DEPTH);
      const antes = achatar(amb.hub.sessions.graph(a.id)).length;

      // Objetivo inédito e agente inédito: nenhum ciclo possível, só a profundidade.
      const erro = await codigoDoErro(delegar(d.id, 'e', 'nivel-quatro'));
      assert.equal(erro.code, 'DEPTH_EXCEEDED');
      assert.match(erro.message, /excede o máximo de 3/);
      assert.equal(erro.details['depth'], 4);
      assert.equal(erro.details['maxDepth'], MAX_DEPTH);

      assert.equal(achatar(amb.hub.sessions.graph(a.id)).length, antes, 'nada foi criado');
      assert.equal(amb.hub.sessions.liveCount() >= 4, true);
    } finally {
      await encerrar(a.id);
    }
  });
});

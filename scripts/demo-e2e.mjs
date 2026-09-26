#!/usr/bin/env node
/**
 * Demo ponta a ponta do MVP, com custo ZERO e sem agentes reais.
 *
 * Sobe um daemon ISOLADO (home temporária + porta efêmera; nunca toca em
 * ~/.agents-hub nem na porta 4747), registra três agentes FALSOS (scripts Node
 * descritos por manifesto YAML) e percorre o fluxo principal só por HTTP:
 *
 *   sessão-raiz  ->  delega ao filho  ->  filho delega ao neto (profundidade 2)
 *
 * Termina com exit 0 se todos os passos deram PASS, 1 caso contrário. O daemon
 * e o diretório temporário são removidos ao final, inclusive em falha.
 *
 * Pré-requisito: `npm run build` (usa packages/daemon/dist e packages/web/dist).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raizDoRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonMain = path.join(raizDoRepo, 'packages', 'daemon', 'dist', 'main.js');
const webIndex = path.join(raizDoRepo, 'packages', 'web', 'dist', 'index.html');

const TERMINAIS = new Set(['completed', 'failed', 'canceled', 'rejected']);

let falhas = 0;
let passos = 0;

function passo(ok, descricao, detalhe = '') {
  passos += 1;
  if (!ok) falhas += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${descricao}${detalhe ? `  (${detalhe})` : ''}`);
  return ok;
}

/** Erro que aborta a demo depois de registrar o FAIL correspondente. */
class Abortar extends Error {}
function exigir(ok, descricao, detalhe) {
  if (!passo(ok, descricao, detalhe)) throw new Abortar(descricao);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function portaLivre() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// O agente falso: imprime uma linha, dorme FAKE_SLEEP_MS (para o pai continuar
// vivo enquanto delega) e sai com 0. Custo zero por construção.
const AGENTE_FALSO = `
if (process.argv.includes('--version')) { process.stdout.write('9.9.9\\n'); process.exit(0); }
const ms = Number(process.env.FAKE_SLEEP_MS || 0);
setTimeout(() => {
  process.stdout.write('FAKE_OK do agente ' + process.env.FAKE_NAME + '\\n');
  process.exit(0);
}, ms);
`;

function manifesto(id, script, sleepMs) {
  const esc = (s) => s.replaceAll('\\', '\\\\');
  return [
    `id: ${id}`,
    `name: Agente falso ${id}`,
    'bin: node',
    'detect:',
    `  args: ["${esc(script)}", "--version"]`,
    'invoke:',
    `  oneShot: ["${esc(script)}"]`,
    '  stdinPrompt: true',
    '  env:',
    `    FAKE_NAME: "${id}"`,
    `    FAKE_SLEEP_MS: "${sleepMs}"`,
    'session:',
    '  strategy: replay',
    'stream:',
    '  format: text',
    '  mapper: generic-text',
    'capabilities: [demo]',
    'defaults:',
    '  isolation: none',
    '  timeoutSeconds: 60',
    '  supervision: autonomous',
    '',
  ].join('\n');
}

async function http(base, method, rota, corpo, token) {
  const res = await fetch(base + rota, {
    method,
    headers: {
      ...(corpo === undefined ? {} : { 'content-type': 'application/json' }),
      // Rotas de operador (ex.: /shutdown) exigem o token do item 1.6.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await res.text();
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    /* corpo não-JSON (ex.: HTML do painel) */
  }
  return { status: res.status, json, texto };
}

async function esperarTarefaTerminal(base, taskId, timeoutMs = 30_000) {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await http(base, 'GET', `/tasks/${taskId}`);
    const estado = json?.task?.state;
    if (estado && TERMINAIS.has(estado)) return json.task;
    if (Date.now() > limite) throw new Error(`task ${taskId} não terminou em ${timeoutMs}ms (estado ${estado})`);
    await dormir(150);
  }
}

function imprimirGrafo(nos, recuo = 0) {
  for (const no of nos) {
    const custo = `US$ ${Number(no.usd ?? 0).toFixed(4)} / ${no.tokens ?? 0} tokens`;
    console.log(`    ${'  '.repeat(recuo)}${recuo ? '└─ ' : ''}${no.agentId} [${no.state}] prof=${no.depth} ${custo}`);
    imprimirGrafo(no.children ?? [], recuo + 1);
  }
}

function achatar(nos) {
  return nos.flatMap((n) => [n, ...achatar(n.children ?? [])]);
}

async function main(ctx) {
  console.log('Demo E2E do Agents-Hub (agentes falsos, custo zero)\n');

  exigir(existsSync(daemonMain), 'build do daemon presente', 'rode `npm run build` antes');

  const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-demo-'));
  ctx.tmp = raiz;
  const home = path.join(raiz, 'home');
  const manifestos = path.join(home, 'manifests');
  const projeto = path.join(raiz, 'projeto');
  for (const d of [manifestos, projeto]) mkdirSync(d, { recursive: true });

  const script = path.join(raiz, 'agente-falso.cjs');
  writeFileSync(script, AGENTE_FALSO, 'utf8');
  // O filho vive tempo suficiente para delegar ao neto enquanto ainda está ativo
  // (delegar a partir de sessão terminal é recusado pelo Hub).
  writeFileSync(path.join(manifestos, 'raiz.yaml'), manifesto('raiz', script, 0), 'utf8');
  writeFileSync(path.join(manifestos, 'filho.yaml'), manifesto('filho', script, 5000), 'utf8');
  writeFileSync(path.join(manifestos, 'neto.yaml'), manifesto('neto', script, 300), 'utf8');

  const porta = await portaLivre();
  const base = `http://127.0.0.1:${porta}`;
  ctx.base = base;

  const saida = [];
  const filho = spawn(process.execPath, ['--experimental-sqlite', daemonMain], {
    cwd: raizDoRepo,
    env: {
      ...process.env,
      AGENTS_HUB_HOME: home,
      AGENTS_HUB_PORT: String(porta),
      AGENTS_HUB_NO_AUTOSTART: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  ctx.daemon = filho;
  filho.stdout.on('data', (d) => saida.push(String(d)));
  filho.stderr.on('data', (d) => saida.push(String(d)));
  ctx.saida = saida;
  const morreu = new Promise((resolve) => filho.once('exit', (code) => resolve(code)));
  ctx.morreu = morreu;

  // --- 1. daemon no ar ------------------------------------------------------
  let saude = null;
  const limite = Date.now() + 20_000;
  while (Date.now() < limite) {
    try {
      const r = await http(base, 'GET', '/health');
      if (r.status === 200) {
        saude = r.json;
        break;
      }
    } catch {
      /* ainda subindo */
    }
    await dormir(150);
  }
  exigir(saude?.ok === true, `daemon isolado no ar em ${base}`, `home ${home}`);
  exigir(path.resolve(saude.home) === path.resolve(home), '/health reporta a home temporária (não toca ~/.agents-hub)');

  // --- 2. painel web --------------------------------------------------------
  if (existsSync(webIndex)) {
    const painel = await http(base, 'GET', '/');
    passo(
      painel.status === 200 && /<html|<!doctype/i.test(painel.texto),
      'GET / serve o painel web',
      `HTTP ${painel.status}, ${painel.texto.length} bytes`,
    );
  } else {
    passo(false, 'GET / serve o painel web', 'packages/web/dist ausente — rode `npm run build`');
  }

  // --- 3. agentes registrados ----------------------------------------------
  const agentes = await http(base, 'GET', '/agents');
  const ids = (agentes.json?.agents ?? []).map((a) => a.id);
  passo(
    ['raiz', 'filho', 'neto'].every((i) => ids.includes(i)),
    'os 3 agentes falsos estão registrados',
    ids.join(', '),
  );

  // --- 4. projeto + sessão-raiz --------------------------------------------
  const prj = await http(base, 'POST', '/projects', { path: projeto, name: 'demo' });
  exigir(prj.status === 201 && !!prj.json?.project?.id, 'projeto registrado', `HTTP ${prj.status}`);
  const projectId = prj.json.project.id;

  const adot = await http(base, 'POST', '/sessions/adopt', {
    agentId: 'raiz',
    projectId,
    title: 'demo: sessão-raiz',
    budget: { usd: 1 },
  });
  exigir(adot.status === 201 && !!adot.json?.session?.id, 'sessão-raiz aberta', `HTTP ${adot.status}`);
  const raizId = adot.json.session.id;
  passo(adot.json.session.depth === 0 && adot.json.session.parentId === null, 'raiz tem profundidade 0 e nenhum pai');

  // --- 5. raiz -> filho -----------------------------------------------------
  const brief = (agent, objective) => ({ agent, objective, isolation: 'none', supervision: 'autonomous' });

  const d1 = await http(base, 'POST', `/sessions/${raizId}/delegate`, {
    brief: brief('filho', 'tarefa do filho: relatar que está vivo'),
  });
  exigir(d1.status === 201 && !!d1.json?.taskId, 'raiz delegou ao filho', `HTTP ${d1.status} ${d1.json?.error?.message ?? ''}`);

  // --- 6. filho -> neto (profundidade 2) -----------------------------------
  const d2 = await http(base, 'POST', `/sessions/${d1.json.sessionId}/delegate`, {
    brief: brief('neto', 'tarefa do neto: relatar que está vivo'),
  });
  exigir(d2.status === 201 && !!d2.json?.taskId, 'filho delegou ao neto', `HTTP ${d2.status} ${d2.json?.error?.message ?? ''}`);

  // --- 7. estados terminais -------------------------------------------------
  const tNeto = await esperarTarefaTerminal(base, d2.json.taskId);
  passo(tNeto.state === 'completed', 'tarefa do neto terminou', `estado ${tNeto.state}`);
  const tFilho = await esperarTarefaTerminal(base, d1.json.taskId);
  passo(tFilho.state === 'completed', 'tarefa do filho terminou', `estado ${tFilho.state}`);

  // --- 8. grafo e custo -----------------------------------------------------
  const grafo = await http(base, 'GET', `/graph/${raizId}`);
  const nos = achatar(grafo.json?.graph ?? []);
  console.log('\n  Grafo de delegação:');
  imprimirGrafo(grafo.json?.graph ?? []);
  const porAgente = Object.fromEntries(nos.map((n) => [n.agentId, n]));
  passo(
    nos.length === 3 && porAgente.raiz?.depth === 0 && porAgente.filho?.depth === 1 && porAgente.neto?.depth === 2,
    'grafo tem raiz -> filho -> neto com profundidades 0/1/2',
    nos.map((n) => `${n.agentId}:${n.depth}`).join(' '),
  );
  passo(
    nos.filter((n) => n.agentId !== 'raiz').every((n) => n.state === 'completed' || n.state === 'idle'),
    'filho e neto em estado terminal/concluído',
    nos.map((n) => `${n.agentId}=${n.state}`).join(' '),
  );

  const orc = await http(base, 'GET', `/budget/${raizId}`);
  const consumido = orc.json?.budget?.consumed;
  console.log(`\n  Custo do fluxo: US$ ${Number(consumido?.usd ?? 0).toFixed(4)}, ${consumido?.tokens ?? 0} tokens`);
  passo(
    orc.status === 200 && Number(consumido?.usd ?? 1) === 0,
    'custo total do fluxo é zero',
    `US$ ${consumido?.usd}`,
  );

  // --- 9. resultado ---------------------------------------------------------
  console.log('\n  Resultados:');
  for (const [nome, t] of [['filho', tFilho], ['neto', tNeto]]) {
    console.log(`    ${nome}: ${JSON.stringify(t.result?.summary ?? null)}`);
  }
  passo(
    /FAKE_OK do agente neto/.test(tNeto.result?.summary ?? '') && /FAKE_OK do agente filho/.test(tFilho.result?.summary ?? ''),
    'resultados carregam a saída dos agentes falsos',
  );

  // --- 10. de novo: health/painel depois do fluxo --------------------------
  const h2 = await http(base, 'GET', '/health');
  passo(h2.status === 200 && h2.json?.ok === true, '/health segue respondendo ao final');
}

async function limpar(ctx) {
  const d = ctx.daemon;
  if (d && d.exitCode === null) {
    try {
      if (ctx.base) {
        let token;
        try {
          token = readFileSync(path.join(ctx.tmp, 'home', 'operator-token'), 'utf8').trim();
        } catch {
          /* sem token: o kill abaixo resolve */
        }
        await http(ctx.base, 'POST', '/shutdown', {}, token).catch(() => {});
      }
    } catch {
      /* cai para o kill abaixo */
    }
    const saiu = await Promise.race([ctx.morreu, dormir(5000).then(() => 'timeout')]);
    if (saiu === 'timeout' && d.exitCode === null) {
      d.kill('SIGKILL');
      await Promise.race([ctx.morreu, dormir(3000)]);
    }
  }
  if (ctx.tmp) {
    // No Windows o SQLite pode segurar o arquivo por instantes após o exit.
    for (let i = 0; i < 10; i += 1) {
      try {
        rmSync(ctx.tmp, { recursive: true, force: true });
        break;
      } catch {
        await dormir(200);
      }
    }
  }
}

const ctx = {};
try {
  await main(ctx);
} catch (err) {
  if (!(err instanceof Abortar)) {
    falhas += 1;
    console.log(`FAIL  erro inesperado: ${err?.stack ?? err}`);
  }
  if (ctx.saida?.length) console.log(`\n--- saída do daemon ---\n${ctx.saida.join('')}`);
} finally {
  await limpar(ctx);
}

const restou = ctx.tmp && existsSync(ctx.tmp);
passo(!restou, 'daemon derrubado e diretório temporário removido');
console.log(`\n${falhas === 0 ? 'OK' : 'FALHOU'}: ${passos - falhas}/${passos} passos PASS`);
process.exit(falhas === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Teste de instalação em diretório limpo: empacota, instala e usa.
 *
 * Uso:  npm run build && npm run test:install [-- --node <node.exe>] [-- --keep]
 *
 * 1. `pack-dist.mjs` monta `agents-hub-<versão>.tgz` numa pasta temporária;
 * 2. `npm i -g --prefix <tmp>/prefix <tgz>` — o prefixo global REAL do usuário
 *    não é tocado;
 * 3. roda o `hub` instalado (o shim que o npm criou) com AGENTS_HUB_HOME
 *    temporário, AGENTS_HUB_NO_AUTOSTART=1 e AGENTS_HUB_PORT numa porta livre:
 *    `hub --version`, `hub help` (sem ExperimentalWarning), `hub mcp` e
 *    `hub hooks install claude` em dry-run (apontam para a instalação, não
 *    para o clone);
 * 4. sobe `hub daemon` (processo nosso, PID guardado), espera `/health`,
 *    confere que o painel (`/`) e os manifestos vieram do pacote, roda
 *    `hub status`/`hub doctor` contra ele pela variável `AGENTS_HUB_PORT`;
 * 5. encerra com `POST /shutdown` e o token de operador de `<home>/operator-token`.
 *
 * `--node <caminho>` roda o `hub` instalado com outro Node (ex.: 22.12, que
 * exige `--experimental-sqlite`): `npx -y node@22.12.0 -p process.execPath`
 * mostra onde o npx guardou um.
 *
 * `hub doctor` só roda `--version` dos agentes instalados — nenhuma chamada a
 * modelo. Nada é gravado em configs de agentes (o `hooks install` é dry-run,
 * num projeto temporário).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { empacotar, npm } from './pack-dist.mjs';

const args = process.argv.slice(2);
const manter = args.includes('--keep');
const iNode = args.indexOf('--node');
const nodeAlternativo = iNode >= 0 ? path.resolve(args[iNode + 1] ?? '') : undefined;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'agents-hub-install-'));
const prefixo = path.join(tmp, 'prefix');
const home = path.join(tmp, 'home');
const projeto = path.join(tmp, 'projeto');
let daemon;
let porta;
let logDoDaemon = '';
let falhas = 0;

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function falha(msg) {
  falhas += 1;
  console.log(`  ✗ ${msg}`);
}
function checar(cond, msg, detalhe) {
  if (cond) ok(msg);
  else falha(detalhe ? `${msg}\n      ${String(detalhe).split('\n').join('\n      ')}` : msg);
}

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const raizInstalada = () => path.join(prefixo, process.platform === 'win32' ? '' : 'lib', 'node_modules', 'agents-hub');
const shimDoHub = () =>
  process.platform === 'win32' ? path.join(prefixo, 'hub.cmd') : path.join(prefixo, 'bin', 'hub');

function ambiente() {
  return {
    ...process.env,
    AGENTS_HUB_HOME: home,
    AGENTS_HUB_NO_AUTOSTART: '1',
    AGENTS_HUB_PORT: String(porta),
    NO_COLOR: '1',
  };
}

/**
 * Roda o `hub` instalado. Pelo shim do npm (o que o usuário executa), ou —
 * com `--node` — pelo Node indicado sobre a entrada instalada, que é
 * exatamente o que o shim faz com o `node` do PATH.
 */
function hub(argv, opcoes = {}) {
  if (nodeAlternativo) {
    return spawnSync(nodeAlternativo, [path.join(raizInstalada(), 'bin', 'hub.js'), ...argv], {
      encoding: 'utf8',
      env: ambiente(),
      ...opcoes,
    });
  }
  const shim = shimDoHub();
  if (process.platform !== 'win32') {
    return spawnSync(shim, argv, { encoding: 'utf8', env: ambiente(), ...opcoes });
  }
  // `.cmd` só roda com shell no Node 24; a linha vai montada (e entre aspas)
  // aqui, porque shell + array de argumentos é concatenação sem escape.
  // Os argumentos deste script não têm aspas nem metacaracteres do cmd.
  const linha = [shim, ...argv].map((a) => (/[\s&()^|<>]/.test(a) ? `"${a}"` : a)).join(' ');
  return spawnSync(linha, { encoding: 'utf8', env: ambiente(), shell: true, ...opcoes });
}

async function esperarHealth(limiteMs) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    try {
      const r = await fetch(`http://127.0.0.1:${porta}/health`);
      if (r.ok) return await r.json();
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return undefined;
}

/**
 * POST numa conexão nova. O `fetch` reaproveita o socket keep-alive do GET
 * anterior, que o servidor já pode ter fechado por ociosidade (o `hub doctor`
 * no meio leva segundos) — daí um ECONNRESET que não diz nada sobre o daemon.
 */
function postSemKeepAlive(rota, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: porta,
        path: rota,
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

async function encerrarDaemon() {
  if (!daemon) return;
  if (daemon.exitCode !== null || daemon.signalCode !== null) {
    daemon = undefined;
    return;
  }
  let token = '';
  try {
    token = readFileSync(path.join(home, 'operator-token'), 'utf8').trim();
  } catch {
    /* sem token: o shutdown vai responder 401 e caímos no kill abaixo */
  }
  const saiu = new Promise((resolve) => daemon.once('exit', resolve));
  try {
    const status = await postSemKeepAlive(`/shutdown`, token);
    checar(status === 200, `POST /shutdown com o token de operador (${status})`);
  } catch (err) {
    checar(false, `POST /shutdown: ${err.message} (daemon exit=${daemon?.exitCode})`, logDoDaemon);
  }
  const t = setTimeout(() => daemon.kill(), 15_000);
  await saiu;
  clearTimeout(t);
  daemon = undefined;
}

async function principal() {
  porta = await portaLivre();
  console.log(`pasta temporária: ${tmp}`);

  console.log('\n1. empacotar');
  const pacote = empacotar({ saida: path.join(tmp, 'pack') });
  ok(`${path.basename(pacote.tgz)} (${pacote.arquivos} arquivos)`);

  console.log('\n2. instalar num prefixo limpo');
  const inst = npm(['install', '--global', '--prefix', prefixo, '--no-audit', '--no-fund', pacote.tgz], {
    cwd: tmp,
  });
  checar(inst.status === 0, `npm i -g --prefix <tmp> ${path.basename(pacote.tgz)}`, inst.stderr);
  if (inst.status !== 0) return;
  checar(existsSync(shimDoHub()), `shim do hub em ${shimDoHub()}`);
  checar(existsSync(path.join(raizInstalada(), 'manifests', 'claude.yaml')), 'manifestos dentro da instalação');

  console.log(`\n3. comandos offline${nodeAlternativo ? ` (node: ${nodeAlternativo})` : ''}`);
  const versao = hub(['--version']);
  checar(versao.status === 0 && versao.stdout.trim() === pacote.versao, `hub --version = ${pacote.versao}`, versao.stdout + versao.stderr);

  const ajuda = hub(['help']);
  checar(ajuda.status === 0 && ajuda.stdout.includes('hub status'), 'hub help', ajuda.stderr);
  checar(!/ExperimentalWarning/.test(ajuda.stderr), 'hub help sem ExperimentalWarning no stderr', ajuda.stderr);

  const mcp = hub(['mcp']);
  const linhaMcp = mcp.stdout.split('\n').find((l) => l.includes('MCP server:')) ?? '';
  checar(
    mcp.status === 0 && linhaMcp.includes(raizInstalada()),
    'hub mcp: MCP server aponta para a instalação, não para o clone',
    linhaMcp || mcp.stderr,
  );
  checar(mcp.stdout.includes(`127.0.0.1:${porta}`), 'hub mcp: daemon na porta de AGENTS_HUB_PORT', mcp.stdout);

  const hooks = hub(['hooks', 'install', 'claude', '--project', projeto]);
  const esperadoNoHook = path.join(raizInstalada(), 'node_modules', '@agents-hub', 'cli', 'dist', 'bin.js');
  checar(
    hooks.status === 0 && hooks.stdout.includes(JSON.stringify(esperadoNoHook).slice(1, -1)),
    'hub hooks install claude (dry-run): hook aponta para a instalação',
    hooks.stdout + hooks.stderr,
  );

  const hookResp = hub(['hook'], { input: '{"tool_name":"Read","tool_input":{}}' });
  checar(hookResp.status === 0 && hookResp.stdout.includes('permissionDecision'), 'hub hook responde (daemon fora do ar)', hookResp.stdout + hookResp.stderr);

  console.log('\n4. daemon da instalação');
  const nodeDoDaemon = nodeAlternativo ?? process.execPath;
  daemon = spawn(nodeDoDaemon, [path.join(raizInstalada(), 'bin', 'hub.js'), 'daemon'], {
    env: ambiente(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  logDoDaemon = '';
  daemon.stdout.on('data', (d) => (logDoDaemon += d));
  daemon.stderr.on('data', (d) => (logDoDaemon += d));
  const health = await esperarHealth(30_000);
  checar(health !== undefined, `/health em 127.0.0.1:${porta} (pid ${daemon.pid})`, logDoDaemon);
  if (!health) return;
  checar(!/ExperimentalWarning/.test(logDoDaemon), 'daemon sem ExperimentalWarning no log', logDoDaemon);

  const painel = await fetch(`http://127.0.0.1:${porta}/`);
  const html = await painel.text();
  checar(painel.ok && /<html/i.test(html), `painel servido pelo daemon (GET / ${painel.status})`);

  const agentes = hub(['agents']);
  checar(agentes.status === 0 && agentes.stdout.includes('claude'), 'hub agents: manifestos carregados do pacote', agentes.stdout + agentes.stderr);

  const status = hub(['status']);
  checar(status.status === 0, 'hub status (cliente achou o daemon via AGENTS_HUB_PORT)', status.stdout + status.stderr);

  const doctor = hub(['doctor']);
  checar(doctor.status === 0 && doctor.stdout.includes('agentes disponíveis'), 'hub doctor', doctor.stdout + doctor.stderr);

  console.log('\n5. encerrar');
  await encerrarDaemon();
}

try {
  await principal();
} catch (err) {
  falha(err.stack ?? String(err));
} finally {
  if (daemon) {
    await encerrarDaemon().catch(() => daemon?.kill());
  }
  if (!manter) {
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      console.log(`(não consegui apagar ${tmp})`);
    }
  } else {
    console.log(`\n(--keep) mantido: ${tmp}`);
  }
}

console.log(falhas === 0 ? '\ninstalação OK' : `\n${falhas} verificação(ões) falharam`);
process.exitCode = falhas === 0 ? 0 : 1;

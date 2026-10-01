// Linha de base de desempenho do Agents-Hub (TS/Node). Isolado: home temporária,
// porta 48731, NO_AUTOSTART. Nunca 4747, nunca ~/.agents-hub.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const REPO = process.env.REPO;
const BIN = path.join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const MCP = path.join(REPO, 'packages', 'mcp', 'dist', 'main.js');
const SCRATCH = process.env.SCRATCH;
const PORT = Number(process.env.AGENTS_HUB_PORT);
if (PORT === 4747 || !PORT) throw new Error('porta proibida/indefinida');
const TMPROOT = process.env.BENCH_TMP;
if (!TMPROOT || /\.agents-hub$/.test(TMPROOT)) throw new Error('BENCH_TMP invalido');
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;
const MB = (b) => r1(b / 1048576);
function stats(a) { return { n: a.length, med: r1(med(a)), min: r1(Math.min(...a)), max: r1(Math.max(...a)), p90: r1(pct(a, 90)), all: a.map(r1) }; }

function envFor(home, extra = {}) {
  return { ...process.env, AGENTS_HUB_HOME: home, AGENTS_HUB_PORT: String(PORT), AGENTS_HUB_NO_AUTOSTART: '1', AGENTS_HUB_URL: BASE, NO_COLOR: '1', ...extra };
}
function newHome(tag) { return mkdtempSync(path.join(TMPROOT, `${tag}-`)); }

function procInfo(pid) {
  const cmd = `$p=Get-Process -Id ${pid} -ErrorAction Stop; "$($p.WorkingSet64) $($p.PrivateMemorySize64) $($p.PeakWorkingSet64) $($p.TotalProcessorTime.TotalMilliseconds) $($p.Threads.Count) $($p.HandleCount)"`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
  const [ws, priv, peak, cpu, thr, hnd] = r.stdout.trim().split(/\s+/).map(Number);
  return { wsMB: MB(ws), privMB: MB(priv), peakWsMB: MB(peak), cpuMs: cpu, threads: thr, handles: hnd };
}
function childPids(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId`], { encoding: 'utf8' });
  return r.stdout.split(/\s+/).filter(Boolean).map(Number);
}

function req(method, rota, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const t0 = performance.now();
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: rota, method, agent: false,
      headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const txt = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(txt); } catch {} resolve({ status: res.statusCode, txt, json, ms: performance.now() - t0, bytes: Buffer.byteLength(txt) }); });
    });
    rq.on('error', reject); rq.setTimeout(15000, () => rq.destroy(new Error('timeout')));
    rq.end(data);
  });
}

async function portFree() { try { await req('GET', '/health'); return false; } catch { return true; } }

async function startDaemon(home) {
  if (!(await portFree())) throw new Error(`porta ${PORT} ocupada antes do start`);
  const t0 = performance.now();
  const p = spawn(process.execPath, [BIN, 'daemon'], { env: envFor(home), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; let tLog = null;
  p.stdout.on('data', (d) => { log += d; if (tLog === null && log.includes('daemon no ar')) tLog = performance.now() - t0; });
  p.stderr.on('data', (d) => (log += d));
  let tHealth = null;
  while (performance.now() - t0 < 30000) {
    if (p.exitCode !== null) throw new Error('daemon saiu: ' + log);
    try { const r = await req('GET', '/health'); if (r.status === 200) { tHealth = performance.now() - t0; break; } } catch {}
    await sleep(5);
  }
  if (tHealth === null) throw new Error('sem /health: ' + log);
  const token = readFileSync(path.join(home, 'operator-token'), 'utf8').trim();
  const idt = await req('POST', '/approvals/apv_benchinexistente', { decision: 'approved' }, token);
  if (idt.status === 401 || idt.status === 403) throw new Error('daemon na porta nao e o nosso');
  const dd = { p, home, token, tHealth, tLog: () => tLog, log: () => log }; VIVOS.add(dd); return dd;
}
async function stopDaemon(d) {
  VIVOS.delete(d);
  const saiu = new Promise((r) => (d.p.exitCode !== null ? r() : d.p.once('exit', r)));
  const t0 = performance.now();
  const r = await req('POST', '/shutdown', {}, d.token);
  const kill = setTimeout(() => d.p.kill(), 15000);
  await saiu; clearTimeout(kill);
  return { status: r.status, ms: performance.now() - t0, exit: d.p.exitCode };
}

// ---------- agentes falsos (custo zero, nenhum modelo) ----------
const AGENTE_JSONL = readFileSync(path.join(SCRATCH, 'agente.cjs'), 'utf8');
const AGENTE_FLOOD = readFileSync(path.join(SCRATCH, 'flood.cjs'), 'utf8');
const BS = String.fromCharCode(92); const esc = (s) => s.split(BS).join(BS + BS);
function manifest(id, script, { format = 'jsonl', mapper = 'claude', env = {}, supervision = 'autonomous' } = {}) {
  return [`id: ${id}`, `name: falso ${id}`, 'bin: node', 'detect:', `  args: ["${esc(script)}", "--version"]`, 'invoke:', `  oneShot: ["${esc(script)}"]`, '  stdinPrompt: true', '  env:',
    ...Object.entries(env).map(([k, v]) => `    ${k}: "${v}"`), 'session:', '  strategy: replay', 'stream:', `  format: ${format}`, `  mapper: ${mapper}`, 'capabilities: [bench]', 'defaults:', '  isolation: none', '  timeoutSeconds: 600', `  supervision: ${supervision}`, ''].join('\n');
}
function fakeHome(tag) {
  const home = newHome(tag); const m = path.join(home, 'manifests'); mkdirSync(m, { recursive: true });
  const sj = path.join(home, 'agente.cjs'); writeFileSync(sj, AGENTE_JSONL);
  const sf = path.join(home, 'flood.cjs'); writeFileSync(sf, AGENTE_FLOOD);
  writeFileSync(path.join(m, 'lento.yaml'), manifest('lento', sj, { env: { FAKE_AGENT: 'lento', FAKE_SLEEP_MS: '600000' }, supervision: 'semi' }));
  writeFileSync(path.join(m, 'eco.yaml'), manifest('eco', sj, { env: { FAKE_AGENT: 'eco', FAKE_SLEEP_MS: '0' } }));
  for (const [id, n, iv] of [['burst2k', 2000, 0], ['burst20k', 20000, 0], ['paced', 200, 20]])
    writeFileSync(path.join(m, `${id}.yaml`), manifest(id, sf, { format: 'text', mapper: 'generic-text', env: { FLOOD_N: n, FLOOD_IV: iv, FLOOD_PAD: 150 } }));
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ policy: { retries: { max: 0, backoffMs: 10 }, watch: { pauseOn: [], flagOn: [] } } }));
  const proj = path.join(home, 'projeto'); mkdirSync(proj); writeFileSync(path.join(proj, 'README.md'), '# bench\n');
  return { home, proj };
}

function timeProc(args, { env, input, cwd, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const p = spawn(process.execPath, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    const k = setTimeout(() => p.kill(), timeout);
    p.on('exit', (code) => { clearTimeout(k); resolve({ ms: performance.now() - t0, code, out, err }); });
    p.stdin.end(input ?? '');
  });
}

const results = {};
const VIVOS = new Set();
function exigirSessao(sr) { if (!sr.json?.session?.id) throw new Error("POST /sessions falhou: " + sr.status + " " + sr.txt.slice(0, 500)); return sr; }
const save = (name) => writeFileSync(path.join(SCRATCH, `res-${name}.json`), JSON.stringify(results[name], null, 2));

// ---------- 1+2: startup, RAM, CPU ocioso ----------
async function secStartup() {
  const fresh = [], freshMem = [];
  for (let i = 0; i < 7; i++) {
    const d = await startDaemon(newHome('fresh'));
    await sleep(2000); const m = procInfo(d.p.pid);
    const s = await stopDaemon(d);
    fresh.push(d.tHealth); freshMem.push({ ...m, tLog: d.tLog(), shutdownMs: s.ms });
    await sleep(500);
  }
  const warmHome = newHome('warm');
  { const d = await startDaemon(warmHome); await sleep(1000); await stopDaemon(d); }
  const warm = [], idle = [];
  for (let i = 0; i < 5; i++) {
    const d = await startDaemon(warmHome);
    await sleep(2000); const m2 = procInfo(d.p.pid); const kids = childPids(d.p.pid).length;
    await sleep(60000); const m62 = procInfo(d.p.pid);
    const s = await stopDaemon(d);
    warm.push(d.tHealth);
    idle.push({ t2s: m2, t62s: m62, cpuIdleMsIn60s: r1(m62.cpuMs - m2.cpuMs), children: kids, shutdownMs: r1(s.ms), tLog: d.tLog() });
    await sleep(500);
  }
  results.startup = {
    freshHealthMs: stats(fresh), freshWs2s: stats(freshMem.map((x) => x.wsMB)), freshPriv2s: stats(freshMem.map((x) => x.privMB)),
    freshLogMs: stats(freshMem.map((x) => x.tLog)), warmHealthMs: stats(warm), warmLogMs: stats(idle.map((x) => x.tLog)),
    ws2s: stats(idle.map((x) => x.t2s.wsMB)), priv2s: stats(idle.map((x) => x.t2s.privMB)),
    ws62s: stats(idle.map((x) => x.t62s.wsMB)), priv62s: stats(idle.map((x) => x.t62s.privMB)),
    cpuIdleMsIn60s: stats(idle.map((x) => x.cpuIdleMsIn60s)), threads: stats(idle.map((x) => x.t2s.threads)), handles: stats(idle.map((x) => x.t2s.handles)),
    children: idle.map((x) => x.children), shutdownMs: stats(idle.map((x) => x.shutdownMs)), freshMem, idle,
  };
  save('startup');
}

// ---------- 3: painel ----------
async function secPanel() {
  const { chromium } = createRequire(path.join(REPO, 'package.json'))('playwright');
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const { home } = fakeHome('panel');
    const d = await startDaemon(home);
    await sleep(2000); const m0 = procInfo(d.p.pid);
    const html = await req('GET', '/');
    const assets = [...html.txt.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    const lat = { 'GET /': html.ms, 'bytes /': html.bytes };
    for (const a of assets) { const r = await req('GET', a); const k = a.endsWith('.js') ? 'js' : 'css'; lat[`GET asset ${k}`] = r.ms; lat[`bytes asset ${k}`] = r.bytes; }
    for (const rota of ['/health', '/agents', '/projects', '/sessions', '/approvals', '/workflows/runs']) { const r = await req('GET', rota); lat[`GET ${rota}`] = r.ms; if (r.status !== 200) lat[`status ${rota}`] = r.status; }
    const hot = { '/health': [], '/sessions': [], '/projects': [], '/approvals': [] };
    for (let k = 0; k < 20; k++) for (const rota of Object.keys(hot)) hot[rota].push((await req('GET', rota)).ms);
    await sleep(1000); const m1 = procInfo(d.p.pid);
    let m2 = null, m3 = null, browserErr = null, pageLoadMs = null;
    try {
      const browser = await chromium.launch({ headless: true, channel: 'msedge' });
      const page = await browser.newPage();
      const t0 = performance.now();
      await page.goto(BASE + '/', { waitUntil: 'load' });
      pageLoadMs = performance.now() - t0;
      await sleep(3000); m2 = procInfo(d.p.pid);
      await page.reload({ waitUntil: 'load' }); await sleep(3000); m3 = procInfo(d.p.pid);
      await browser.close();
    } catch (e) { browserErr = String(e.message).slice(0, 300); }
    await sleep(500);
    const s = await stopDaemon(d);
    runs.push({ m0, m1, m2, m3, lat, hotMed: Object.fromEntries(Object.entries(hot).map(([k, v]) => [k, r1(med(v))])), pageLoadMs, browserErr, shutdown: s.status });
    await sleep(500);
  }
  const okB = runs.every((r) => r.m2);
  results.panel = {
    wsBase: stats(runs.map((r) => r.m0.wsMB)), privBase: stats(runs.map((r) => r.m0.privMB)),
    wsAfterHttp: stats(runs.map((r) => r.m1.wsMB)), privAfterHttp: stats(runs.map((r) => r.m1.privMB)),
    wsAfterBrowser: okB ? stats(runs.map((r) => r.m2.wsMB)) : null, privAfterBrowser: okB ? stats(runs.map((r) => r.m2.privMB)) : null,
    wsAfterReload: okB ? stats(runs.map((r) => r.m3.wsMB)) : null, privAfterReload: okB ? stats(runs.map((r) => r.m3.privMB)) : null,
    peakWs: stats(runs.map((r) => (r.m3 ?? r.m1).peakWsMB)),
    pageLoadMs: okB ? stats(runs.map((r) => r.pageLoadMs)) : null, browserErr: runs.map((r) => r.browserErr).filter(Boolean),
    coldLat: Object.fromEntries(Object.keys(runs[0].lat).map((k) => [k, /^(bytes|status)/.test(k) ? runs[0].lat[k] : stats(runs.map((r) => r.lat[k]))])),
    hotMed: Object.fromEntries(Object.keys(runs[0].hotMed).map((k) => [k, stats(runs.map((r) => r.hotMed[k]))])),
    runs,
  };
  save('panel');
}

// ---------- 4+5: hook e CLI ----------
async function secHookCli() {
  const { home, proj } = fakeHome('hook');
  const env = envFor(home);
  const N = 15;
  const out = {};
  const serie = async (nome, args, opts = {}) => {
    const a = []; let last;
    await timeProc(args, opts);
    for (let i = 0; i < N; i++) { last = await timeProc(args, opts); a.push(last.ms); }
    out[nome] = { ...stats(a), code: last.code, stdout: last.out.slice(0, 300), stderr: last.err.slice(0, 300) };
    console.log(nome, out[nome].med);
  };
  await serie('node -e 0 (piso do runtime)', ['-e', '0'], { env });
  await serie('hub --version', [BIN, '--version'], { env });
  await serie('hub help', [BIN, 'help'], { env });
  const read = JSON.stringify({ session_id: 'nat-x', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(proj, 'README.md') }, cwd: proj, tool_use_id: 'tu_r' });
  const bash = JSON.stringify({ session_id: 'nat-x', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: proj });
  await serie('hub hook Read (rapido, daemon fora)', [BIN, 'hook'], { env, input: read, cwd: proj });
  await serie('hub hook Bash git status (daemon fora do ar)', [BIN, 'hook'], { env, input: bash, cwd: proj });
  const d = await startDaemon(home);
  await sleep(1500);
  await serie('hub hook Read (rapido, daemon no ar)', [BIN, 'hook'], { env, input: read, cwd: proj });
  await serie('hub hook Bash git status (fora de sessao, daemon no ar)', [BIN, 'hook'], { env, input: bash, cwd: proj });
  const pr = await req('POST', '/projects', { path: proj, name: 'bench' });
  const sr = exigirSessao(await req('POST', '/sessions', { projectId: pr.json.project.id, brief: { agent: 'lento', objective: 'sessao falsa que dorme para medir o gate do hook', isolation: 'none' } }));
  const sid = sr.json.session.id;
  await sleep(2000);
  const envS = envFor(home, { AGENTS_HUB_SESSION_ID: sid });
  await serie('hub hook Bash git status (sessao do Hub, politica aplicada)', [BIN, 'hook'], { env: envS, input: bash, cwd: proj });
  await serie('hub hook Read (rapido, sessao do Hub)', [BIN, 'hook'], { env: envS, input: read, cwd: proj });
  const direto = [];
  const corpoS = { sessionId: sid, cwd: proj, toolName: 'Bash', toolInput: { command: 'git status' } };
  for (let i = 0; i < 50; i++) direto.push((await req('POST', '/hooks/pretooluse', corpoS)).ms);
  const v = await req('POST', '/hooks/pretooluse', corpoS);
  out['POST /hooks/pretooluse direto (sessao, git status)'] = { ...stats(direto), verdict: v.txt.slice(0, 300) };
  const direto2 = [];
  for (let i = 0; i < 50; i++) direto2.push((await req('POST', '/hooks/pretooluse', { toolName: 'Bash', toolInput: { command: 'git status' } })).ms);
  out['POST /hooks/pretooluse direto (fora de sessao)'] = stats(direto2);
  await serie('hub status (cliente -> daemon)', [BIN, 'status'], { env });
  const c = await req('POST', `/sessions/${sid}/cancel`, {});
  out.cancel = c.status;
  await sleep(1500);
  out.shutdown = await stopDaemon(d);
  results.hookcli = out;
  save('hookcli');
}

// ---------- 6: MCP ----------
async function secMcp() {
  const { home } = fakeHome('mcp');
  const d = await startDaemon(home);
  const runs = [];
  for (let i = 0; i < 8; i++) {
    const t0 = performance.now();
    const p = spawn(process.execPath, [MCP], { env: envFor(home, { AGENTS_HUB_MCP_GRACE_MS: '0' }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = ''; const waiters = new Map();
    p.stdout.on('data', (c) => { buf += c; let k; while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); try { const m = JSON.parse(l); waiters.get(m.id)?.(m); } catch {} } });
    let err = ''; p.stderr.on('data', (c) => (err += c));
    const call = (id, method, params) => new Promise((res) => { waiters.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '0' } });
    const tInit = performance.now() - t0;
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const t1 = performance.now(); const tl = await call(2, 'tools/list', {}); const tList = performance.now() - t1;
    const t2 = performance.now(); const al = await call(3, 'tools/call', { name: 'hub_agent_list', arguments: {} }); const tCall = performance.now() - t2;
    await sleep(1000); const m = procInfo(p.pid);
    const saiu = new Promise((r) => p.once('exit', r)); const t3 = performance.now(); p.stdin.end(); await Promise.race([saiu, sleep(10000)]); const tExit = performance.now() - t3;
    if (p.exitCode === null) p.kill();
    runs.push({ tInit, tList, tCall, tExit, tools: tl.result?.tools?.length, server: init.result?.serverInfo, callOk: !al.error && !al.result?.isError, stderr: err.slice(0, 200), ...m });
  }
  await sleep(500);
  const s = await stopDaemon(d);
  results.mcp = { initMs: stats(runs.map((r) => r.tInit)), toolsListMs: stats(runs.map((r) => r.tList)), agentListCallMs: stats(runs.map((r) => r.tCall)),
    exitAfterStdinCloseMs: stats(runs.map((r) => r.tExit)), wsMB: stats(runs.map((r) => r.wsMB)), privMB: stats(runs.map((r) => r.privMB)), runs, shutdown: s };
  save('mcp');
}

// ---------- 8: rajada / SSE ----------
function openSse() {
  return new Promise((resolve, reject) => {
    const got = []; let closed = false; let buf = '';
    const rq = http.get({ host: '127.0.0.1', port: PORT, path: '/events', agent: false, headers: { accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        const now = performance.timeOrigin + performance.now();
        buf += c; let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const fr = buf.slice(0, k); buf = buf.slice(k + 2);
          const dl = fr.split('\n').find((l) => l.startsWith('data: ')); if (!dl) continue;
          try { const e = JSON.parse(dl.slice(6)); const t = e.payload?.text; if (typeof t === 'string' && t.startsWith('F|')) { const [, seq, ts] = t.split('|'); got.push({ seq: +seq, lat: now - Number(ts), recv: now, sessionId: e.sessionId }); } } catch {}
        }
      });
      res.on('close', () => { closed = true; });
      resolve({ got, rq, isClosed: () => closed });
    });
    rq.on('error', reject);
  });
}
async function secFlood() {
  const { home, proj } = fakeHome('flood');
  const d = await startDaemon(home);
  const pr = await req('POST', '/projects', { path: proj, name: 'flood' });
  const pid = pr.json.project.id;
  const out = {};
  for (const [agent, n, reps] of [['paced', 200, 5], ['burst2k', 2000, 5], ['burst20k', 20000, 5]]) {
    const runs = [];
    for (let i = 0; i < reps; i++) {
      const sse = await openSse(); await sleep(300);
      const sr = exigirSessao(await req('POST', '/sessions', { projectId: pid, brief: { agent, objective: 'agente falso que imprime uma rajada de linhas', isolation: 'none' } }));
      const sid = sr.json.session.id, tid = sr.json.task.id;
      const health = []; const tStart = performance.now(); let st;
      while (performance.now() - tStart < 300000) {
        const h = await req('GET', '/health'); health.push(h.ms);
        const t = await req('GET', `/tasks/${tid}`); st = t.json?.task?.state;
        if (['completed', 'failed', 'canceled', 'rejected'].includes(st)) break;
        await sleep(25);
      }
      const tEnd = performance.now() - tStart;
      await sleep(1500);
      const mine = sse.got.filter((g) => g.sessionId === sid);
      const lats = mine.map((g) => g.lat);
      const first = Math.min(...mine.map((g) => g.recv)), last = Math.max(...mine.map((g) => g.recv));
      const m = procInfo(d.p.pid);
      sse.rq.destroy();
      runs.push({ estado: st, recebidos: mine.length, esperado: n, sseFechadoPeloServidor: sse.isClosed(), latMed: med(lats), latP99: pct(lats, 99), latMax: Math.max(...lats), spreadMs: last - first,
        evPorSeg: mine.length > 1 ? mine.length / ((last - first) / 1000) : null, taskMs: tEnd, healthMed: med(health), healthMax: Math.max(...health), healthN: health.length, wsMB: m.wsMB, privMB: m.privMB, peakWsMB: m.peakWsMB });
      console.log(agent, i, JSON.stringify(runs.at(-1)));
      await sleep(1000);
    }
    out[agent] = { n, latMedMs: stats(runs.map((r) => r.latMed)), latP99Ms: stats(runs.map((r) => r.latP99)), latMaxMs: stats(runs.map((r) => r.latMax)),
      evPorSeg: stats(runs.map((r) => r.evPorSeg ?? 0)), healthMaxMs: stats(runs.map((r) => r.healthMax)), healthMedMs: stats(runs.map((r) => r.healthMed)),
      taskMs: stats(runs.map((r) => r.taskMs)), recebidos: runs.map((r) => r.recebidos), peakWsMB: stats(runs.map((r) => r.peakWsMB)), wsMBdepois: stats(runs.map((r) => r.wsMB)), runs };
    results.flood = out; save('flood');
  }
  const db = path.join(home, 'hub.db');
  out.dbBytes = existsSync(db) ? statSync(db).size : null;
  out.shutdown = await stopDaemon(d);
  results.flood = out; save('flood');
}

async function secProbe(){ const { home, proj } = fakeHome("probe"); const d = await startDaemon(home); const pr = await req("POST", "/projects", { path: proj, name: "bench" }); console.log(pr.status, pr.txt.slice(0,300)); const sr = await req("POST", "/sessions", { projectId: pr.json?.project?.id, brief: { agent: "lento", objective: "dormir", isolation: "none" } }); console.log(sr.status, sr.txt.slice(0,600)); await stopDaemon(d); }
async function secKids(){ const d = await startDaemon(newHome("kids")); await sleep(2000); const r = spawnSync("powershell", ["-NoProfile","-Command", 'Get-CimInstance Win32_Process -Filter ParentProcessId=' + d.p.pid + ' | select ProcessId,Name,WorkingSetSize,CommandLine | fl'], {encoding:"utf8"}); console.log(r.stdout); console.log("LOG:", JSON.stringify(d.log().slice(0,600))); console.log(JSON.stringify(await stopDaemon(d))); }
const secs = { kids: secKids, probe: secProbe, startup: secStartup, panel: secPanel, hookcli: secHookCli, mcp: secMcp, flood: secFlood };
for (const s of process.argv.slice(2)) {
  console.log(`== ${s} ${new Date().toISOString()}`);
  try { await secs[s](); } catch (e) { console.error("FALHA", s, e); for (const d of [...VIVOS]) { try { console.error("encerrando daemon", JSON.stringify(await stopDaemon(d))); } catch (e2) { d.p.kill(); console.error("kill", e2.message); } } process.exitCode = 1; continue; }
  console.log(JSON.stringify(results[s], (k, v) => (['all', 'runs', 'idle', 'freshMem'].includes(k) ? undefined : v), 1));
}

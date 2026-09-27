import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { clearBinCache, montarSpawn, resolverShimNpm, type LookupDeps } from './bin-resolver.js';
import { montarInvocacao, ProcessAgentAdapter } from './process-adapter.js';
import { loadManifestDir, loadManifestFile } from './registry.js';
import { AgentManifestSchema, type RunContext } from './types.js';

/**
 * Entrega do prompt aos CLIs — itens 0.2 e 0.3 do GOAL (docs/12-goal-mvp-completo.md),
 * achados CRÍTICOS da vistoria 2026-09-25 (10-adapters-manifestos.md):
 *
 * - 0.2: o manifesto do Antigravity não tinha `{{prompt}}` nem `stdinPrompt`,
 *   e `-p --output-format stream-json` fazia o `agy` tomar a flag como prompt.
 *   Nenhuma sessão rodava. O teste de contrato abaixo monta o argv efetivo de
 *   TODO manifesto e exige que o prompt chegue por algum caminho.
 * - 0.3: prompt em argv de um shim `.cmd` atravessava o `cmd.exe`: injeção de
 *   comando (`& echo PWN>x`), expansão de `%VAR%`, truncamento na quebra de
 *   linha, teto de 8 KB e CJK/emoji virando `?`. Os testes com agente falso
 *   `.cmd` provam que o prompt chega íntegro e que nenhum comando injetado roda.
 */

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANIFESTOS = path.join(RAIZ, 'manifests');

const CTX_BASE = {
  mode: 'supervised' as const,
  workdir: 'C:\\projeto',
  model: undefined,
  extraArgs: [],
};

const PROMPT_MARCADOR = '# Tarefa\n\nlinha 2 com "aspas" & %PATH% 日本語 😀';

test('contrato: todo manifesto entrega o prompt (argv, stdin ou arquivo) no oneShot e no resume', () => {
  const manifestos = loadManifestDir(MANIFESTOS);
  assert.ok(manifestos.length >= 9, `esperava os manifestos do repo em ${MANIFESTOS}`);

  for (const m of manifestos) {
    const templates: Array<[string, string[]]> = [['oneShot', m.invoke.oneShot]];
    if (m.invoke.resume) templates.push(['resume', m.invoke.resume]);

    for (const [nome, template] of templates) {
      const inv = montarInvocacao(
        m,
        CTX_BASE,
        template,
        PROMPT_MARCADOR,
        'sess-nativa-1',
        'C:\\tmp\\p.md',
      );
      assert.notEqual(
        inv.entrega,
        'nenhuma',
        `${m.id}.${nome}: o prompt não chega ao CLI por caminho nenhum`,
      );

      if (inv.entrega === 'argv') {
        const comPrompt = inv.args.filter((a) => a.includes(PROMPT_MARCADOR));
        assert.equal(
          comPrompt.length,
          1,
          `${m.id}.${nome}: prompt deveria aparecer em exatamente 1 argumento`,
        );
      } else {
        // stdin/arquivo: o texto do prompt NÃO pode vazar para o argv.
        assert.ok(
          inv.args.every((a) => !a.includes(PROMPT_MARCADOR)),
          `${m.id}.${nome}: prompt vai por ${inv.entrega} mas também apareceu no argv`,
        );
      }
      if (nome === 'resume') {
        assert.ok(inv.args.includes('sess-nativa-1'), `${m.id}.resume: id nativo ausente do argv`);
      }
    }
  }
});

test('antigravity: argv com o prompt anexado a -p, sem engolir --output-format', async (t) => {
  const m = loadManifestFile(path.join(MANIFESTOS, 'antigravity.yaml'));

  await t.test('oneShot', () => {
    const inv = montarInvocacao(m, CTX_BASE, m.invoke.oneShot, 'diga oi', null);
    assert.equal(inv.entrega, 'argv');
    assert.deepEqual(inv.args, ['--output-format', 'stream-json', '-p=diga oi', '--mode', 'plan']);
  });

  await t.test('resume', () => {
    const inv = montarInvocacao(m, CTX_BASE, m.invoke.resume!, 'continue', 'conv-123');
    assert.deepEqual(inv.args, [
      '--conversation',
      'conv-123',
      '--output-format',
      'stream-json',
      '-p=continue',
      '--mode',
      'plan',
    ]);
  });

  await t.test('nenhum valor de flag é uma flag (o bug: -p seguido de --output-format)', () => {
    const inv = montarInvocacao(m, { ...CTX_BASE, mode: 'semi' }, m.invoke.oneShot, 'x', null);
    const i = inv.args.indexOf('--output-format');
    assert.equal(inv.args[i + 1], 'stream-json');
    assert.ok(!inv.args.includes('-p'), '`-p` solto deixa o agy tomar o argumento seguinte como prompt');
  });

  await t.test('prompt que começa com "-" continua anexado ao -p', () => {
    const inv = montarInvocacao(m, CTX_BASE, m.invoke.oneShot, '--help me', null);
    assert.ok(inv.args.includes('-p=--help me'));
  });
});

test('mimo: prompt vai por stdin, não como posicional de `run`', () => {
  const m = loadManifestFile(path.join(MANIFESTOS, 'mimo.yaml'));
  const inv = montarInvocacao(m, CTX_BASE, m.invoke.oneShot, PROMPT_MARCADOR, null);
  assert.equal(inv.entrega, 'stdin');
  assert.deepEqual(inv.args, ['run', '--format', 'json']);
});

// --- resolverShimNpm: formas reais do cmd-shim ------------------------------

function depsDeArquivos(arquivos: Record<string, string>): LookupDeps {
  return {
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
    existsSync: (p) => p in arquivos,
    readFileSync: (p) => {
      const c = arquivos[p];
      if (c === undefined) throw new Error('ENOENT');
      return c;
    },
  };
}

const SHIM_PROG = (script: string): string =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
    '',
  ].join('\r\n');

test('resolverShimNpm reconhece os shims do npm', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = 'C:\\npm';

  await t.test('shim com _prog node + script JS vira node + script', () => {
    const script = path.join(dir, 'node_modules\\@github\\copilot\\npm-loader.js');
    const deps = depsDeArquivos({
      [path.join(dir, 'copilot.cmd')]: SHIM_PROG('node_modules\\@github\\copilot\\npm-loader.js'),
      [script]: '',
    });
    assert.deepEqual(resolverShimNpm(path.join(dir, 'copilot.cmd'), deps), {
      file: process.execPath,
      prefixArgs: [script],
    });
  });

  await t.test('node.exe ao lado do shim é preferido', () => {
    const script = path.join(dir, 'x.js');
    const deps = depsDeArquivos({
      [path.join(dir, 'x.cmd')]: SHIM_PROG('x.js'),
      [script]: '',
      [path.join(dir, 'node.exe')]: '',
    });
    assert.equal(resolverShimNpm(path.join(dir, 'x.cmd'), deps)?.file, path.join(dir, 'node.exe'));
  });

  await t.test('shim que chama um .exe direto vira o .exe', () => {
    const exe = path.join(dir, 'node_modules\\opencode-ai\\bin\\opencode.exe');
    const deps = depsDeArquivos({
      [path.join(dir, 'opencode.cmd')]:
        '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n',
      [exe]: '',
    });
    assert.deepEqual(resolverShimNpm(path.join(dir, 'opencode.cmd'), deps), {
      file: exe,
      prefixArgs: [],
    });
  });

  await t.test('interpretador que não é node, ou alvo inexistente, não desembrulha', () => {
    const shimSh = SHIM_PROG('x.sh')
      .replace('SET "_prog=node"', 'SET "_prog=sh"')
      .replace('%dp0%\\node.exe"\r\n)', '%dp0%\\sh.exe"\r\n)');
    const deps = depsDeArquivos({ [path.join(dir, 's.cmd')]: shimSh, [path.join(dir, 'x.sh')]: '' });
    assert.equal(resolverShimNpm(path.join(dir, 's.cmd'), deps), null);
    const semAlvo = depsDeArquivos({ [path.join(dir, 'y.cmd')]: SHIM_PROG('sumiu.js') });
    assert.equal(resolverShimNpm(path.join(dir, 'y.cmd'), semAlvo), null);
  });
});

test('montarSpawn nunca usa shell:true e recusa o que o cmd.exe truncaria', () => {
  const direto = montarSpawn(
    { path: 'C:\\a\\x.cmd', needsShell: false, file: 'node', prefixArgs: ['s.js'] },
    ['-p', 'a\nb'],
  );
  assert.deepEqual(direto, {
    file: 'node',
    args: ['s.js', '-p', 'a\nb'],
    shell: false,
    windowsVerbatimArguments: false,
  });

  const viaCmd = montarSpawn({ path: 'C:\\a b\\x.cmd', needsShell: true }, ['-p', 'a & b']);
  assert.equal(viaCmd.shell, false);
  assert.equal(viaCmd.windowsVerbatimArguments, true);
  assert.throws(
    () => montarSpawn({ path: 'C:\\x.cmd', needsShell: true }, ['linha1\nlinha2']),
    /quebra de linha/,
  );
  assert.throws(
    () => montarSpawn({ path: 'C:\\x.cmd', needsShell: true }, ['a'.repeat(9000)]),
    /excede o limite/,
  );
});

// --- Agente falso `.cmd` de verdade, via ProcessAgentAdapter -----------------

const HOSTIS_LINHA_UNICA = [
  '& echo PWN>x',
  'a&echo>x',
  'x" & echo PWN>x & "',
  'diz "oi" com \\"barra\\" \\',
  'valor %PATH% e %USERNAME% fim',
  'atraso !x! e !PATH!',
  'circunflexo ^ ^^ ^& | < > ( ) ; , ` *?',
  'olá ção 日本語 😀',
];
const HOSTIS_SO_SEM_CMD = [
  'linha1\nlinha2 & echo PWN>x\nlinha3',
  'crlf1\r\ncrlf2',
  `${'0123456789'.repeat(1024)} & echo PWN>x`, // 10 KB + injeção no fim
];

let tmp = '';
let workdir = '';
let pathOriginal: string | undefined;
const sufixo = `${process.pid}${Date.now().toString(36)}`;
const BIN_SHIM = `fakeshim${sufixo}`;
const BIN_BAT = `fakebat${sufixo}`;

before(() => {
  clearBinCache();
  if (process.platform !== 'win32') return;
  tmp = mkdtempSync(path.join(os.tmpdir(), 'hub-prompt-'));
  workdir = path.join(tmp, 'work');
  mkdirSync(workdir);
  const pacote = path.join(tmp, 'node_modules', 'fake-agent');
  mkdirSync(pacote, { recursive: true });
  // Grava argv e stdin recebidos, em UTF-8, no arquivo de FAKE_OUT.
  writeFileSync(
    path.join(pacote, 'rec.js'),
    [
      "const fs = require('node:fs');",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => (stdin += c));",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), stdin }), 'utf8');",
      '});',
    ].join('\n'),
  );
  // Shim no formato exato que o npm gera (copilot/codex/mimo/openclaude).
  writeFileSync(path.join(tmp, `${BIN_SHIM}.cmd`), SHIM_PROG('node_modules\\fake-agent\\rec.js'));
  // `.cmd` que NÃO é shim do npm (não dá para desembrulhar): obriga o caminho
  // `cmd.exe` com escape. Repassa `%*` — o reparse que fazia a injeção.
  writeFileSync(
    path.join(tmp, `${BIN_BAT}.cmd`),
    `@echo off\r\nset "REC=%~dp0node_modules\\fake-agent\\rec.js"\r\n"${process.execPath}" "%REC%" %*\r\n`,
  );
  pathOriginal = process.env['PATH'];
  process.env['PATH'] = `${tmp};${pathOriginal ?? ''}`;
});

after(() => {
  clearBinCache();
  if (process.platform !== 'win32') return;
  process.env['PATH'] = pathOriginal;
  rmSync(tmp, { recursive: true, force: true });
});

function ctxDe(agentId: string, out: string): RunContext {
  return {
    sessionId: `ses-${agentId}`,
    taskId: null,
    agentId,
    workdir,
    mode: 'autonomous',
    env: { FAKE_OUT: out },
    timeoutSeconds: 30,
    heartbeatSeconds: 30,
  };
}

function nenhumArquivoInjetado(): void {
  for (const dir of [workdir, tmp]) {
    const suspeitos = readdirSync(dir).filter((f) => /^(x|PWN.*)$/i.test(f));
    assert.deepEqual(suspeitos, [], `comando injetado criou arquivo(s) em ${dir}`);
  }
}

async function rodar(
  bin: string,
  prompt: string,
  stdinPrompt = false,
): Promise<{ argv: string[]; stdin: string }> {
  const agentId = `a${Math.random().toString(36).slice(2, 8)}`;
  const adapter = new ProcessAgentAdapter(
    AgentManifestSchema.parse({
      id: agentId,
      name: 'fake',
      bin,
      invoke: { oneShot: stdinPrompt ? ['run'] : ['-p', '{{prompt}}'], stdinPrompt },
    }),
  );
  const out = path.join(tmp, `${agentId}.json`);
  const handle = await adapter.start(ctxDe(agentId, out), prompt);
  const outcome = await handle.done;
  assert.ok(existsSync(out), `o agente falso não gravou nada (outcome: ${JSON.stringify(outcome)})`);
  return JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; stdin: string };
}

test(
  'shim .cmd do npm: prompt hostil chega íntegro em argv, sem executar nada',
  { skip: process.platform !== 'win32' },
  async (t) => {
    for (const prompt of [...HOSTIS_LINHA_UNICA, ...HOSTIS_SO_SEM_CMD]) {
      await t.test(JSON.stringify(prompt.slice(0, 40)), async () => {
        const r = await rodar(BIN_SHIM, prompt);
        assert.deepEqual(r.argv, ['-p', prompt]);
        nenhumArquivoInjetado();
      });
    }
  },
);

test(
  'shim .cmd do npm: prompt por stdin chega íntegro',
  { skip: process.platform !== 'win32' },
  async () => {
    const prompt = `${PROMPT_MARCADOR}\n& echo PWN>x\n${'z'.repeat(20000)}`;
    const r = await rodar(BIN_SHIM, prompt, true);
    assert.deepEqual(r.argv, ['run']);
    assert.equal(r.stdin, prompt);
    nenhumArquivoInjetado();
  },
);

test(
  '.cmd desconhecido (via cmd.exe escapado): sem injeção e sem expansão',
  { skip: process.platform !== 'win32' },
  async (t) => {
    for (const prompt of HOSTIS_LINHA_UNICA) {
      await t.test(JSON.stringify(prompt), async () => {
        const r = await rodar(BIN_BAT, prompt);
        assert.deepEqual(r.argv, ['-p', prompt]);
        nenhumArquivoInjetado();
      });
    }
  },
);

test(
  '.cmd desconhecido: multilinha/longo demais é recusado, não truncado',
  { skip: process.platform !== 'win32' },
  async (t) => {
    for (const prompt of HOSTIS_SO_SEM_CMD) {
      await t.test(JSON.stringify(prompt.slice(0, 20)), async () => {
        await assert.rejects(
          rodar(BIN_BAT, prompt),
          (err: Error & { code?: string }) =>
            err.code === 'ADAPTER_FAILURE' && /com segurança/.test(err.message),
        );
        nenhumArquivoInjetado();
      });
    }
  },
);

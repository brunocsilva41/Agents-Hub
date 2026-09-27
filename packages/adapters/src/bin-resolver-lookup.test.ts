import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BIN_CACHE_NEGATIVO_MS,
  candidatosNoPath,
  clearBinCache,
  resolveBin,
  type LookupDeps,
} from './bin-resolver.js';
import { AgentRegistry } from './registry.js';
import { AgentManifestSchema } from './types.js';

// `resolveBin`/`lookup` decidem, entre vários candidatos do PATH, qual caminho
// de fato usar — foi exatamente essa escolha que já causou dois incidentes
// reais documentados em docs/02-roadmap.md (Fase 1 e Fase 2). Os testes
// abaixo fixam `process.platform` para exercitar os dois ramos (Windows e
// POSIX) independente de onde rodam, e injetam PATH/disco falsos.
//
// No Windows a resolução NÃO usa mais `where` (a saída vinha na code page OEM
// e era lida como UTF-8, corrompendo caminhos com acento — vistoria
// 2026-09-25, relatório 10): varre PATH × PATHEXT em JS. Os testes "com disco
// de verdade" no fim do arquivo provam isso com um diretório acentuado.
function comoPlataforma<T>(plataforma: 'win32' | 'linux', fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: plataforma });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original as PropertyDescriptor);
  }
}

/** Disco falso: só os `arquivos` existem; PATH/PATHEXT do `env` dado. */
function depsWin(
  arquivos: string[],
  env: NodeJS.ProcessEnv,
  extra: Partial<LookupDeps> = {},
): LookupDeps & { consultas: string[] } {
  const existe = new Set(arquivos.map((a) => a.toLowerCase()));
  const consultas: string[] = [];
  return {
    consultas,
    execFileAsync: async () => {
      throw new Error('where/which não deve ser chamado no Windows');
    },
    existsSync: (p: string) => {
      consultas.push(p);
      return existe.has(p.toLowerCase());
    },
    readFileSync: () => {
      throw new Error('sem shim');
    },
    env,
    ...extra,
  };
}

const PATHEXT = '.COM;.EXE;.BAT;.CMD';

function depsQueDevolvem(stdout: string, chamadas: { count: number }): LookupDeps {
  return {
    execFileAsync: async () => {
      chamadas.count += 1;
      return { stdout, stderr: '' };
    },
    existsSync: () => false,
  };
}

test('preferência de ordem entre candidatos no Windows (varredura do PATH)', async (t) => {
  await t.test('.exe vence mesmo estando num diretório posterior ao do .cmd', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const deps = depsWin(['C:\\npm\\codexa.cmd', 'C:\\real\\codexa.exe'], {
        PATH: 'C:\\npm;C:\\real',
        PATHEXT,
      });
      const resolved = await resolveBin('codexa', deps);
      assert.equal(resolved?.path, 'C:\\real\\codexa.exe');
      assert.equal(resolved?.needsShell, false);
    });
  });

  await t.test('.cmd/.bat vence sobre o script sem extensão do npm', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      // Caso real documentado: a pasta do npm tem o script sh sem extensão
      // (para o Git Bash) E o shim .cmd. O Windows não sabe executar o
      // primeiro.
      const deps = depsWin(['C:\\npm\\codexb', 'C:\\npm\\codexb.cmd'], { PATH: 'C:\\npm', PATHEXT });
      const resolved = await resolveBin('codexb', deps);
      assert.equal(resolved?.path, 'C:\\npm\\codexb.cmd');
      assert.equal(resolved?.needsShell, true);
    });
  });

  await t.test('sem .exe nem .cmd/.bat, cai para o arquivo sem extensão', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const deps = depsWin(['C:\\npm\\codexc'], { PATH: 'C:\\npm', PATHEXT });
      const resolved = await resolveBin('codexc', deps);
      assert.equal(resolved?.path, 'C:\\npm\\codexc');
      assert.equal(resolved?.needsShell, false);
    });
  });

  await t.test('PATH/PATHEXT com chave em outra caixa (`Path`) e entradas entre aspas', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const deps = depsWin(['C:\\Program Files\\x\\codexd.exe'], {
        Path: '"C:\\Program Files\\x";;',
        PathExt: '.EXE',
      });
      const resolved = await resolveBin('codexd', deps);
      assert.equal(resolved?.path, 'C:\\Program Files\\x\\codexd.exe');
    });
  });

  await t.test('o diretório corrente NÃO entra na busca (diferente do `where`)', () => {
    comoPlataforma('win32', () => {
      const plantado = path.win32.join(process.cwd(), 'codexe.cmd');
      const deps = depsWin([plantado], { PATH: 'C:\\vazio', PATHEXT });
      assert.deepEqual(candidatosNoPath('codexe', deps), []);
    });
  });
});

test('ramo POSIX usa which e a primeira linha, sem lógica de extensão', async (t) => {
  await t.test('primeira linha do which é usada e needsShell é sempre false', async () => {
    clearBinCache();
    await comoPlataforma('linux', async () => {
      const deps = depsQueDevolvem('/usr/local/bin/codex\n/usr/bin/codex\n', {
        count: 0,
      });
      const resolved = await resolveBin('codex-posix-test-1', deps);
      assert.equal(resolved?.path, '/usr/local/bin/codex');
      assert.equal(resolved?.needsShell, false);
    });
  });

  await t.test('which falhando devolve null (sem fallback fora do Windows)', async () => {
    clearBinCache();
    await comoPlataforma('linux', async () => {
      const deps: LookupDeps = {
        execFileAsync: async () => {
          throw new Error('which não encontrou nada');
        },
        existsSync: () => false,
      };
      const resolved = await resolveBin('codex-posix-test-2', deps);
      assert.equal(resolved, null);
    });
  });
});

test('cache de resolução', async (t) => {
  await t.test(
    'positivo: segunda chamada não varre o PATH de novo enquanto o arquivo existe',
    async () => {
      clearBinCache();
      await comoPlataforma('win32', async () => {
        const deps = depsWin(['C:\\real\\codexf.exe'], { PATH: 'C:\\real', PATHEXT });
        const primeira = await resolveBin('codexf', deps);
        const consultasAposPrimeira = deps.consultas.length;
        const segunda = await resolveBin('codexf', deps);
        assert.deepEqual(primeira, segunda);
        // Só a checagem de existência do caminho cacheado, nenhuma varredura.
        assert.equal(deps.consultas.length, consultasAposPrimeira + 1);
      });
    },
  );

  await t.test(
    'positivo: binário removido do disco é procurado de novo (não spawna caminho morto)',
    async () => {
      clearBinCache();
      await comoPlataforma('win32', async () => {
        const arquivos = ['C:\\a\\codexg.exe', 'C:\\b\\codexg.exe'];
        const existe = new Set(arquivos.map((a) => a.toLowerCase()));
        const deps: LookupDeps = {
          ...depsWin([], { PATH: 'C:\\a;C:\\b', PATHEXT }),
          existsSync: (p) => existe.has(p.toLowerCase()),
        };
        assert.equal((await resolveBin('codexg', deps))?.path, 'C:\\a\\codexg.exe');
        existe.delete('c:\\a\\codexg.exe');
        assert.equal((await resolveBin('codexg', deps))?.path, 'C:\\b\\codexg.exe');
      });
    },
  );

  await t.test('negativo expira: agente instalado depois do boot é achado após o TTL', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      let agora = 1_000_000;
      const existe = new Set<string>();
      const deps: LookupDeps = {
        ...depsWin([], { PATH: 'C:\\novo', PATHEXT, LOCALAPPDATA: 'C:\\nada', APPDATA: 'C:\\nada' }),
        existsSync: (p) => existe.has(p.toLowerCase()),
        now: () => agora,
      };
      assert.equal(await resolveBin('codexh', deps), null);

      existe.add('c:\\novo\\codexh.exe'); // "instalou" o agente
      agora += 1_000;
      assert.equal(await resolveBin('codexh', deps), null, 'dentro do TTL o não-achado vale');

      agora += BIN_CACHE_NEGATIVO_MS;
      assert.equal((await resolveBin('codexh', deps))?.path, 'C:\\novo\\codexh.exe');
    });
  });

  await t.test('clearBinCache(bin) esquece só aquele binário', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const existe = new Set<string>();
      const deps: LookupDeps = {
        ...depsWin([], { PATH: 'C:\\novo', PATHEXT, LOCALAPPDATA: 'C:\\nada', APPDATA: 'C:\\nada' }),
        existsSync: (p) => existe.has(p.toLowerCase()),
        now: () => 5,
      };
      assert.equal(await resolveBin('codexi', deps), null);
      existe.add('c:\\novo\\codexi.exe');
      clearBinCache('codexi');
      assert.equal((await resolveBin('codexi', deps))?.path, 'C:\\novo\\codexi.exe');
    });
  });
});

test('fallback do Windows quando o PATH não tem o binário', async (t) => {
  await t.test('tenta os 5 caminhos hardcoded na ordem certa e usa o primeiro que existir', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const home = os.homedir();
      const candidato3 = path.join(home, '.local', 'bin', 'codex-fb-test.exe');
      const originalLocalAppData = process.env['LOCALAPPDATA'];
      const originalAppData = process.env['APPDATA'];
      process.env['LOCALAPPDATA'] = 'C:\\Users\\fake\\AppData\\Local';
      process.env['APPDATA'] = 'C:\\Users\\fake\\AppData\\Roaming';
      try {
        const tentativas: string[] = [];
        const deps: LookupDeps = {
          ...depsWin([], { PATH: '', PATHEXT }),
          existsSync: (p: string) => {
            tentativas.push(p);
            return p === candidato3;
          },
        };

        const resolved = await resolveBin('codex-fb-test', deps);
        assert.equal(resolved?.path, candidato3);
        assert.equal(resolved?.needsShell, false);

        // Confirma a ORDEM: os dois primeiros caminhos (agy, Programs) são
        // tentados e rejeitados antes do terceiro (.local/bin) ser aceito.
        assert.equal(tentativas.length, 3);
        assert.ok(tentativas[0]?.includes(path.join('agy', 'bin')));
        assert.ok(tentativas[1]?.includes(path.join('Programs', 'codex-fb-test')));
        assert.equal(tentativas[2], candidato3);
      } finally {
        if (originalLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
        else process.env['LOCALAPPDATA'] = originalLocalAppData;
        if (originalAppData === undefined) delete process.env['APPDATA'];
        else process.env['APPDATA'] = originalAppData;
      }
    });
  });

  await t.test('nada no PATH nem nos 5 caminhos: devolve null', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const deps = depsWin([], { PATH: 'C:\\vazio', PATHEXT });
      assert.equal(await resolveBin('codex-fb-null-test', deps), null);
    });
  });
});

// --- Disco e PATH de verdade (só Windows) -----------------------------------

const ehWindows = process.platform === 'win32';

/** Diretório temporário com acento no caminho (`...\Tëst Ação\bin`). */
function dirAcentuado(): { raiz: string; bin: string } {
  const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-bin-'));
  const bin = path.join(raiz, 'Tëst Ação', 'bin');
  mkdirSync(bin, { recursive: true });
  return { raiz, bin };
}

function comPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env['PATH'];
  process.env['PATH'] = `${dir};${original ?? ''}`;
  return fn().finally(() => {
    process.env['PATH'] = original;
  });
}

test(
  'caminho com acento no PATH é resolvido íntegro (sem `where`/code page OEM)',
  { skip: !ehWindows },
  async () => {
    const { raiz, bin } = dirAcentuado();
    const nome = `fakeacento${process.pid}`;
    const esperado = path.join(bin, `${nome}.cmd`);
    writeFileSync(esperado, '@echo off\r\necho fake 1.2.3\r\n');
    try {
      clearBinCache();
      const resolved = await comPath(bin, () => resolveBin(nome));
      assert.equal(resolved?.path, esperado);
      assert.ok(existsSync(resolved.path), 'o caminho devolvido tem de existir de verdade');
    } finally {
      clearBinCache();
      rmSync(raiz, { recursive: true, force: true });
    }
  },
);

test(
  'registry: agente instalado depois do boot aparece no probe forçado, com caminho acentuado',
  { skip: !ehWindows },
  async () => {
    const { raiz, bin } = dirAcentuado();
    const nome = `fakeinstala${process.pid}`;
    const manifest = AgentManifestSchema.parse({
      id: 'fake-instala',
      name: 'Fake',
      bin: nome,
      detect: { timeoutMs: 20_000 },
      invoke: { oneShot: ['-p'] },
    });
    try {
      clearBinCache();
      await comPath(bin, async () => {
        const registry = new AgentRegistry();
        registry.register(manifest);

        const antes = await registry.probe('fake-instala', true);
        assert.equal(antes.installed, false);

        // "Instala" o agente com o daemon no ar.
        writeFileSync(path.join(bin, `${nome}.cmd`), '@echo off\r\necho fake 1.2.3\r\n');

        const depois = await registry.probe('fake-instala', true);
        assert.equal(
          depois.installed,
          true,
          `probe forçado não achou o agente recém-instalado: ${depois.error}`,
        );
        assert.equal(depois.binPath, path.join(bin, `${nome}.cmd`));
        assert.equal(depois.version, '1.2.3');
      });
    } finally {
      clearBinCache();
      rmSync(raiz, { recursive: true, force: true });
    }
  },
);

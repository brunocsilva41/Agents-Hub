import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { clearBinCache, resolveBin, type LookupDeps } from './bin-resolver.js';

// `resolveBin`/`lookup` decidem, entre vários candidatos que `where`/`which`
// devolvem, qual caminho de fato usar — foi exatamente essa escolha que já
// causou dois incidentes reais documentados em docs/02-roadmap.md (Fase 1 e
// Fase 2). Os testes abaixo fixam `process.platform` para exercitar os dois
// ramos (Windows e POSIX) independente de onde rodam, e injetam
// `execFileAsync`/`existsSync` fake em vez de tocar o disco ou o `where`/
// `which` reais.
function comoPlataforma<T>(plataforma: 'win32' | 'linux', fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: plataforma });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original as PropertyDescriptor);
  }
}

function depsQueDevolvem(stdout: string, chamadas: { count: number }): LookupDeps {
  return {
    execFileAsync: async () => {
      chamadas.count += 1;
      return { stdout, stderr: '' };
    },
    existsSync: () => false,
  };
}

function depsQueFalham(existsMap: Record<string, boolean> = {}): LookupDeps {
  return {
    execFileAsync: async () => {
      throw new Error('where/which não encontrou nada');
    },
    existsSync: (p: string) => existsMap[p] ?? false,
  };
}

test('preferência de ordem entre candidatos no Windows', async (t) => {
  await t.test('.exe vence mesmo aparecendo depois de .cmd/.bat na saída', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const deps = depsQueDevolvem(
        'C:\\npm\\codex.cmd\r\nC:\\real\\codex.exe\r\n',
        { count: 0 },
      );
      const resolved = await resolveBin('codex-exe-test-1', deps);
      assert.equal(resolved?.path, 'C:\\real\\codex.exe');
      assert.equal(resolved?.needsShell, false);
    });
  });

  await t.test('.cmd/.bat vence sobre a primeira linha crua sem extensão', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      // Caso real documentado: `where codex` devolve primeiro o shim sem
      // extensão (script sh do Git Bash) e depois o .cmd de verdade — o
      // Windows não sabe executar o primeiro.
      const deps = depsQueDevolvem(
        'C:\\npm\\codex\r\nC:\\npm\\codex.cmd\r\n',
        { count: 0 },
      );
      const resolved = await resolveBin('codex-cmd-test-2', deps);
      assert.equal(resolved?.path, 'C:\\npm\\codex.cmd');
      assert.equal(resolved?.needsShell, true);
    });
  });

  await t.test('sem .exe nem .cmd/.bat, cai para a primeira linha crua', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const deps = depsQueDevolvem('C:\\npm\\codex\r\n', { count: 0 });
      const resolved = await resolveBin('codex-raw-test-3', deps);
      assert.equal(resolved?.path, 'C:\\npm\\codex');
      assert.equal(resolved?.needsShell, false);
    });
  });

  await t.test('reverter a preferência (.cmd antes de .exe) faria este teste falhar', async () => {
    // Não é teste de fachada: se a ordem de preferência em bin-resolver.ts
    // fosse trocada para `.cmd` > `.exe`, esta asserção quebraria.
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const deps = depsQueDevolvem(
        'C:\\npm\\codex.cmd\r\nC:\\real\\codex.exe\r\n',
        { count: 0 },
      );
      const resolved = await resolveBin('codex-exe-test-4', deps);
      assert.notEqual(resolved?.path, 'C:\\npm\\codex.cmd');
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
      const deps = depsQueFalham();
      const resolved = await resolveBin('codex-posix-test-2', deps);
      assert.equal(resolved, null);
    });
  });
});

test('cache evita rechamar execFileAsync para o mesmo binário', async (t) => {
  await t.test('segunda chamada para o mesmo bin usa o cache, não rechama', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const chamadas = { count: 0 };
      const deps = depsQueDevolvem('C:\\real\\codex.exe\r\n', chamadas);

      const primeira = await resolveBin('codex-cache-test', deps);
      const segunda = await resolveBin('codex-cache-test', deps);

      assert.equal(chamadas.count, 1);
      assert.deepEqual(primeira, segunda);
    });
  });

  await t.test('clearBinCache() limpa de fato: próxima chamada rechama execFileAsync', async () => {
    await comoPlataforma('win32', async () => {
      const chamadas = { count: 0 };
      const deps = depsQueDevolvem('C:\\real\\codex.exe\r\n', chamadas);

      await resolveBin('codex-clear-test', deps);
      assert.equal(chamadas.count, 1);

      clearBinCache();

      await resolveBin('codex-clear-test', deps);
      assert.equal(chamadas.count, 2);
    });
  });
});

test('fallback do Windows quando where/which falha', async (t) => {
  await t.test(
    'tenta os 5 caminhos hardcoded na ordem certa e usa o primeiro que existir',
    async () => {
      clearBinCache();
      await comoPlataforma('win32', async () => {
        const originalLocalAppData = process.env['LOCALAPPDATA'];
        const originalAppData = process.env['APPDATA'];
        process.env['LOCALAPPDATA'] = 'C:\\Users\\fake\\AppData\\Local';
        process.env['APPDATA'] = 'C:\\Users\\fake\\AppData\\Roaming';
        try {
          const home = os.homedir();
          const candidato3 = path.join(home, '.local', 'bin', 'codex-fb-test.exe');

          const tentativas: string[] = [];
          const deps: LookupDeps = {
            execFileAsync: depsQueFalham().execFileAsync,
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
    },
  );

  await t.test('nenhum dos 5 caminhos existe: devolve null', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const deps = depsQueFalham();
      const resolved = await resolveBin('codex-fb-null-test', deps);
      assert.equal(resolved, null);
    });
  });

  await t.test('where/which devolvendo string vazia também cai no fallback', async () => {
    clearBinCache();
    await comoPlataforma('win32', async () => {
      const chamadas = { count: 0 };
      const deps: LookupDeps = {
        execFileAsync: async () => {
          chamadas.count += 1;
          return { stdout: '   \r\n  \r\n', stderr: '' };
        },
        existsSync: () => false,
      };
      const resolved = await resolveBin('codex-empty-test', deps);
      assert.equal(chamadas.count, 1);
      assert.equal(resolved, null);
    });
  });
});

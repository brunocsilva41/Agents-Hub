import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quoteForShell } from './bin-resolver.js';

// `quoteForShell` só age no Windows; fora dele é identidade. Os testes abaixo
// descrevem o contrato de quoting do Windows independente da plataforma onde
// rodam, então fixam `process.platform` para exercitar o caminho real.
function comoWindows<T>(fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original as PropertyDescriptor);
  }
}

test('quoteForShell no Windows', async (t) => {
  await t.test('valor simples sem espaço nem aspas não é envolto', () => {
    comoWindows(() => {
      assert.equal(quoteForShell('C:\\bin\\codex.exe'), 'C:\\bin\\codex.exe');
    });
  });

  await t.test('espaço simples vira aspas ao redor, sem tocar as barras', () => {
    comoWindows(() => {
      assert.equal(
        quoteForShell('C:\\Program Files\\nodejs\\node.exe'),
        '"C:\\Program Files\\nodejs\\node.exe"',
      );
    });
  });

  await t.test('aspas embutida é escapada sem barra antes', () => {
    comoWindows(() => {
      assert.equal(quoteForShell('diz "oi"'), '"diz \\"oi\\""');
    });
  });

  await t.test('barra antes de aspas embutida dobra, em vez de absorver a aspas', () => {
    // Caso que quebrava antes da correção: uma barra seguida de aspas virava
    // `\"`, que o parser de argv do processo filho lê como aspas literal —
    // não como fechamento de aspas — e o argumento seguinte parte no espaço
    // errado.
    comoWindows(() => {
      assert.equal(quoteForShell('a\\"b'), '"a\\\\\\"b"');
    });
  });

  await t.test('barras no fim do valor dobram antes da aspas de fechamento', () => {
    // Precisa de um espaço em algum lugar para forçar o quoting — sem isso
    // `C:\dir\` não tem ambiguidade nenhuma e sai sem aspas.
    comoWindows(() => {
      assert.equal(quoteForShell('C:\\a dir\\'), '"C:\\a dir\\\\"');
    });
  });

  await t.test(
    'reproduz o valor exato do -c hooks= do gate do Codex com caminhos com espaço',
    () => {
      // O mesmo formato que `codex-gate.ts` monta: comando entre aspas TOML já
      // escapadas (`\"...\"`), com caminhos reais desta máquina que têm espaço
      // ("Program Files", "Bruno Silva") — o caso que falhou contra o binário
      // real antes da correção.
      const comando =
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Bruno Silva\\Documents\\Projetos\\Agents-Hub\\packages\\cli\\dist\\main.js" hook --dialect codex';
      const tomlEscapado = comando.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const valorDoHooks = `hooks={PreToolUse=[{matcher="*",hooks=[{type="command",command="${tomlEscapado}",timeoutSec=20}]}]}`;

      const quotado = comoWindows(() => quoteForShell(valorDoHooks));

      // O teste que importa: reconstruir o argv como o processo filho faria
      // (regra do CommandLineToArgvW) e conferir que volta ao valor original.
      assert.equal(desfazerQuoteDeArgv(quotado), valorDoHooks);
    },
  );
});

/**
 * Desfaz o quoting de um único argumento de linha de comando do Windows,
 * seguindo a mesma regra que `CommandLineToArgvW` usa para parsear — o
 * inverso do que `quoteForShell` produz. Usado só para verificar, nos testes,
 * que o round-trip preserva o valor original.
 */
function desfazerQuoteDeArgv(quotado: string): string {
  assert.ok(quotado.startsWith('"') && quotado.endsWith('"'), 'esperava valor entre aspas');
  const meio = quotado.slice(1, -1);
  let resultado = '';
  let backslashes = 0;
  for (const ch of meio) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      resultado += '\\'.repeat(Math.floor(backslashes / 2));
      // Backslashes ímpares antes de uma aspas: a aspas é literal.
      if (backslashes % 2 === 1) {
        resultado += '"';
      }
    } else {
      resultado += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  resultado += '\\'.repeat(backslashes);
  return resultado;
}

import type { Args } from './cmd-util.js';

/**
 * Parser de argumentos da CLI — fora de `main.ts` para ser testável sem
 * disparar `main()` (o import de `main.ts` roda o comando).
 */

/**
 * Flags sem valor precisam ser declaradas: sem isso, `--detach "objetivo"`
 * consome o objetivo como valor de `--detach` e o comando falha dizendo que
 * faltou o objetivo — que estava lá o tempo todo.
 */
export const BOOLEAN_FLAGS = new Set([
  'detach', 'json', 'force', 'help', 'quiet', 'write', 'smoke', 'clear', 'overwrite', 'include-env', 'refresh',
  // Item 5.6 (init/logs/open/update/export/cost/merge/restore).
  'yes', 'follow', 'dry-run', 'list', 'print', 'check', 'all', 'raw',
  // R14-14: desliga o alerta de aprovação (bipe + título do terminal).
  'no-bell',
  // `--verbose` em start/watch/send: mostra deltas e eventos técnicos.
  'verbose',
]);

/**
 * `--` encerra as flags (convenção POSIX): tudo depois dele é posicional,
 * mesmo começando com `--`. Sem isto, `hub start --agent x -- "--fix ..."`
 * dizia "faltou o objetivo" e um objetivo iniciado com `--` virava flag
 * (vistoria 07, R07-20).
 */
export function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? '';
    if (token === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    // Forma explícita `--chave=valor` sempre vence a heurística.
    const equals = token.indexOf('=');
    if (equals > 2) {
      flags[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }

    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }

    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }

  return { command, positional, flags };
}

#!/usr/bin/env node
/**
 * A suíte inteira com medição de cobertura (item 7.2 do GOAL): mesmos arquivos
 * de `npm test`, rodados com `--experimental-test-coverage` do próprio Node —
 * sem dependência nova. Os `dist/*.js` têm source map, então o relatório fala
 * dos `.ts` de `src/`, não do JavaScript compilado.
 *
 * Saída:
 * - `coverage/lcov.info` (para quem quiser abrir num visualizador);
 * - um resumo por pacote (linhas, branches, funções) no fim do stdout.
 *
 * Não impõe meta ainda: medir vem antes de exigir. Sai com o código da suíte,
 * para uma falha de teste não virar "cobertura verde".
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { descobrirTestes, raizDoRepo } from './test-files.mjs';

const arquivos = descobrirTestes();
if (arquivos.length === 0) {
  console.error('Nenhum teste encontrado em packages/*/dist. Rode `npm run build:packages` antes.');
  process.exit(1);
}

const dirSaida = path.join(raizDoRepo, 'coverage');
mkdirSync(dirSaida, { recursive: true });
const lcov = path.join(dirSaida, 'lcov.info');

console.error(`Rodando ${arquivos.length} arquivos de teste com cobertura.`);

const filho = spawn(
  process.execPath,
  [
    '--test',
    '--experimental-sqlite',
    '--experimental-test-coverage',
    '--enable-source-maps',
    // O que interessa é o código de produção: testes, dependências e o
    // bundle do Vite ficam de fora da conta.
    '--test-coverage-exclude=**/*.test.*',
    '--test-coverage-exclude=**/node_modules/**',
    '--test-coverage-exclude=**/e2e/**',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcov}`,
    ...arquivos,
  ],
  { stdio: 'inherit', cwd: raizDoRepo },
);

filho.on('error', (err) => {
  console.error(`Não foi possível iniciar o runner: ${err.message}`);
  process.exit(1);
});

filho.on('exit', (code, signal) => {
  const status = code ?? (signal ? 1 : 0);
  try {
    imprimirResumo(readFileSync(lcov, 'utf8'));
  } catch (err) {
    console.error(`Sem relatório de cobertura legível em ${lcov}: ${err.message}`);
    process.exit(status || 1);
  }
  process.exit(status);
});

/** Agrega o lcov por pacote (`packages/<nome>/...`). */
function imprimirResumo(texto) {
  const porPacote = new Map();
  let atual = null;
  for (const linha of texto.split(/\r?\n/)) {
    if (linha.startsWith('SF:')) {
      const arquivo = linha.slice(3).replaceAll('\\', '/');
      // O lcov do Node grava caminho relativo à raiz (`packages\cli\src\...`
      // no Windows) ou absoluto, dependendo da versão: aceita os dois.
      const m = /(?:^|\/)packages\/([^/]+)\//.exec(arquivo);
      atual = m ? m[1] : null;
      if (atual && !porPacote.has(atual)) {
        porPacote.set(atual, { arquivos: 0, lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 });
      }
      if (atual) porPacote.get(atual).arquivos += 1;
      continue;
    }
    if (!atual) continue;
    const [chave, valor] = linha.split(':');
    const n = Number(valor);
    const p = porPacote.get(atual);
    if (chave === 'LF') p.lf += n;
    else if (chave === 'LH') p.lh += n;
    else if (chave === 'BRF') p.brf += n;
    else if (chave === 'BRH') p.brh += n;
    else if (chave === 'FNF') p.fnf += n;
    else if (chave === 'FNH') p.fnh += n;
  }

  const pct = (h, f) => (f === 0 ? '   -  ' : `${((100 * h) / f).toFixed(1).padStart(5)}%`);
  const total = { arquivos: 0, lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
  const linhas = [];
  for (const [nome, p] of [...porPacote].sort(([a], [b]) => a.localeCompare(b))) {
    for (const k of Object.keys(total)) total[k] += p[k];
    linhas.push(
      `${nome.padEnd(10)} ${String(p.arquivos).padStart(8)}  ${pct(p.lh, p.lf)}  ${pct(p.brh, p.brf)}  ${pct(p.fnh, p.fnf)}`,
    );
  }
  console.log('\nCobertura por pacote (código de produção, `src/`):');
  console.log(`${'pacote'.padEnd(10)} ${'arquivos'.padStart(8)}  linhas  branches  funções`);
  for (const l of linhas) console.log(l);
  console.log(
    `${'TOTAL'.padEnd(10)} ${String(total.arquivos).padStart(8)}  ${pct(total.lh, total.lf)}  ${pct(total.brh, total.brf)}  ${pct(total.fnh, total.fnf)}`,
  );
  console.log(`\nlcov: ${path.relative(raizDoRepo, lcov)}`);
}

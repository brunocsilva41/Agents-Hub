#!/usr/bin/env node
/**
 * Roda a suíte inteira, de forma igual em todo shell.
 *
 * Existe por um motivo concreto: `node --test packages/*​/dist/**​/*.test.js`
 * depende de QUEM expande o glob. No PowerShell e no cmd, a string chega
 * intacta ao Node, que a expande certo e coleta os 29 arquivos. No bash, o
 * shell expande primeiro — e como `**` sem `globstar` vale por um `*` só,
 * `packages/*​/dist/**​/*.test.js` casa apenas o que está a exatamente dois
 * níveis: **3 arquivos**. A saída fica verde, o portão diz "passou", e todo o
 * domínio (política, orçamento, grafo, resiliência) e todo o daemon nunca
 * rodaram.
 *
 * Um portão que protege menos do que diz proteger é pior que nenhum, porque
 * compra confiança que não tem lastro. Aqui a descoberta é feita em JavaScript,
 * onde nenhum shell opina.
 *
 * `--experimental-sqlite` vai junto porque `node:sqlite` ainda exige a flag no
 * Node 22, que é o mínimo declarado em `engines`. No 24 ela é aceita e ignorada.
 */
import { spawn } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raizDoRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pacotes = path.join(raizDoRepo, 'packages');

/** Todos os `*.test.js` sob o `dist/` de cada pacote, em qualquer profundidade. */
function encontrarTestes(dir) {
  const achados = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const completo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) achados.push(...encontrarTestes(completo));
    else if (entrada.name.endsWith('.test.js')) achados.push(completo);
  }
  return achados;
}

const arquivos = [];
for (const pacote of readdirSync(pacotes, { withFileTypes: true })) {
  if (!pacote.isDirectory()) continue;
  const dist = path.join(pacotes, pacote.name, 'dist');
  if (existsSync(dist)) arquivos.push(...encontrarTestes(dist));
}

// Suíte vazia é o modo de falha que este script existe para impedir: quase
// sempre significa "esqueci de compilar", e sair 0 aqui devolveria verde a um
// portão que não testou nada.
if (arquivos.length === 0) {
  console.error(
    'Nenhum teste encontrado em packages/*/dist. Rode `npm run build:packages` antes.',
  );
  process.exit(1);
}

console.error(`Rodando ${arquivos.length} arquivos de teste.`);

const filho = spawn(
  process.execPath,
  ['--test', '--experimental-sqlite', ...arquivos],
  { stdio: 'inherit', cwd: raizDoRepo },
);

filho.on('error', (err) => {
  console.error(`Não foi possível iniciar o runner: ${err.message}`);
  process.exit(1);
});
filho.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

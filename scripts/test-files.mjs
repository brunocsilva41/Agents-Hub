/**
 * Descoberta dos arquivos de teste compilados, compartilhada entre
 * `run-tests.mjs` (a suíte) e `coverage.mjs` (a mesma suíte, medindo
 * cobertura). Um lugar só: se a regra de descoberta mudar, os dois veem igual.
 */
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const raizDoRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pacotes = path.join(raizDoRepo, 'packages');

/** Todos os `*.test.js` sob `dir`, em qualquer profundidade. */
function encontrarTestes(dir) {
  const achados = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const completo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) achados.push(...encontrarTestes(completo));
    else if (entrada.name.endsWith('.test.js')) achados.push(completo);
  }
  return achados;
}

/**
 * `dist-test` é o do painel web: o `dist/` dele é a build do Vite (apagada a
 * cada `vite build`), então a lógica pura e os testes compilam à parte
 * (`packages/web/tsconfig.test.json`).
 */
export function descobrirTestes() {
  const arquivos = [];
  for (const pacote of readdirSync(pacotes, { withFileTypes: true })) {
    if (!pacote.isDirectory()) continue;
    for (const saida of ['dist', 'dist-test']) {
      const dir = path.join(pacotes, pacote.name, saida);
      if (existsSync(dir)) arquivos.push(...encontrarTestes(dir));
    }
  }
  return arquivos;
}

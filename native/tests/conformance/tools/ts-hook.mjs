// Hook de resolução `.js` -> `.ts` para importar o TS congelado direto de `packages/*/src`.
// Uso: carregado por gen-classifier.mjs (registerHooks síncrono do Node >= 22.15/23.5).
// O `dist/` não é usado: pode estar defasado em relação ao `src/`.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    if (
      parent.startsWith('file:') &&
      parent.endsWith('.ts') &&
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      specifier.endsWith('.js')
    ) {
      const tsUrl = new URL(specifier.replace(/\.js$/, '.ts'), parent);
      if (existsSync(fileURLToPath(tsUrl))) {
        return nextResolve(pathToFileURL(fileURLToPath(tsUrl)).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

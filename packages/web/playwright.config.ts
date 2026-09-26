import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * Teste e2e do painel (`npm run test:e2e` na raiz).
 *
 * Fica FORA do `npm test` porque precisa de um navegador. Para não baixar
 * browsers, usa o Edge ou o Chrome já instalados (`channel`). Em máquina sem
 * nenhum dos dois, defina `PW_CHANNEL=` vazio e rode
 * `npx playwright install chromium` uma vez para usar o Chromium do Playwright.
 */
function canalDoNavegador(): string | undefined {
  const pedido = process.env['PW_CHANNEL'];
  if (pedido !== undefined) return pedido || undefined;
  const candidatos: Array<[string, string]> = [
    ['msedge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['msedge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['chrome', '/usr/bin/google-chrome'],
    ['msedge', '/usr/bin/microsoft-edge'],
    ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ];
  return candidatos.find(([, caminho]) => existsSync(caminho))?.[0];
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../node_modules/.cache/playwright-e2e',
  use: {
    channel: canalDoNavegador(),
    headless: true,
    locale: 'pt-BR',
    actionTimeout: 8_000,
  },
});

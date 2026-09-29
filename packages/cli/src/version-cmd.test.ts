import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { HubClient } from './client.js';
import { capturar, limpar, montarHub, portaLivre, type HubDeTeste } from './test-kit.js';
import { cliVersion, versionCommand } from './version-cmd.js';

const versaoDoPacote = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/** `hub --version` / `hub version` não existiam ("comando desconhecido" + help inteiro). */
describe('hub version', () => {
  let t: HubDeTeste;
  before(async () => {
    t = await montarHub('version');
  });
  after(async () => {
    await t.fechar();
    limpar(t.raiz);
  });

  test('cliVersion lê o package.json da CLI', () => {
    assert.equal(cliVersion(), versaoDoPacote);
  });

  test('--json: versão da CLI, do Node e do daemon no ar, só JSON no stdout', async () => {
    const { out, valor } = await capturar(() =>
      versionCommand({ command: 'version', positional: [], flags: { json: true } }, t.client),
    );
    const lido = JSON.parse(out.join('\n')) as Record<string, unknown>;
    assert.equal(lido['cli'], versaoDoPacote);
    assert.equal(lido['node'], process.versions.node);
    assert.equal(lido['daemon'], (await t.client.health()).version);
    assert.deepEqual(lido, valor);
  });

  test('sem daemon no ar diz isso — e não tenta subir', async () => {
    // porta reservada e fechada DE PROPÓSITO: o teste precisa de um endereço sem ninguém escutando
    const semNinguem = new HubClient(`http://127.0.0.1:${await portaLivre()}`);
    const { out, valor } = await capturar(() =>
      versionCommand({ command: '--version', positional: [], flags: {} }, semNinguem),
    );
    assert.equal(valor.daemon, null);
    assert.ok(out[0]?.includes(`hub ${versaoDoPacote}`));
    assert.ok(out.some((l) => l.includes('não está rodando')));
  });
});

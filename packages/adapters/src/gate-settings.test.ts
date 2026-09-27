import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { montarInvocacao } from './process-adapter.js';
import { loadManifestFile } from './registry.js';

/**
 * Gate por sessão do Claude Code / OpenClaude (teste real de 2026-09-26,
 * achado ALTO): a sessão subida pelo Hub só tinha gate se o usuário tivesse
 * instalado o hook no `~/.claude/settings.json`. Agora o manifesto declara
 * `gate.settingsArgs` e o argv leva `--settings <arquivo da sessão>`.
 */

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SETTINGS = 'C:\\hub\\run\\ses_abc-settings.json';

for (const id of ['claude', 'openclaude']) {
  const manifest = loadManifestFile(path.join(RAIZ, 'manifests', `${id}.yaml`));

  for (const [nome, template, nativo] of [
    ['oneShot', manifest.invoke.oneShot, null],
    ['resume', manifest.invoke.resume ?? [], 'nativo-1'],
  ] as const) {
    test(`${id}.${nome}: argv leva --settings com o arquivo da sessão`, () => {
      const { args } = montarInvocacao(
        manifest,
        { mode: 'semi', workdir: 'C:\\p', settingsFile: SETTINGS },
        template,
        'prompt',
        nativo,
      );
      const i = args.indexOf('--settings');
      assert.notEqual(i, -1, `${id}.${nome}: sem --settings no argv: ${args.join(' ')}`);
      assert.equal(args[i + 1], SETTINGS);
    });
  }

  test(`${id}: sem arquivo de settings, a flag não aparece sozinha`, () => {
    const { args } = montarInvocacao(manifest, { mode: 'semi', workdir: 'C:\\p' }, manifest.invoke.oneShot, 'p', null);
    assert.equal(args.includes('--settings'), false);
    assert.ok(args.every((a) => !a.includes('{{')), `placeholder vazou: ${args.join(' ')}`);
  });
}

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { backupVersionado, carimboDeBackup, gravarComBackup, lerJsonDeConfig } from './safe-write.js';

describe('safe-write — backup versionado, escrita atômica, leitura que recusa lixo', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hub-safe-write-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('carimbo YYYYMMDD-HHMMSS no horário local', () => {
    assert.equal(carimboDeBackup(new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405');
  });

  test('backups no mesmo segundo ganham sufixo e nenhum é sobrescrito', () => {
    const f = path.join(dir, 'settings.json');
    const t = new Date(2026, 8, 26, 9, 8, 7);
    writeFileSync(f, 'v1');
    const a = backupVersionado(f, t);
    writeFileSync(f, 'v2');
    const b = backupVersionado(f, t);
    writeFileSync(f, 'v3');
    const c = backupVersionado(f, t);
    assert.deepEqual(
      [a, b, c].map((p) => path.basename(p)),
      ['settings.json.bak-20260926-090807', 'settings.json.bak-20260926-090807-2', 'settings.json.bak-20260926-090807-3'],
    );
    assert.deepEqual([a, b, c].map((p) => readFileSync(p, 'utf8')), ['v1', 'v2', 'v3']);
  });

  test('gravarComBackup: sem temporário esquecido; arquivo novo não gera backup', () => {
    const f = path.join(dir, 'sub', 'novo.json');
    assert.equal(gravarComBackup(f, '{}\n'), null);
    assert.equal(readFileSync(f, 'utf8'), '{}\n');
    const b = gravarComBackup(f, '{"a":1}\n');
    assert.equal(readFileSync(b!, 'utf8'), '{}\n');
    assert.ok(!readdirSync(path.dirname(f)).some((n) => n.includes('.tmp-')));
  });

  test('lerJsonDeConfig: estrito ok, JSONC com aviso, lixo/raiz não-objeto recusados', () => {
    const f = path.join(dir, 'l.json');
    writeFileSync(f, '{"a":1}');
    assert.deepEqual(lerJsonDeConfig(f), { doc: { a: 1 }, avisos: [] });
    writeFileSync(f, '{ /* c */ "a": [1, 2,], // x\n }');
    const jsonc = lerJsonDeConfig(f);
    assert.deepEqual(jsonc.doc, { a: [1, 2] });
    assert.equal(jsonc.avisos.length, 1);
    writeFileSync(f, '{"a":1}\n}');
    assert.throws(() => lerJsonDeConfig(f), /não é JSON válido/);
    writeFileSync(f, '[1]');
    assert.throws(() => lerJsonDeConfig(f), /objeto JSON na raiz/);
    assert.deepEqual(lerJsonDeConfig(path.join(dir, 'nao-existe.json')), { doc: {}, avisos: [] });
  });
});

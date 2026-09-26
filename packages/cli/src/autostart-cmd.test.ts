import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  desabilitarAutostart,
  estadoDoAutostart,
  habilitarAutostart,
  NOME_DO_ITEM,
  pastaDeInicializacao,
  scriptDeAutostart,
  type AlvoDoAutostart,
} from './autostart-cmd.js';

/**
 * `hub autostart` — tudo contra uma pasta temporária no lugar da pasta
 * Inicializar real: estes testes NUNCA ligam o autostart desta máquina.
 */

const raizes: string[] = [];
after(() => {
  for (const r of raizes) rmSync(r, { recursive: true, force: true });
});

function pasta(): string {
  const r = mkdtempSync(path.join(os.tmpdir(), 'hub-autostart-'));
  raizes.push(r);
  return path.join(r, 'Startup');
}

const ALVO: AlvoDoAutostart = {
  node: 'C:\\Program Files\\nodejs\\node.exe',
  entrada: 'C:\\Users\\João Silva\\AppData\\Roaming\\npm\\node_modules\\agents-hub\\node_modules\\@agents-hub\\cli\\dist\\bin.js',
  nodeFlags: [],
  env: {},
};

describe('hub autostart', () => {
  test('pasta Inicializar: dentro de APPDATA no Windows, inexistente fora dele', () => {
    assert.equal(
      pastaDeInicializacao({ APPDATA: 'C:\\U\\AppData\\Roaming' }, 'win32'),
      path.join('C:\\U\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    );
    assert.equal(pastaDeInicializacao({}, 'linux'), undefined);
  });

  test('script roda `hub autostart run` oculto, com aspas VBScript dobradas', () => {
    const vbs = scriptDeAutostart(ALVO);
    assert.match(vbs, /sh\.Run "(""[^"]+"" )+autostart run", 0, False/);
    assert.ok(vbs.includes(`""${ALVO.entrada}""`));
  });

  test('flags do Node e AGENTS_HUB_HOME/PORT do momento do enable vão no script', () => {
    const vbs = scriptDeAutostart({
      ...ALVO,
      nodeFlags: ['--experimental-sqlite'],
      env: { AGENTS_HUB_HOME: 'D:\\hub', AGENTS_HUB_PORT: '4800' },
    });
    assert.ok(vbs.includes('""--experimental-sqlite""'));
    assert.ok(vbs.includes('sh.Environment("PROCESS")("AGENTS_HUB_HOME") = "D:\\hub"'));
    assert.ok(vbs.includes('sh.Environment("PROCESS")("AGENTS_HUB_PORT") = "4800"'));
  });

  test('enable grava UTF-16LE com BOM (caminho com acento sobrevive); status lê; disable remove', () => {
    const dir = pasta();
    assert.deepEqual(estadoDoAutostart(dir), { suportado: true, ativo: false, arquivo: path.join(dir, NOME_DO_ITEM) });

    const arquivo = habilitarAutostart(dir, ALVO);
    const bruto = readFileSync(arquivo);
    assert.deepEqual([...bruto.subarray(0, 2)], [0xff, 0xfe]);
    const estado = estadoDoAutostart(dir);
    assert.ok(estado.suportado && estado.ativo);
    assert.ok(estado.suportado && estado.conteudo?.includes('João Silva'));

    assert.deepEqual(desabilitarAutostart(dir), { arquivo, removido: true });
    assert.equal(existsSync(arquivo), false);
    assert.deepEqual(desabilitarAutostart(dir), { arquivo, removido: false });
  });

  test('fora do Windows o estado é "não suportado"', () => {
    assert.deepEqual(estadoDoAutostart(undefined), { suportado: false });
  });
});

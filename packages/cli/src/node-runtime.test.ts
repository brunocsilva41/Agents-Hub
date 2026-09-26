import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { argsDoAutostart } from './daemon-control.js';
import {
  avaliarNode,
  FLAG_SQLITE,
  flagsDoNodeParaDaemon,
  silenciarAvisoDoSqlite,
  textoDeErroFatal,
} from './node-runtime.js';

/**
 * Item 5.1: Node 22.5–22.12 só carrega `node:sqlite` com
 * `--experimental-sqlite`. Versões conferidas contra os binários reais
 * (`npx node@22.5.0`, `@22.12.0`, `@22.13.0`): as duas primeiras dão
 * ERR_UNKNOWN_BUILTIN_MODULE sem a flag, a terceira não.
 */
describe('avaliarNode', () => {
  test('22.5 e 22.12 exigem a flag; 22.13, 23.4 e 24 não', () => {
    assert.equal(avaliarNode('22.5.0', []).precisaFlagSqlite, true);
    assert.equal(avaliarNode('v22.12.0', []).precisaFlagSqlite, true);
    assert.equal(avaliarNode('23.3.0', []).precisaFlagSqlite, true);
    assert.equal(avaliarNode('22.13.0', []).precisaFlagSqlite, false);
    assert.equal(avaliarNode('23.4.0', []).precisaFlagSqlite, false);
    assert.equal(avaliarNode('24.14.0', []).precisaFlagSqlite, false);
  });

  test('com a flag já no execArgv não reexecuta (senão seria laço infinito)', () => {
    const r = avaliarNode('22.12.0', [FLAG_SQLITE]);
    assert.equal(r.sqliteExigeFlag, true);
    assert.equal(r.precisaFlagSqlite, false);
  });

  test('abaixo de 22.5 não é suportado (e não adianta flag)', () => {
    assert.equal(avaliarNode('22.4.1', []).suportado, false);
    assert.equal(avaliarNode('20.18.0', []).suportado, false);
    assert.equal(avaliarNode('20.18.0', []).precisaFlagSqlite, false);
    assert.equal(avaliarNode('22.5.0', []).suportado, true);
  });

  test('flags do daemon filho dependem da versão, não do execArgv do pai', () => {
    assert.deepEqual(flagsDoNodeParaDaemon('22.12.0'), [FLAG_SQLITE]);
    assert.deepEqual(flagsDoNodeParaDaemon('24.1.0'), []);
  });
});

describe('autostart do daemon', () => {
  // Regressão do R01-05: o spawn era `[entrada, 'daemon']`, sem a flag, e o
  // daemon autostartado morria em Node 22.5–22.12.
  test('passa --experimental-sqlite ANTES da entrada em Node 22.12', () => {
    assert.deepEqual(argsDoAutostart('C:/x/bin.js', '22.12.0'), [FLAG_SQLITE, 'C:/x/bin.js', 'daemon']);
  });

  test('não passa flag nenhuma em Node 24', () => {
    assert.deepEqual(argsDoAutostart('C:/x/bin.js', '24.14.0'), ['C:/x/bin.js', 'daemon']);
  });
});

describe('silenciarAvisoDoSqlite', () => {
  function falso(): { emitWarning: typeof process.emitWarning; vistos: unknown[][] } {
    const vistos: unknown[][] = [];
    const proc = {
      vistos,
      emitWarning: ((...args: unknown[]) => {
        vistos.push(args);
      }) as typeof process.emitWarning,
    };
    return proc;
  }

  test('engole o ExperimentalWarning do SQLite (as duas formas de chamada)', () => {
    const proc = falso();
    silenciarAvisoDoSqlite(proc);
    proc.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    proc.emitWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' });
    assert.equal(proc.vistos.length, 0);
  });

  test('deixa passar outros avisos, inclusive outros experimentais', () => {
    const proc = falso();
    silenciarAvisoDoSqlite(proc);
    proc.emitWarning('VM Modules is an experimental feature', 'ExperimentalWarning');
    proc.emitWarning('Buffer() is deprecated', 'DeprecationWarning', 'DEP0005');
    proc.emitWarning(new Error('possível vazamento'));
    assert.equal(proc.vistos.length, 3);
  });
});

describe('textoDeErroFatal', () => {
  test('erro com código: só mensagem e código, sem stack', () => {
    const err = Object.assign(new Error('C:/h/config.json:3:3: não é JSON válido'), { code: 'HUB_CONFIG_INVALID' });
    const texto = textoDeErroFatal(err);
    assert.equal(texto, '[HUB_CONFIG_INVALID] C:/h/config.json:3:3: não é JSON válido');
    assert.doesNotMatch(texto, /\n\s+at /);
  });

  test('erro sem código (bug): mantém o stack, que é o que ajuda a consertar', () => {
    assert.match(textoDeErroFatal(new TypeError('x is undefined')), /\n\s+at /);
  });
});

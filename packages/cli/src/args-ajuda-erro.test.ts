import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { ajudaDoComando } from './ajuda.js';
import { parseArgs } from './args.js';
import { HubApiError } from './client.js';
import { comErro, required } from './cmd-util.js';
import { definirComandoAtual, ErroDeUso, linhasDeErro, mostrarErro } from './erro-cli.js';

/**
 * Vistoria 07: `--` (R07-20), ajuda por comando (R07-20) e saída de erro
 * única (R07-21).
 */

describe('parseArgs — `--` encerra as flags (R07-20)', () => {
  test('objetivo depois de `--` é posicional mesmo começando com `--`', () => {
    const a = parseArgs(['start', '--agent', 'claude', '--', '--corrija', 'o', 'build']);
    assert.equal(a.flags['agent'], 'claude');
    assert.deepEqual(a.positional, ['--corrija', 'o', 'build']);
    assert.equal(a.flags['corrija'], undefined, 'não pode virar flag');
    assert.equal(a.flags[''], undefined, '`--` não é uma flag de nome vazio');
  });

  test('`--agent x -- "objetivo"` (antes: "faltou o objetivo")', () => {
    const a = parseArgs(['start', '--agent', 'fake', '--', 'objetivo descritivo']);
    assert.deepEqual(a.positional, ['objetivo descritivo']);
  });

  test('sem `--`, o comportamento de antes', () => {
    const a = parseArgs(['start', '--detach', 'objetivo', '--mode=semi']);
    assert.equal(a.flags['detach'], true);
    assert.equal(a.flags['mode'], 'semi');
    assert.deepEqual(a.positional, ['objetivo']);
  });
});

describe('ajuda por comando (R07-20)', () => {
  test('`start` traz a linha de uso e as flags, não o help inteiro', () => {
    const linhas = ajudaDoComando('start').join('\n');
    assert.match(linhas, /hub start --agent <id> "objetivo"/);
    assert.match(linhas, /--mode <supervised\|semi\|autonomous>/);
    assert.match(linhas, /--detach/);
    assert.doesNotMatch(linhas, /hub sessions/);
  });

  test('`hook` não confunde com `hooks`; `version` acha `hub version | hub --version`', () => {
    assert.ok(ajudaDoComando('hook').every((l) => !/hub hooks/.test(l)));
    assert.match(ajudaDoComando('version').join('\n'), /hub version/);
  });

  test('comando desconhecido: vazio (quem chama mostra o help inteiro)', () => {
    assert.deepEqual(ajudaDoComando('naoexiste'), []);
  });
});

describe('saída de erro única (R07-21)', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  test('HubApiError: prefixo, [CODIGO] e issues; saída 1', () => {
    const err = new HubApiError('Brief inválido', 'INVALID_BRIEF', 400, {
      issues: [{ path: 'objective', message: 'curto demais' }],
    });
    assert.deepEqual(linhasDeErro(err), [
      'hub: [INVALID_BRIEF] Brief inválido',
      '  - objective: curto demais',
    ]);
    const saida: string[] = [];
    mostrarErro(err, (l) => saida.push(l));
    assert.equal(process.exitCode, 1);
    assert.equal(saida.length, 2);
  });

  test('erro de uso: sem código, com a linha de uso do comando e a dica de --help', () => {
    definirComandoAtual('watch');
    let pego: unknown;
    try {
      required(undefined, 'sessionId');
    } catch (err) {
      pego = err;
    }
    assert.ok(pego instanceof ErroDeUso);
    const linhas = linhasDeErro(pego);
    assert.equal(linhas[0], 'hub: argumento obrigatório ausente: sessionId');
    assert.ok(linhas.includes('uso:'));
    assert.ok(
      linhas.some((l) => /hub watch <sessionId>/.test(l)),
      linhas.join('\n'),
    );
    assert.equal(linhas.at(-1), 'veja: hub watch --help');
  });

  test('comErro (comandos sem daemon) usa o mesmo formato', async () => {
    const saida: string[] = [];
    const original = console.error;
    console.error = (l: string) => void saida.push(l);
    try {
      await comErro(async () => {
        throw Object.assign(new Error('arquivo sumiu'), { code: 'ENOENT' });
      });
    } finally {
      console.error = original;
    }
    assert.equal(process.exitCode, 1);
    // eslint-disable-next-line no-control-regex -- o ESC da cor é justamente o que se mede
    assert.match(saida[0] ?? '', /^(\u001b\[31m)?hub: \[ENOENT\] arquivo sumiu/);
  });
});

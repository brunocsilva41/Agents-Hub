import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { esperar } from './hub-de-teste.js';
import { arquivosDeLog, logsCommand } from './logs-cmd.js';
import { capturar, limpar } from './test-kit.js';

const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-cli-logs-'));
after(() => limpar(raiz));

function pasta(nome: string): string {
  const dir = path.join(raiz, nome);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('hub logs', () => {
  test('mostra as últimas N linhas do log mais recente', async () => {
    const dir = pasta('tail');
    writeFileSync(path.join(dir, 'daemon-2026-09-24.log'), 'antigo\n');
    const linhas = Array.from({ length: 80 }, (_, i) => `linha ${i + 1}`);
    writeFileSync(path.join(dir, 'daemon-2026-09-25.log'), linhas.join('\n') + '\n');
    writeFileSync(path.join(dir, 'outra-coisa.txt'), 'não é log do daemon');

    assert.deepEqual(
      arquivosDeLog(dir).map((f) => path.basename(f)),
      ['daemon-2026-09-24.log', 'daemon-2026-09-25.log'],
    );

    const { out } = await capturar(() =>
      logsCommand(dir, { command: 'logs', positional: [], flags: { lines: '5' } }),
    );
    assert.ok(out[0]?.includes('daemon-2026-09-25.log'));
    assert.deepEqual(out[1]?.split('\n'), ['linha 76', 'linha 77', 'linha 78', 'linha 79', 'linha 80']);

    const padrao = await capturar(() =>
      logsCommand(dir, { command: 'logs', positional: [], flags: {} }),
    );
    assert.equal(padrao.out[1]?.split('\n').length, 50, '50 linhas por padrão');
  });

  test('--lines inválido é erro; pasta vazia explica de onde vem o log', async () => {
    const dir = pasta('vazia');
    await assert.rejects(
      () => logsCommand(dir, { command: 'logs', positional: [], flags: { lines: 'abc' } }),
      /--lines inválido/,
    );
    const { out } = await capturar(() =>
      logsCommand(dir, { command: 'logs', positional: [], flags: {} }),
    );
    assert.ok(out.some((l) => l.includes('nenhum log')));
  });

  test('--follow acompanha o que o daemon acrescenta e troca de arquivo na virada do dia', async () => {
    const dir = pasta('follow');
    const hoje = path.join(dir, 'daemon-2026-09-25.log');
    writeFileSync(hoje, 'já estava\n');
    const escrito: string[] = [];
    const ctl = new AbortController();

    const seguindo = capturar(() =>
      logsCommand(
        dir,
        { command: 'logs', positional: [], flags: { follow: true } },
        {
          signal: ctl.signal,
          pollMs: 20,
          write: (t) => escrito.push(t),
        },
      ),
    );
    // `logsCommand` guarda a posição (fim do arquivo) antes do primeiro
    // `await`: o acréscimo já pode acontecer, sem respiro nenhum.
    try {
      appendFileSync(hoje, 'nova linha\n');
      await esperar(() => escrito.join('') === 'nova linha\n', 'o follow mostrar a linha nova');
      writeFileSync(path.join(dir, 'daemon-2026-09-26.log'), 'dia seguinte\n');
      await esperar(
        () => escrito.join('').includes('dia seguinte'),
        'o follow trocar para o arquivo novo',
      );
    } finally {
      // Espera que falha não pode deixar o follow vivo segurando o processo.
      ctl.abort();
    }
    const { out } = await seguindo;

    assert.ok(
      out.some((l) => l.includes('já estava')),
      'mostra o fim antes de seguir',
    );
    assert.equal(escrito.join(''), 'nova linha\ndia seguinte\n');
    assert.ok(
      out.some((l) => l.includes('daemon-2026-09-26.log')),
      'anuncia o arquivo novo',
    );
  });
});

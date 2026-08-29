import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { captureBaseline, captureDiff } from './diff-capture.js';

const exec = promisify(execFile);

/**
 * Atribuição do diff em árvore suja.
 *
 * Bug medido numa sessão real: com `isolation: none`, o Hub anunciou
 * "2 arquivo(s), +510 −0" para um agente que rodou em somente-leitura e não
 * tocou em nada. As duas mudanças eram do dia anterior, de outra pessoa.
 *
 * Não é só a timeline mentindo: esse diff alimenta o portão de revisão cruzada,
 * então o revisor avaliaria trabalho alheio como se fosse do agente, e o
 * veredito valeria para a tarefa errada.
 */
describe('linha de base do diff', () => {
  let repo: string;

  before(async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'hub-diff-'));
    await exec('git', ['init', '-q'], { cwd: repo });
    await exec('git', ['config', 'user.email', 'teste@local'], { cwd: repo });
    await exec('git', ['config', 'user.name', 'Teste'], { cwd: repo });
    writeFileSync(path.join(repo, 'base.txt'), 'linha original\n', 'utf8');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', ['commit', '-qm', 'inicial'], { cwd: repo });
  });

  after(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  test('mudança que já existia NÃO é creditada ao agente', async () => {
    // Alguém mexeu antes da sessão começar.
    writeFileSync(path.join(repo, 'base.txt'), 'alterado por outra pessoa\n', 'utf8');
    writeFileSync(path.join(repo, 'nota-alheia.md'), 'documento de ontem\n', 'utf8');

    const baseline = await captureBaseline(repo);

    // O agente roda e não faz nada.
    const capture = await captureDiff(repo, baseline);

    assert.ok(capture);
    assert.equal(capture.empty, true, 'nada foi feito pelo agente, o diff precisa sair vazio');
    assert.equal(capture.filesChanged, 0);
    assert.deepEqual(capture.untracked, []);
  });

  test('sem linha de base, o comportamento antigo credita tudo', async () => {
    // Documenta a diferença: é isto que acontecia antes, e o que ainda acontece
    // em sessões criadas antes desta correção.
    const capture = await captureDiff(repo);
    assert.ok(capture);
    assert.equal(capture.empty, false);
    assert.ok(capture.filesChanged > 0);
  });

  test('o que o agente muda DE VERDADE aparece', async () => {
    const baseline = await captureBaseline(repo);

    // Agora sim o agente trabalha: cria um arquivo e mexe num já sujo.
    writeFileSync(path.join(repo, 'do-agente.txt'), 'criado pelo agente\n', 'utf8');
    writeFileSync(path.join(repo, 'base.txt'), 'alterado pelo AGENTE\n', 'utf8');

    const capture = await captureDiff(repo, baseline);

    assert.ok(capture);
    assert.equal(capture.empty, false);
    // O arquivo já estava sujo antes, mas mudou de novo — é do agente. Só o
    // hash do conteúdo distingue esses dois casos.
    assert.match(capture.patch, /alterado pelo AGENTE/);
    assert.deepEqual(capture.untracked, ['do-agente.txt']);
    // E o documento alheio continua fora.
    assert.ok(!capture.patch.includes('documento de ontem'));
  });
});

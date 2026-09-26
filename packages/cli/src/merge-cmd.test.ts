import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Session } from '@agents-hub/core';
import { mergeCommand } from './merge-cmd.js';
import { capturar, limpar, montarHub, repoGit, semearDiff, semearSessao, type HubDeTeste } from './test-kit.js';

/**
 * Não havia `hub merge/apply`: `hub diff` mostrava o trabalho, mas levá-lo ao
 * branch do projeto era git à mão (vistoria 14). Repositórios git reais e
 * temporários; nada de remoto, nada de push.
 */
describe('hub merge / hub apply', () => {
  let t: HubDeTeste;
  let repo: string;
  let git: (...argv: string[]) => string;
  let projectId: string;

  /** Sessão com branch `hub/<id>` contendo `arquivos` (um commit por item). */
  function sessaoComBranch(arquivos: Array<[string, string]>, over: Partial<Session> = {}): Session {
    const s = semearSessao(t.hub, projectId, over);
    git('checkout', '-q', '-b', `hub/${s.id}`);
    for (const [nome, conteudo] of arquivos) {
      writeFileSync(path.join(repo, nome), conteudo);
      git('add', nome);
      git('commit', '-q', '-m', `agente: ${nome}`);
    }
    git('checkout', '-q', 'main');
    return s;
  }

  const cabeca = (): string => git('rev-parse', 'HEAD').trim();
  const rodar = (command: 'merge' | 'apply', id: string, flags: Record<string, string | boolean> = {}) =>
    capturar(() => mergeCommand(t.client, { command, positional: [id], flags }));

  before(async () => {
    t = await montarHub('merge');
    repo = path.join(t.raiz, 'repo com espaço');
    git = repoGit(repo);
    writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    git('add', '.');
    git('commit', '-q', '-m', 'inicial');
    projectId = t.hub.sessions.registerProject(repo, 'repo').id;
  });

  afterEach(() => {
    // Plano bloqueado marca exitCode 1 — correto na CLI, mas não pode vazar para o runner.
    process.exitCode = undefined;
    git('reset', '-q', '--hard');
    git('clean', '-fdq');
  });

  after(async () => {
    await t.fechar();
    limpar(t.raiz);
  });

  test('sem --write é prévia: lista os commits e não muda nada', async () => {
    const s = sessaoComBranch([['b.txt', 'do agente\n']]);
    const antes = cabeca();
    const { out, valor } = await rodar('merge', s.id);
    assert.equal(valor.commits.length, 1);
    assert.match(valor.commits[0]!, /agente: b\.txt/);
    assert.deepEqual(valor.blockers, []);
    assert.ok(out.some((l) => l.includes('prévia')));
    assert.equal(cabeca(), antes);
    assert.equal(existsSync(path.join(repo, 'b.txt')), false);

    // --dry-run vence --write.
    await rodar('merge', s.id, { write: true, 'dry-run': true });
    assert.equal(cabeca(), antes);
  });

  test('--write faz merge --no-ff no branch atual, sem push', async () => {
    const s = sessaoComBranch([['c.txt', 'c\n']]);
    const antes = cabeca();
    const { out } = await rodar('merge', s.id, { write: true });
    assert.equal(readFileSync(path.join(repo, 'c.txt'), 'utf8'), 'c\n');
    const pais = git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
    assert.equal(pais.length, 3, 'commit de merge com dois pais');
    assert.equal(pais[1], antes);
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    assert.ok(out.some((l) => l.includes('nada foi enviado ao remoto')));
  });

  test('árvore suja bloqueia — nada é forçado', async () => {
    const s = sessaoComBranch([['d.txt', 'd\n']]);
    writeFileSync(path.join(repo, 'a.txt'), 'mexido pelo usuário\n');
    const antes = cabeca();
    const { valor } = await rodar('merge', s.id, { write: true });
    assert.ok(valor.blockers.some((b) => b.includes('modificado')));
    assert.equal(process.exitCode, 1);
    assert.equal(cabeca(), antes);
    assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'mexido pelo usuário\n');
    assert.equal(existsSync(path.join(repo, 'd.txt')), false);
  });

  test('conflito: desfaz o merge e lista o arquivo; o repositório volta limpo', async () => {
    const s = sessaoComBranch([['a.txt', 'versão do agente\n']]);
    writeFileSync(path.join(repo, 'a.txt'), 'versão do usuário\n');
    git('commit', '-q', '-am', 'usuário mexeu em a.txt');
    const antes = cabeca();
    await assert.rejects(() => rodar('merge', s.id, { write: true }), /conflito \(desfeito\): a\.txt/);
    assert.equal(cabeca(), antes);
    assert.equal(git('status', '--porcelain').trim(), '');
    assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'versão do usuário\n');
  });

  test('--strategy cherry-pick traz os commits um a um (histórico linear)', async () => {
    const s = sessaoComBranch([
      ['e1.txt', '1\n'],
      ['e2.txt', '2\n'],
    ]);
    const antes = cabeca();
    await rodar('merge', s.id, { write: true, strategy: 'cherry-pick' });
    assert.equal(git('rev-list', '--count', `${antes}..HEAD`).trim(), '2');
    assert.equal(git('rev-list', '--merges', '--count', `${antes}..HEAD`).trim(), '0');
    assert.ok(existsSync(path.join(repo, 'e2.txt')));
  });

  test('apply = squash no índice + alterações não commitadas do agente (diff capturado), sem commit', async () => {
    const s = sessaoComBranch([['f.txt', 'commitado pelo agente\n']]);
    semearDiff(
      t.hub,
      s,
      ['diff --git a/g.txt b/g.txt', 'new file mode 100644', '--- /dev/null', '+++ b/g.txt', '@@ -0,0 +1 @@', '+deixado sem commit', ''].join('\n'),
    );
    const antes = cabeca();
    const { valor } = await rodar('apply', s.id, { write: true });
    assert.equal(valor.strategy, 'squash');
    assert.equal(cabeca(), antes, 'nenhum commit criado');
    assert.match(git('diff', '--cached', '--name-only'), /f\.txt/);
    assert.equal(readFileSync(path.join(repo, 'g.txt'), 'utf8'), 'deixado sem commit\n');
  });

  test('sessão só com alterações não commitadas (o caso comum: o Hub não commita pelo agente)', async () => {
    writeFileSync(path.join(repo, 'h.txt'), 'h\n');
    git('add', 'h.txt');
    git('commit', '-q', '-m', 'h.txt');
    const s = semearSessao(t.hub, projectId);
    semearDiff(
      t.hub,
      s,
      ['diff --git a/h.txt b/h.txt', '--- a/h.txt', '+++ b/h.txt', '@@ -1 +1 @@', '-h', '+h editada pelo agente', ''].join('\n'),
    );
    const { valor } = await rodar('merge', s.id);
    assert.ok(valor.warnings.some((w) => w.includes('não existe')));
    assert.deepEqual(valor.blockers, []);
    const antes = cabeca();
    await rodar('merge', s.id, { write: true });
    assert.equal(readFileSync(path.join(repo, 'h.txt'), 'utf8'), 'h editada pelo agente\n');
    assert.equal(cabeca(), antes, 'alteração aplicada sem commit');
  });

  test('bloqueios: sessão sem isolamento, estratégia inválida, nada a aplicar', async () => {
    const semIsolamento = semearSessao(t.hub, projectId, { isolation: 'none' });
    const r1 = await rodar('merge', semIsolamento.id, { write: true });
    assert.ok(r1.valor.blockers.some((b) => b.includes('sem isolamento')));

    const vazia = semearSessao(t.hub, projectId);
    const r2 = await rodar('merge', vazia.id);
    assert.ok(r2.valor.blockers.some((b) => b.includes('nada a aplicar')));

    await assert.rejects(() => rodar('merge', vazia.id, { strategy: 'rebase' }), /--strategy inválida/);
  });
});

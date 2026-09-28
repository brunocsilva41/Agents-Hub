import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { setImmediate as proximaVolta } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Session } from '@agents-hub/core';
import { mergeCommand } from './merge-cmd.js';
import {
  capturar,
  limpar,
  montarHub,
  repoGit,
  semearDiff,
  semearSessao,
  type HubDeTeste,
} from './test-kit.js';

const execFileAsync = promisify(execFile);

/**
 * Git ASSÍNCRONO para tudo o que o teste faz depois de o daemon atender a
 * primeira requisição.
 *
 * Causa do flake de ECONNRESET sob carga: daemon e cliente moram NESTE
 * processo, e uma sequência de `execFileSync('git')` (criar branch, commitar,
 * `reset`/`clean` no `afterEach`) travava o event loop por mais que o
 * keep-alive do servidor (5 s + 1 s de folga no Node 24) quando a máquina
 * estava ocupada. Travado, nenhum timer roda: nem o ocioso do undici (que
 * abandonaria o socket do lado do cliente em ~3 s) nem o do servidor. Quando
 * o loop volta, o fetch seguinte escreve no socket ocioso ANTES da fase de
 * timers; logo depois o timer vencido do servidor destrói o socket com a
 * requisição ainda não lida, e o SO responde RST. Com o git assíncrono o loop
 * gira, os timers rodam na ordem certa e o cliente larga o socket antes.
 */
function gitAssincrono(dir: string): (...argv: string[]) => Promise<string> {
  return async (...argv) => {
    const { stdout } = await execFileAsync('git', argv, {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout;
  };
}

/**
 * Não havia `hub merge/apply`: `hub diff` mostrava o trabalho, mas levá-lo ao
 * branch do projeto era git à mão (vistoria 14). Repositórios git reais e
 * temporários; nada de remoto, nada de push.
 */
describe('hub merge / hub apply', () => {
  let t: HubDeTeste;
  let repo: string;
  let git: (...argv: string[]) => Promise<string>;
  let projectId: string;

  /** Sessão com branch `hub/<id>` contendo `arquivos` (um commit por item). */
  async function sessaoComBranch(
    arquivos: Array<[string, string]>,
    over: Partial<Session> = {},
  ): Promise<Session> {
    const s = semearSessao(t.hub, projectId, over);
    await git('checkout', '-q', '-b', `hub/${s.id}`);
    for (const [nome, conteudo] of arquivos) {
      writeFileSync(path.join(repo, nome), conteudo);
      await git('add', nome);
      await git('commit', '-q', '-m', `agente: ${nome}`);
    }
    await git('checkout', '-q', 'main');
    return s;
  }

  const cabeca = async (): Promise<string> => (await git('rev-parse', 'HEAD')).trim();
  const rodar = (command: 'merge' | 'apply', id: string, flags: Record<string, string | boolean> = {}) =>
    capturar(() => mergeCommand(t.client, { command, positional: [id], flags }));

  before(async () => {
    t = await montarHub('merge');
    repo = path.join(t.raiz, 'repo com espaço');
    // O `repoGit` síncrono só aqui: nenhuma requisição HTTP foi feita ainda,
    // então não existe socket ocioso para vencer durante o bloqueio.
    const gitInicial = repoGit(repo);
    writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    gitInicial('add', '.');
    gitInicial('commit', '-q', '-m', 'inicial');
    git = gitAssincrono(repo);
    projectId = t.hub.sessions.registerProject(repo, 'repo').id;
  });

  afterEach(async () => {
    // Plano bloqueado marca exitCode 1 — correto na CLI, mas não pode vazar para o runner.
    process.exitCode = undefined;
    await git('reset', '-q', '--hard');
    await git('clean', '-fdq');
  });

  after(async () => {
    await t.fechar();
    limpar(t.raiz);
  });

  test('sem --write é prévia: lista os commits e não muda nada', async () => {
    const s = await sessaoComBranch([['b.txt', 'do agente\n']]);
    const antes = await cabeca();
    const { out, valor } = await rodar('merge', s.id);
    assert.equal(valor.commits.length, 1);
    assert.match(valor.commits[0]!, /agente: b\.txt/);
    assert.deepEqual(valor.blockers, []);
    assert.ok(out.some((l) => l.includes('prévia')));
    assert.equal(await cabeca(), antes);
    assert.equal(existsSync(path.join(repo, 'b.txt')), false);

    // --dry-run vence --write.
    await rodar('merge', s.id, { write: true, 'dry-run': true });
    assert.equal(await cabeca(), antes);
  });

  test('--write faz merge --no-ff no branch atual, sem push', async () => {
    const s = await sessaoComBranch([['c.txt', 'c\n']]);
    const antes = await cabeca();
    const { out } = await rodar('merge', s.id, { write: true });
    assert.equal(readFileSync(path.join(repo, 'c.txt'), 'utf8'), 'c\n');
    const pais = (await git('rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ');
    assert.equal(pais.length, 3, 'commit de merge com dois pais');
    assert.equal(pais[1], antes);
    assert.equal((await git('rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'main');
    assert.ok(out.some((l) => l.includes('nada foi enviado ao remoto')));
  });

  test('árvore suja bloqueia — nada é forçado', async () => {
    const s = await sessaoComBranch([['d.txt', 'd\n']]);
    writeFileSync(path.join(repo, 'a.txt'), 'mexido pelo usuário\n');
    const antes = await cabeca();
    const { valor } = await rodar('merge', s.id, { write: true });
    assert.ok(valor.blockers.some((b) => b.includes('modificado')));
    assert.equal(process.exitCode, 1);
    assert.equal(await cabeca(), antes);
    assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'mexido pelo usuário\n');
    assert.equal(existsSync(path.join(repo, 'd.txt')), false);
  });

  test('conflito: desfaz o merge e lista o arquivo; o repositório volta limpo', async () => {
    const s = await sessaoComBranch([['a.txt', 'versão do agente\n']]);
    writeFileSync(path.join(repo, 'a.txt'), 'versão do usuário\n');
    await git('commit', '-q', '-am', 'usuário mexeu em a.txt');
    const antes = await cabeca();
    await assert.rejects(() => rodar('merge', s.id, { write: true }), /conflito \(desfeito\): a\.txt/);
    assert.equal(await cabeca(), antes);
    assert.equal((await git('status', '--porcelain')).trim(), '');
    assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'versão do usuário\n');
  });

  test('--strategy cherry-pick traz os commits um a um (histórico linear)', async () => {
    const s = await sessaoComBranch([
      ['e1.txt', '1\n'],
      ['e2.txt', '2\n'],
    ]);
    const antes = await cabeca();
    await rodar('merge', s.id, { write: true, strategy: 'cherry-pick' });
    assert.equal((await git('rev-list', '--count', `${antes}..HEAD`)).trim(), '2');
    assert.equal((await git('rev-list', '--merges', '--count', `${antes}..HEAD`)).trim(), '0');
    assert.ok(existsSync(path.join(repo, 'e2.txt')));
  });

  test('apply = squash no índice + alterações não commitadas do agente (diff capturado), sem commit', async () => {
    const s = await sessaoComBranch([['f.txt', 'commitado pelo agente\n']]);
    semearDiff(
      t.hub,
      s,
      [
        'diff --git a/g.txt b/g.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/g.txt',
        '@@ -0,0 +1 @@',
        '+deixado sem commit',
        '',
      ].join('\n'),
    );
    const antes = await cabeca();
    const { valor } = await rodar('apply', s.id, { write: true });
    assert.equal(valor.strategy, 'squash');
    assert.equal(await cabeca(), antes, 'nenhum commit criado');
    assert.match(await git('diff', '--cached', '--name-only'), /f\.txt/);
    assert.equal(readFileSync(path.join(repo, 'g.txt'), 'utf8'), 'deixado sem commit\n');
  });

  test('sessão só com alterações não commitadas (o caso comum: o Hub não commita pelo agente)', async () => {
    writeFileSync(path.join(repo, 'h.txt'), 'h\n');
    await git('add', 'h.txt');
    await git('commit', '-q', '-m', 'h.txt');
    const s = semearSessao(t.hub, projectId);
    semearDiff(
      t.hub,
      s,
      [
        'diff --git a/h.txt b/h.txt',
        '--- a/h.txt',
        '+++ b/h.txt',
        '@@ -1 +1 @@',
        '-h',
        '+h editada pelo agente',
        '',
      ].join('\n'),
    );
    const { valor } = await rodar('merge', s.id);
    assert.ok(valor.warnings.some((w) => w.includes('não existe')));
    assert.deepEqual(valor.blockers, []);
    const antes = await cabeca();
    await rodar('merge', s.id, { write: true });
    assert.equal(readFileSync(path.join(repo, 'h.txt'), 'utf8'), 'h editada pelo agente\n');
    assert.equal(await cabeca(), antes, 'alteração aplicada sem commit');
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

/**
 * Regressão do flake: reproduz, de forma determinística e em ~5 s, a janela
 * que a carga da máquina abria por acaso. Servidor HTTP no MESMO processo, uma
 * requisição deixa o socket ocioso no pool do fetch e, em seguida, o teste
 * roda git por mais tempo que o keep-alive do servidor. Com `execFileSync`
 * no lugar de `gitAssincrono` este teste cai com `fetch failed` / ECONNRESET
 * (o socket vencido é reutilizado); com o git assíncrono o cliente abandona o
 * socket a tempo e a segunda requisição abre uma conexão nova.
 */
describe('git do teste x keep-alive do daemon no mesmo processo', () => {
  test('git por mais tempo que o keep-alive não quebra a requisição seguinte', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hub-cli-keepalive-'));
    const servidor = createServer((_req, res) => res.end('{}'));
    // 3 s anunciados (o undici larga o socket em 3 − 2 = 1 s); o servidor
    // derruba em 3 s + a folga de `keepAliveTimeoutBuffer` (1 s no Node 24).
    servidor.keepAliveTimeout = 3000;
    await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
    try {
      const endereco = servidor.address();
      const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
      const url = `http://127.0.0.1:${porta}/`;
      repoGit(dir);
      const git = gitAssincrono(dir);

      await (await fetch(url)).text();
      // Uma volta do loop devolve o socket ao pool do fetch — é o estado em
      // que o próximo `sessaoComBranch` encontrava a conexão com o daemon.
      await proximaVolta();
      const inicio = Date.now();
      while (Date.now() - inicio < 4500) await git('status', '--porcelain');

      assert.equal(await (await fetch(url)).text(), '{}');
    } finally {
      await new Promise<void>((resolve) => servidor.close(() => resolve()));
      limpar(dir);
    }
  });
});

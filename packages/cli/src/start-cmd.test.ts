import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { capturar, comTeto, montarHubDeTeste, type HubDeTeste } from './hub-de-teste.js';
import { startCommand } from './start-cmd.js';

/**
 * Item 5.3 do GOAL (vistoria 2026-09-25, 07, 13 e 14): `hub start` contra um
 * daemon REAL isolado, com agentes falsos (custo zero).
 */

const args = (positional: string[], flags: Record<string, string | boolean>) => ({ command: 'start', positional, flags });

describe('hub start (CLI)', () => {
  let h: HubDeTeste;

  before(async () => {
    h = await montarHubDeTeste(
      [
        { id: 'ok', modo: 'ok' },
        { id: 'sozinho', modo: 'falha' },
        { id: 'flaky', modo: 'falha', capacidade: 'tarefa-falsa' },
        { id: 'backup', modo: 'ok', capacidade: 'tarefa-falsa' },
      ],
      { fallback: { 'tarefa-falsa': ['flaky', 'backup'] } },
    );
    h.hub.sessions.registerProject(h.projeto, 'projeto-start');
  });

  after(async () => {
    await h.encerrar();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  const quantasSessoes = (): number => h.hub.store.sessions.list().length;

  test('flags inválidas são recusadas ANTES de abrir sessão, com os valores válidos', async () => {
    const antes = quantasSessoes();
    const casos: Array<[Record<string, string | boolean>, RegExp]> = [
      [{ agent: 'ok', mode: 'autonomus', project: h.projeto }, /--mode inválido: "autonomus" \(válidos: supervised, semi, autonomous\)/],
      [{ agent: 'ok', isolation: 'bogus', project: h.projeto }, /--isolation inválido: "bogus" \(válidos: worktree, none\)/],
      [{ agent: 'ok', isolation: 'container', project: h.projeto }, /container ainda não está implementado/],
      [{ agent: true, project: h.projeto }, /--agent precisa de um valor/],
      [{ agent: 'ok', project: true }, /--project precisa de um valor/],
    ];
    for (const [flags, esperado] of casos) {
      const c = capturar();
      await startCommand(h.client, args(['objetivo descritivo o bastante'], flags), { log: c.log, logErro: c.logErro });
      assert.match(c.erros.join('\n'), esperado);
      assert.equal(process.exitCode, 1);
      process.exitCode = undefined;
    }
    assert.equal(quantasSessoes(), antes, 'nenhuma sessão pode ter sido aberta');
  });

  test('agente inexistente é o erro mostrado mesmo com objetivo curto, listando os válidos', async () => {
    const c = capturar();
    await startCommand(h.client, args(['teste'], { agent: 'nope', project: h.projeto }), { log: c.log, logErro: c.logErro });
    const erro = c.erros.join('\n');
    assert.match(erro, /agente "nope" não registrado/);
    assert.match(erro, /ok/);
    assert.match(erro, /hub doctor/);
    assert.doesNotMatch(erro, /objetivo/);
  });

  test('objetivo curto com agente válido: mensagem diz o mínimo e dá exemplo', async () => {
    const c = capturar();
    await startCommand(h.client, args(['teste'], { agent: 'ok', project: h.projeto }), { log: c.log, logErro: c.logErro });
    assert.match(c.erros.join('\n'), /objetivo curto demais \("teste"\).*pelo menos 8/);
    assert.equal(process.exitCode, 1);
  });

  test('subpasta de projeto registrado usa o projeto (antes: PROJECT_FOLDER_CONFLICT)', async () => {
    const sub = path.join(h.projeto, 'src', 'modulo');
    mkdirSync(sub, { recursive: true });
    const c = capturar();
    const d = await comTeto(
      startCommand(h.client, args(['responda com a palavra OK'], { agent: 'ok', project: sub, isolation: 'none' }), {
        log: c.log,
        logErro: c.logErro,
        pollMs: 50,
      }),
      15_000,
      'hub start',
    );
    assert.equal(d?.estado, 'completed', c.texto());
    assert.equal(h.hub.sessions.listProjects().length, 1, 'não pode registrar a subpasta como projeto');
  });

  test('sessão que FALHA sai com código 1 e diz o desfecho (antes: exit 0)', async () => {
    const c = capturar();
    const d = await comTeto(
      startCommand(h.client, args(['faça a tarefa impossível'], { agent: 'sozinho', project: h.projeto, isolation: 'none' }), {
        log: c.log,
        logErro: c.logErro,
        pollMs: 50,
      }),
      15_000,
      'hub start',
    );
    assert.equal(d?.estado, 'failed');
    assert.equal(process.exitCode, 1);
    assert.match(c.erros.join('\n'), /terminou como "failed"/);
  });

  test('fallback para outro agente é avisado e acompanhado até o fim (antes: saía calado na 1ª falha)', async () => {
    const c = capturar();
    const d = await comTeto(
      startCommand(h.client, args(['faça a tarefa com fallback'], { agent: 'flaky', project: h.projeto, isolation: 'none' }), {
        log: c.log,
        logErro: c.logErro,
        pollMs: 50,
      }),
      20_000,
      'hub start',
    );
    assert.match(c.texto(), /⚠ fallback: a tarefa saiu de ses_\w+ e passou para backup/, c.texto());
    assert.match(c.texto(), /RESPOSTA-OK/, 'a resposta do substituto precisa aparecer');
    assert.equal(d?.estado, 'completed');
    assert.equal(process.exitCode, undefined);
  });

  test('repositório git SEM commit: erro claro com as duas saídas (antes: "fatal: invalid reference: HEAD")', async () => {
    const vazio = path.join(h.raiz, 'repo-vazio');
    mkdirSync(vazio, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: vazio });
    const c = capturar();
    await assert.rejects(
      startCommand(h.client, args(['responda com a palavra OK'], { agent: 'ok', project: vazio }), {
        log: c.log,
        logErro: c.logErro,
      }),
      (err: Error) =>
        /ainda não tem nenhum commit/.test(err.message) &&
        /git commit/.test(err.message) &&
        /--isolation none/.test(err.message) &&
        !/invalid reference/.test(err.message),
    );
  });
});

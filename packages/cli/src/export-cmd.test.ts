import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Session } from '@agents-hub/core';
import { exportCommand, type SessionExport } from './export-cmd.js';
import {
  capturar,
  limpar,
  montarHub,
  semearDiff,
  semearEvento,
  semearSessao,
  type HubDeTeste,
} from './test-kit.js';

const ESC = String.fromCharCode(27);
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-const x = 1;',
  '+const x = 2; // ```crases``` no meio do patch',
  '',
].join('\n');

/** Não havia `hub export`: timeline, custo e diff não saíam do Hub (vistoria 14). */
describe('hub export', () => {
  let t: HubDeTeste;
  let sessao: Session;

  before(async () => {
    t = await montarHub('export');
    const projectId = t.hub.sessions.registerProject(t.raiz, 'projeto-export').id;
    sessao = semearSessao(t.hub, projectId, { title: 'refatorar a.ts' });
    const filha = semearSessao(t.hub, projectId, {
      parentId: sessao.id,
      rootId: sessao.id,
      depth: 1,
      agentId: 'codex',
      path: [`claude:${sessao.id}`, 'codex:y'],
    });
    semearEvento(t.hub, sessao, 'session.started');
    semearEvento(t.hub, sessao, 'message', { text: 'vou trocar x para 2' });
    semearEvento(t.hub, sessao, 'command.executed', { command: 'npm test', exitCode: 0 });
    semearEvento(
      t.hub,
      sessao,
      'turn.completed',
      {},
      { usd: 0.5, inputTokens: 1000, outputTokens: 200 },
    );
    semearEvento(t.hub, filha, 'turn.completed', {}, { usd: 0.25, inputTokens: 10, outputTokens: 5 });
    semearDiff(t.hub, sessao, PATCH);
  });

  after(async () => {
    await t.fechar();
    limpar(t.raiz);
  });

  test('markdown no stdout: cabeçalho, custo (sessão, delegadas, fluxo), timeline e diff — sem cor', async () => {
    const { out } = await capturar(() =>
      exportCommand(t.client, { command: 'export', positional: [sessao.id], flags: {} }),
    );
    const md = out.join('\n');
    assert.ok(!md.includes(ESC));
    assert.match(md, new RegExp(`^# Sessão ${sessao.id} — refatorar a\\.ts`));
    assert.match(md, /esta sessão: US\$ 0\.5000 · 1200 tokens/);
    assert.match(md, /com as delegadas: US\$ 0\.7500/);
    assert.match(md, /## Timeline \(4 eventos\)/);
    assert.match(md, /vou trocar x para 2/);
    assert.match(md, /\$ npm test/);
    // Cerca maior que as crases de dentro do patch: o bloco não quebra.
    assert.match(md, /\n````diff\ndiff --git a\/src\/a\.ts/);
    assert.ok(md.includes('+const x = 2;'));
  });

  test('--format json: o objeto completo, eventos sem `raw` por padrão', async () => {
    const { out } = await capturar(() =>
      exportCommand(t.client, { command: 'export', positional: [sessao.id], flags: { format: 'json' } }),
    );
    const dados = JSON.parse(out.join('\n')) as SessionExport;
    assert.equal(dados.session.id, sessao.id);
    assert.equal(dados.events.length, 4);
    assert.equal(
      dados.events.some((e) => 'raw' in e),
      false,
    );
    assert.equal(dados.cost.session.usd, 0.5);
    assert.equal(dados.cost.subtree.usd, 0.75);
    assert.equal(dados.diff, PATCH);
    assert.equal(dados.graph?.children.length, 1);

    const comRaw = await capturar(() =>
      exportCommand(t.client, {
        command: 'export',
        positional: [sessao.id],
        flags: { format: 'json', raw: true },
      }),
    );
    assert.ok((JSON.parse(comRaw.out.join('\n')) as SessionExport).events.every((e) => 'raw' in e));
  });

  test('--out grava o arquivo (formato pela extensão) e não sobrescreve sem --force', async () => {
    const destino = path.join(t.raiz, 'saida', 'sessao.json');
    await capturar(() =>
      exportCommand(t.client, { command: 'export', positional: [sessao.id], flags: { out: destino } }),
    );
    assert.ok(existsSync(destino));
    assert.equal((JSON.parse(readFileSync(destino, 'utf8')) as SessionExport).session.id, sessao.id);

    writeFileSync(destino, 'meu arquivo');
    await assert.rejects(
      () =>
        exportCommand(t.client, { command: 'export', positional: [sessao.id], flags: { out: destino } }),
      /já existe/,
    );
    assert.equal(readFileSync(destino, 'utf8'), 'meu arquivo');
    await capturar(() =>
      exportCommand(t.client, {
        command: 'export',
        positional: [sessao.id],
        flags: { out: destino, force: true },
      }),
    );
    assert.notEqual(readFileSync(destino, 'utf8'), 'meu arquivo');
  });

  test('formato inválido e sessão inexistente são erros', async () => {
    await assert.rejects(
      () =>
        exportCommand(t.client, {
          command: 'export',
          positional: [sessao.id],
          flags: { format: 'pdf' },
        }),
      /--format inválido/,
    );
    await assert.rejects(() =>
      exportCommand(t.client, { command: 'export', positional: ['ses_naoexiste000'], flags: {} }),
    );
  });
});

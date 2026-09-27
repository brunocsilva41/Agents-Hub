import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { TIMEOUT_DO_HOOK_SEC } from '@agents-hub/daemon';
import {
  gravarConfig,
  HOOK_TARGETS,
  hookCommand,
  hookInstalado,
  lerConfig,
  lerConfigParaGravar,
  MATCHER_DE_RISCO,
  mergeHooks,
} from './hooks-install.js';

/**
 * `hooks-install.ts` escreve na config de usuário do agente (item 7.1 do GOAL:
 * código de risco sem teste próprio). Tudo aqui roda num diretório temporário
 * — nunca em `~/.claude`. O que se protege: preservar o que a pessoa já tinha,
 * não duplicar a nossa entrada, backup antes de regravar e recusa de arquivo
 * que não parseia (antes virava `{}` e apagava a config inteira).
 */

const NOSSO = '"node" "C:/hub/cli/dist/main.js" hook';

describe('mergeHooks / hookInstalado', () => {
  test('preserva outras chaves e hooks alheios; a nossa entrada entra uma vez só', () => {
    const alheio = { matcher: 'Bash', hooks: [{ type: 'command', command: 'meu-linter.sh' }] };
    const atual = {
      model: 'opus',
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { PreToolUse: [alheio], PostToolUse: [{ matcher: '*', hooks: [] }] },
    };
    const uma = mergeHooks(atual, NOSSO);
    const duas = mergeHooks(uma, NOSSO);

    assert.equal(duas['model'], 'opus');
    assert.deepEqual(duas['permissions'], atual.permissions);
    const hooks = duas['hooks'] as Record<string, unknown[]>;
    assert.deepEqual(hooks['PostToolUse'], atual.hooks.PostToolUse, 'outros eventos intocados');
    const pre = hooks['PreToolUse'] as Array<{
      matcher: string;
      hooks: Array<{ command: string; timeout?: number }>;
    }>;
    assert.equal(pre.length, 2, 'reinstalar não duplica');
    assert.deepEqual(pre[0], alheio, 'o hook alheio continua, na mesma posição');
    assert.equal(pre[1]?.matcher, MATCHER_DE_RISCO);
    assert.equal(pre[1]?.hooks[0]?.command, NOSSO);
    assert.equal(pre[1]?.hooks[0]?.timeout, TIMEOUT_DO_HOOK_SEC);
    assert.deepEqual(atual.hooks.PreToolUse, [alheio], 'não muta o objeto de entrada');
  });

  test('PreToolUse que não é lista é tratado como vazio, sem lançar', () => {
    const r = mergeHooks({ hooks: { PreToolUse: 'lixo' } }, NOSSO);
    assert.equal(hookInstalado(r), true);
  });

  test('hookInstalado reconhece só o nosso comando', () => {
    assert.equal(hookInstalado({}), false);
    assert.equal(
      hookInstalado({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] },
      }),
      false,
    );
    assert.equal(hookInstalado(mergeHooks({}, NOSSO)), true);
  });

  test('o matcher cobre as ferramentas de risco e deixa as de leitura de fora', () => {
    const re = new RegExp(`^(${MATCHER_DE_RISCO})$`);
    for (const t of ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch']) {
      assert.ok(re.test(t), t);
    }
    for (const t of ['Read', 'Glob', 'Grep']) assert.ok(!re.test(t), t);
  });

  test('hookCommand usa o node atual e o bin.js desta CLI (entrada instalada, item 5.7), entre aspas', () => {
    const cmd = hookCommand();
    assert.ok(cmd.startsWith(`"${process.execPath}" "`));
    assert.ok(cmd.endsWith('bin.js" hook'));
    assert.equal(hookInstalado(mergeHooks({}, cmd)), true, 'o comando real é reconhecido como nosso');
  });

  test('HOOK_TARGETS: config de projeto fica dentro do projeto', () => {
    for (const alvo of HOOK_TARGETS) {
      const proj = path.join(os.tmpdir(), 'proj');
      const cfg = alvo.configProjeto?.(proj);
      if (cfg) assert.ok(cfg.startsWith(proj), `${alvo.id}: ${cfg}`);
    }
  });
});

describe('gravarConfig / leitura — num HOME temporário', () => {
  let raiz: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-hooks-install-'));
  });

  after(() => {
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  test('cria quando não existe (sem backup); inalterado não regrava; mudança faz backup', () => {
    const file = path.join(raiz, 'a', 'settings.json');
    const conteudo = mergeHooks({}, NOSSO);

    const criado = gravarConfig(file, {}, conteudo, new Date('2026-09-26T10:00:00Z'));
    assert.equal(criado.acao, 'criado');
    assert.equal(criado.backup, null);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), conteudo);

    const { doc: lido } = lerConfigParaGravar(file);
    const inalterado = gravarConfig(file, lido, mergeHooks(lido, NOSSO));
    assert.equal(inalterado.acao, 'inalterado');
    assert.equal(inalterado.backup, null);
    assert.equal(readdirSync(path.dirname(file)).length, 1, 'nenhum backup à toa');

    const mudado = gravarConfig(
      file,
      lido,
      { ...lido, model: 'sonnet' },
      new Date('2026-09-26T11:00:00Z'),
    );
    assert.equal(mudado.acao, 'atualizado');
    assert.ok(mudado.backup && existsSync(mudado.backup), 'backup gravado antes de regravar');
    assert.deepEqual(
      JSON.parse(readFileSync(mudado.backup, 'utf8')),
      conteudo,
      'backup tem o conteúdo anterior',
    );
  });

  test('arquivo que não parseia: leitura para gravar LANÇA; leitura para exibir não', () => {
    const file = path.join(raiz, 'quebrado.json');
    writeFileSync(file, '{ "model": "opus", ', 'utf8');
    assert.throws(() => lerConfigParaGravar(file));
    assert.doesNotThrow(() => lerConfig(file));
    assert.equal(
      readFileSync(file, 'utf8'),
      '{ "model": "opus", ',
      'o arquivo da pessoa não foi tocado',
    );
  });

  test('JSONC (comentário) é aceito para gravar, e a config é preservada no merge', () => {
    const file = path.join(raiz, 'comentado.json');
    writeFileSync(file, '{\n  // modelo preferido\n  "model": "opus"\n}\n', 'utf8');
    const { doc: lido, avisos } = lerConfigParaGravar(file);
    assert.equal(lido['model'], 'opus');
    assert.ok(avisos.length > 0, 'avisa que o comentário não sobrevive à regravação');
    const r = gravarConfig(file, lido, mergeHooks(lido, NOSSO));
    assert.equal(r.acao, 'atualizado');
    const final = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.equal(final['model'], 'opus');
    assert.equal(hookInstalado(final), true);
  });
});

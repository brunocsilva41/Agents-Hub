import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { montarInvocacao } from './process-adapter.js';
import { loadManifestDir } from './registry.js';
import { AgentManifestSchema } from './types.js';

/**
 * Itens 4.3 e 4.5 do GOAL (docs/12-goal-mvp-completo.md), vistoria 2026-09-25
 * (relatórios 03 e 10): `ctx.model` era ignorado por 8 dos 9 agentes — nenhum
 * manifesto levava o modelo ao CLI, e o campo "Modelo" do painel não tinha
 * efeito. Estes testes de contrato montam o argv efetivo de cada manifesto do
 * repositório.
 */

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANIFESTOS = loadManifestDir(path.join(RAIZ, 'manifests'));
const MODELO = 'modelo-de-teste/v1.2';

function templates(m: (typeof MANIFESTOS)[number]): Array<[string, string[]]> {
  const t: Array<[string, string[]]> = [['oneShot', m.invoke.oneShot]];
  if (m.invoke.resume) t.push(['resume', m.invoke.resume]);
  return t;
}

test('contrato: todo manifesto que declara suporte a modelo leva o modelo ao argv (oneShot e resume)', () => {
  assert.ok(MANIFESTOS.length >= 9);
  const comSuporte = MANIFESTOS.filter((m) => m.model.supported);
  // Os 8 CLIs instalados e conferidos no --help; só o Cursor (ausente) fica fora.
  assert.deepEqual(comSuporte.map((m) => m.id).sort(), [
    'antigravity',
    'claude',
    'codex',
    'copilot',
    'kimi',
    'mimo',
    'openclaude',
    'opencode',
  ]);

  for (const m of comSuporte) {
    for (const [nome, template] of templates(m)) {
      for (const mode of ['supervised', 'semi', 'autonomous'] as const) {
        const { args } = montarInvocacao(
          m,
          { mode, workdir: 'C:\\projeto', model: MODELO, extraArgs: [] },
          template,
          'prompt',
          'sess-1',
          'C:\\tmp\\p.md',
        );
        const i = args.indexOf(MODELO);
        assert.ok(i > 0, `${m.id}.${nome}/${mode}: modelo ausente do argv: ${JSON.stringify(args)}`);
        // Vem logo depois da flag declarada no manifesto (`--model`/`-m`).
        const flag = m.model.args[m.model.args.indexOf('{{model}}') - 1];
        assert.equal(args[i - 1], flag, `${m.id}.${nome}: modelo não está logo após ${flag}`);
      }
    }
  }
});

test('contrato: sem modelo, nenhuma flag de modelo solta no argv', () => {
  for (const m of MANIFESTOS) {
    for (const [nome, template] of templates(m)) {
      const semModelo = montarInvocacao(
        m,
        { mode: 'semi', workdir: 'C:\\projeto', model: undefined, extraArgs: [] },
        template,
        'prompt',
        'sess-1',
      );
      for (const flag of m.model.args.filter((a) => !a.includes('{{model}}'))) {
        assert.ok(
          !semModelo.args.includes(flag),
          `${m.id}.${nome}: "${flag}" sem valor engoliria o próximo argumento`,
        );
      }
    }
  }
});

test('manifesto sem suporte a modelo ignora o modelo (Cursor não verificado)', () => {
  const cursor = MANIFESTOS.find((m) => m.id === 'cursor');
  assert.ok(cursor);
  assert.equal(cursor.model.supported, false);
  const { args } = montarInvocacao(
    cursor,
    { mode: 'semi', workdir: 'C:\\p', model: MODELO, extraArgs: [] },
    cursor.invoke.oneShot,
    'prompt',
    null,
  );
  assert.ok(!args.includes(MODELO));
});

test('MODEL do env do projeto (campo "Modelo" das Configurações) vale quando a sessão não fixa modelo', () => {
  const claude = MANIFESTOS.find((m) => m.id === 'claude');
  assert.ok(claude);
  const base = { mode: 'semi' as const, workdir: 'C:\\p', extraArgs: [] };
  const peloEnv = montarInvocacao(
    claude,
    { ...base, env: { MODEL: 'sonnet' } },
    claude.invoke.oneShot,
    'x',
    null,
  );
  assert.deepEqual(
    peloEnv.args.slice(peloEnv.args.indexOf('--model'), peloEnv.args.indexOf('--model') + 2),
    ['--model', 'sonnet'],
  );
  // `ctx.model` explícito ganha do env.
  const explicito = montarInvocacao(
    claude,
    { ...base, model: 'opus', env: { MODEL: 'sonnet' } },
    claude.invoke.oneShot,
    'x',
    null,
  );
  assert.ok(explicito.args.includes('opus') && !explicito.args.includes('sonnet'));
});

test('modelo que parece flag ou tem controle é recusado (não vira argumento do CLI)', () => {
  const claude = MANIFESTOS.find((m) => m.id === 'claude');
  assert.ok(claude);
  for (const ruim of ['--dangerously-skip-permissions', '-p', 'a\nb', 'x'.repeat(201)]) {
    assert.throws(
      () =>
        montarInvocacao(
          claude,
          { mode: 'semi', workdir: 'C:\\p', model: ruim, extraArgs: [] },
          claude.invoke.oneShot,
          'x',
          null,
        ),
      /Modelo inválido/,
      JSON.stringify(ruim),
    );
  }
});

test('schema: model.supported exige {{model}} em model.args, e args sem suporte é erro', () => {
  const base = { id: 'x', name: 'X', bin: 'x', invoke: { oneShot: ['-p'] } };
  assert.equal(AgentManifestSchema.parse(base).model.supported, false);
  assert.equal(AgentManifestSchema.parse(base).verified.status, 'unverified');
  assert.equal(
    AgentManifestSchema.safeParse({ ...base, model: { supported: true, args: ['--model'] } }).success,
    false,
  );
  assert.equal(
    AgentManifestSchema.safeParse({ ...base, model: { supported: false, args: ['-m', '{{model}}'] } })
      .success,
    false,
  );
});

test('verified: todo manifesto declara status/versão; Cursor explicitamente não verificado', () => {
  const esperado: Record<string, string> = {
    antigravity: '1.2.10',
    claude: '2.1.283',
    codex: '0.155.0',
    copilot: '1.0.88',
    kimi: '2.0.0',
    mimo: '0.1.14',
    openclaude: '0.14.0',
    opencode: '1.18.32',
  };
  for (const m of MANIFESTOS) {
    assert.match(m.verified.date, /^\d{4}-\d{2}-\d{2}$/, `${m.id}: verified.date`);
    if (m.id === 'cursor') {
      assert.equal(m.verified.status, 'unverified');
      assert.equal(m.verified.version, null);
      continue;
    }
    assert.notEqual(m.verified.status, 'unverified', `${m.id}`);
    assert.equal(m.verified.version, esperado[m.id], `${m.id}: versão verificada`);
  }
});

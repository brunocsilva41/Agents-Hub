import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { initCommand, versaoAtende, type InitDeps } from './init-cmd.js';
import { capturar, descobertaFalsa, limpar, montarHub, repoGit, type HubDeTeste } from './test-kit.js';

/**
 * Achado MÉDIO da vistoria 14: não havia onboarding (`hub init`); doctor,
 * discover e painel não se conversavam. O init junta tudo numa tela, registra
 * o projeto só com consentimento e NUNCA grava config de agente (hooks/mcp
 * ficam como sugestão em modo prévia).
 */
describe('hub init', () => {
  let t: HubDeTeste;
  let raiz: string;

  before(async () => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-cli-init-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    // Manifestos mínimos: `bin: node` — nenhum CLI de modelo é chamado.
    for (const id of ['claude', 'codex', 'cursor']) {
      writeFileSync(
        path.join(manifestos, `${id}.yaml`),
        `id: ${id}\nname: ${id}\nvendor: T\ndescription: t\nbin: node\ninvoke:\n  oneShot: ["-e", "0"]\n  interactive: false\ndetect:\n  args: ["--version"]\ncapabilities:\n  - code-edit\nsession:\n  strategy: replay\nstream:\n  format: text\n  mapper: generic-text\ndefaults:\n  isolation: none\n  timeoutSeconds: 30\n`,
      );
    }
    t = await montarHub('init', {
      raiz,
      deps: {
        discoverAgent: async (id) =>
          id === 'claude'
            ? descobertaFalsa('claude')
            : id === 'codex'
              ? descobertaFalsa('codex', { auth: { state: 'absent', evidence: [] } })
              : descobertaFalsa(id, { installed: false, version: null }),
      },
    });
  });

  after(async () => {
    await t.fechar();
    limpar(raiz);
  });

  function deps(cwd: string, extra: Partial<InitDeps> = {}): InitDeps {
    return {
      ensureDaemon: async () => 'ja-estava',
      url: t.url,
      cwd,
      hookInstalado: () => false,
      ...extra,
    };
  }

  test('--yes: registra o diretório atual e só SUGERE hooks/mcp em prévia (sem --write)', async () => {
    const dir = path.join(raiz, 'projeto-sim');
    const git = repoGit(dir);
    writeFileSync(path.join(dir, 'x.txt'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'inicial');

    const { out, valor } = await capturar(() =>
      initCommand(t.client, { command: 'init', positional: [], flags: { yes: true } }, deps(dir)),
    );
    assert.equal(valor.project.action, 'registrado');
    assert.equal(valor.project.git, true);
    assert.equal(valor.project.commits, true);
    const { projects } = await t.client.projects();
    assert.ok(projects.some((p) => p.id === valor.project.id));

    assert.deepEqual(
      valor.agents.filter((a) => a.installed).map((a) => a.id).sort(),
      ['claude', 'codex'],
    );
    assert.ok(out.some((l) => l.includes('codex') && l.includes('credencial não encontrada')));
    assert.ok(valor.suggestions.includes('hub hooks install claude'));
    assert.ok(valor.suggestions.includes('hub hooks install codex'));
    assert.ok(valor.suggestions.includes('hub mcp install claude'));
    assert.ok(!valor.suggestions.some((s) => s.includes('cursor')), 'agente não instalado não entra');
    assert.ok(valor.suggestions.every((s) => !s.includes('--write')), 'nunca --write por conta própria');
    assert.ok(out.some((l) => l.includes(t.url)));

    // Rodar de novo reconhece o projeto.
    const denovo = await capturar(() =>
      initCommand(t.client, { command: 'init', positional: [], flags: { yes: true } }, deps(dir)),
    );
    assert.equal(denovo.valor.project.action, 'ja-registrado');
  });

  test('sem TTY e sem --yes: não pergunta nem registra — sugere', async () => {
    const dir = path.join(raiz, 'projeto-sugerido');
    mkdirSync(dir, { recursive: true });
    const antes = (await t.client.projects()).projects.length;
    const { out, valor } = await capturar(() =>
      initCommand(t.client, { command: 'init', positional: [], flags: {} }, deps(dir)),
    );
    assert.equal(valor.project.action, 'sugerido');
    assert.equal((await t.client.projects()).projects.length, antes);
    assert.ok(valor.suggestions.some((s) => s.startsWith('hub project add')));
    assert.equal(valor.project.git, false);
    assert.ok(out.some((l) => l.includes('não é um repositório git')));
  });

  test('com TTY: pergunta; "não" respeitado; gate já instalado não é sugerido', async () => {
    const dir = path.join(raiz, 'projeto-recusado');
    repoGit(dir); // git sem commit
    const perguntas: string[] = [];
    const { out, valor } = await capturar(() =>
      initCommand(
        t.client,
        { command: 'init', positional: [], flags: {} },
        deps(dir, {
          ask: async (p) => {
            perguntas.push(p);
            return false;
          },
          hookInstalado: (id) => id === 'claude',
          ensureDaemon: async () => 'iniciado',
        }),
      ),
    );
    assert.equal(perguntas.length, 1);
    assert.ok(perguntas[0]!.includes(dir));
    assert.equal(valor.project.action, 'recusado');
    assert.equal(valor.daemon, 'iniciado');
    assert.ok(!valor.suggestions.includes('hub hooks install claude'));
    assert.ok(out.some((l) => l.includes('gate instalado em claude')));
    assert.ok(out.some((l) => l.includes('sem nenhum commit')));
  });

  test('versão mínima do Node', () => {
    assert.equal(versaoAtende('22.5.0'), true);
    assert.equal(versaoAtende('v24.1.0'), true);
    assert.equal(versaoAtende('22.4.9'), false);
    assert.equal(versaoAtende('20.18.0'), false);
  });
});

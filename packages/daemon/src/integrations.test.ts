import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { isHubError } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';
import {
  aplicarIntegracao,
  estadoDasIntegracoes,
  planejarIntegracao,
  type IntegracoesDeps,
} from './integrations.js';
import { diffDeLinhas, mascararLinha } from './line-diff.js';
import { PROJECT_CONFIG_RELATIVE } from './project-config.js';

/*
 * Item 6.12 do GOAL (parte B, segurança): o painel mostra por agente se o
 * hook do gate e o MCP do Hub estão instalados (e com timeout antigo), e
 * instala com PRÉVIA — o diff do arquivo — gravando só com confirmação
 * explícita do que foi visto (`base`). Tudo em HOME temporário: nenhuma
 * config real de CLI é lida nem escrita.
 */

function tmp(prefixo: string): string {
  // Canônico: o registro de projetos normaliza 8.3 → longo (item 5.5).
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefixo)));
}

function depsDe(userHome: string): IntegracoesDeps {
  // Entrypoints são arquivos vazios que existem: só o caminho entra na config.
  // O da CLI se chama `main.js` porque é por `main.js" hook` que o hook do Hub
  // é reconhecido.
  const bin = path.join(userHome, 'bin');
  mkdirSync(bin, { recursive: true });
  const cliMain = path.join(bin, 'main.js');
  const mcpMain = path.join(bin, 'mcp-main.js');
  writeFileSync(cliMain, '', 'utf8');
  writeFileSync(mcpMain, '', 'utf8');
  return {
    userHome,
    hubHome: path.join(userHome, '.agents-hub'),
    hubUrl: 'http://127.0.0.1:4999',
    codexBypassAtivo: false,
    nodeBin: 'C:\\node\\node.exe',
    cliMain,
    mcpMain,
  };
}

function settingsClaude(home: string): string {
  return path.join(home, '.claude', 'settings.json');
}

describe('diff de linhas da prévia', () => {
  test('só as regiões alteradas, com contexto e salto', () => {
    const antes = Array.from({ length: 20 }, (_, i) => `linha ${i}`).join('\n');
    const depois = antes.replace('linha 10', 'linha DEZ');
    const d = diffDeLinhas(antes, depois, 2);
    assert.deepEqual(
      d.map((l) => `${l.tipo}${l.texto}`),
      [
        '@… 8 linha(s) iguais',
        ' linha 8',
        ' linha 9',
        '-linha 10',
        '+linha DEZ',
        ' linha 11',
        ' linha 12',
        '@… 7 linha(s) iguais',
      ],
    );
  });

  test('arquivo novo: tudo entra; iguais: diff vazio; CRLF não conta como mudança', () => {
    assert.deepEqual(
      diffDeLinhas('', 'a\nb\n').map((l) => l.tipo),
      ['+', '+'],
    );
    assert.deepEqual(diffDeLinhas('a\nb\n', 'a\nb\n'), []);
    assert.deepEqual(diffDeLinhas('a\r\nb\r\n', 'a\nb\n'), []);
  });

  test('valor de chave com cara de credencial sai mascarado', () => {
    assert.equal(mascararLinha('    "OPENAI_API_KEY": "sk-segredo",'), '    "OPENAI_API_KEY": "••••",');
    assert.equal(mascararLinha('token = "abc"'), 'token = "••••"');
    assert.equal(mascararLinha('    "command": "node",'), '    "command": "node",');
    assert.equal(mascararLinha('  "apiKeys": {'), '  "apiKeys": {');
  });
});

describe('integrações: estado, prévia e gravação (sem HTTP)', () => {
  let home: string;
  let deps: IntegracoesDeps;

  before(() => {
    home = tmp('hub-integ-');
    deps = depsDe(home);
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  test('hook instalado com timeout antigo aparece como instalado E com aviso', () => {
    mkdirSync(path.dirname(settingsClaude(home)), { recursive: true });
    writeFileSync(
      settingsClaude(home),
      JSON.stringify(
        {
          env: { ANTHROPIC_API_KEY: 'sk-nao-vaza' },
          hooks: {
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: 'alheio.sh' }] },
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: '"node" "x/main.js" hook', timeout: 10 }],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    const estado = estadoDasIntegracoes(deps, ['claude', 'cursor']);
    const claude = estado.find((e) => e.agentId === 'claude')!;
    assert.equal(claude.hook.modo, 'arquivo');
    assert.equal(claude.hook.instalado, true);
    assert.match(claude.hook.avisoTimeout ?? '', /timeout 10 s/);
    const cursor = estado.find((e) => e.agentId === 'cursor')!;
    assert.equal(cursor.hook.modo, 'nenhum');
    assert.equal(cursor.hook.instalavelPeloPainel, false);
    const codex = estado.find((e) => e.agentId === 'codex')!;
    assert.equal(codex.hook.modo, 'codex-inline');
    // O MCP do Claude é por projeto: sem projeto, o estado diz que precisa de um.
    assert.equal(claude.mcp?.precisaDeProjeto, true);
  });

  test('prévia do hook: diff do arquivo, sem gravar, preservando o hook alheio e mascarando a chave', () => {
    const antes = readFileSync(settingsClaude(home), 'utf8');
    const plano = planejarIntegracao(deps, 'claude', 'hook');
    assert.equal(plano.acao, 'atualizar');
    assert.equal(readFileSync(settingsClaude(home), 'utf8'), antes, 'prévia não grava');
    const texto = plano.diff.map((l) => `${l.tipo}${l.texto}`).join('\n');
    assert.match(texto, /\+.*"timeout": 120/);
    assert.match(texto, /-.*"timeout": 10/);
    assert.doesNotMatch(texto, /sk-nao-vaza/);
    assert.ok(
      !plano.diff.some((l) => l.tipo === '-' && l.texto.includes('alheio.sh')),
      'hook alheio fica',
    );
  });

  test('gravar exige o base da prévia: arquivo mudou no meio -> CONFIG_CHANGED e nada gravado', () => {
    const plano = planejarIntegracao(deps, 'claude', 'hook');
    const mexido = readFileSync(settingsClaude(home), 'utf8').replace('alheio.sh', 'alheio2.sh');
    writeFileSync(settingsClaude(home), mexido, 'utf8');
    assert.throws(
      () => aplicarIntegracao(deps, 'claude', 'hook', plano.base),
      (err: unknown) => isHubError(err) && err.code === 'CONFIG_CHANGED',
    );
    assert.equal(readFileSync(settingsClaude(home), 'utf8'), mexido);
  });

  test('gravar com o base certo: hook atualizado, backup versionado, estado sem aviso', () => {
    const plano = planejarIntegracao(deps, 'claude', 'hook');
    const { backup } = aplicarIntegracao(deps, 'claude', 'hook', plano.base);
    assert.ok(backup && existsSync(backup), 'backup do original');
    const doc = JSON.parse(readFileSync(settingsClaude(home), 'utf8')) as {
      env: Record<string, string>;
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; timeout?: number }> }> };
    };
    assert.equal(doc.env['ANTHROPIC_API_KEY'], 'sk-nao-vaza', 'resto da config intacto');
    assert.equal(doc.hooks.PreToolUse.length, 2);
    assert.equal(doc.hooks.PreToolUse[1]!.hooks[0]!.timeout, 120);
    const claude = estadoDasIntegracoes(deps, ['claude']).find((e) => e.agentId === 'claude')!;
    assert.equal(claude.hook.avisoTimeout, null);
    // De novo: nada a fazer, nada gravado.
    const denovo = planejarIntegracao(deps, 'claude', 'hook');
    assert.equal(denovo.acao, 'nada');
    assert.deepEqual(denovo.diff, []);
  });

  test('config ilegível é recusada sem gravar (AGENT_CONFIG_INVALID)', () => {
    const f = path.join(home, '.openclaude', 'settings.json');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, '{ "hooks": ', 'utf8');
    assert.throws(
      () => planejarIntegracao(deps, 'openclaude', 'hook'),
      (err: unknown) => isHubError(err) && err.code === 'AGENT_CONFIG_INVALID',
    );
    assert.equal(readFileSync(f, 'utf8'), '{ "hooks": ');
  });

  test('MCP do Codex (TOML): prévia mostra a seção nova; gravar preserva o resto', () => {
    const f = path.join(home, '.codex', 'config.toml');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, 'model = "o3"\n\n[mcp_servers.outro]\ncommand = "x"\nargs = []\n', 'utf8');
    const antes = estadoDasIntegracoes(deps, []).find((e) => e.agentId === 'codex')!;
    assert.equal(antes.mcp?.registrado, false);
    const plano = planejarIntegracao(deps, 'codex', 'mcp');
    assert.equal(plano.acao, 'atualizar');
    assert.ok(plano.diff.some((l) => l.tipo === '+' && l.texto === '[mcp_servers.agents-hub]'));
    aplicarIntegracao(deps, 'codex', 'mcp', plano.base);
    const texto = readFileSync(f, 'utf8');
    assert.match(texto, /\[mcp_servers\.outro\]/);
    assert.match(texto, /model = "o3"/);
    const depois = estadoDasIntegracoes(deps, []).find((e) => e.agentId === 'codex')!;
    assert.equal(depois.mcp?.registrado, true);
    assert.equal(depois.mcp?.atualizado, true);
  });

  test('gate do Codex não se instala pelo painel (é config do Hub, lida na subida)', () => {
    assert.throws(
      () => planejarIntegracao(deps, 'codex', 'hook'),
      (err: unknown) => isHubError(err) && err.code === 'CAPABILITY_UNRESOLVED',
    );
  });
});

describe('rotas /integrations e prévia de política (HTTP)', () => {
  let raiz: string;
  let userHome: string;
  let hub: Hub;
  let base: string;
  let projectId: string;

  const chamar = async (
    method: string,
    caminho: string,
    body?: unknown,
    comToken = true,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (comToken) headers['Authorization'] = `Bearer ${hub.operatorToken}`;
    const res = await fetch(`${base}${caminho}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  before(async () => {
    raiz = tmp('hub-integ-http-');
    userHome = path.join(raiz, 'usuario');
    mkdirSync(userHome, { recursive: true });
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });
    const projetoDir = path.join(raiz, 'projeto');
    mkdirSync(path.join(projetoDir, '.agents-hub'), { recursive: true });
    writeFileSync(path.join(projetoDir, PROJECT_CONFIG_RELATIVE), 'memory: x\n', 'utf8');
    hub = createHub(
      { home: path.join(raiz, 'home'), manifestsDir: manifestos, port: 0 },
      { homeDir: userHome },
    );
    const { host, port } = await hub.start();
    base = `http://${host}:${port}`;
    projectId = hub.sessions.registerProject(projetoDir, 'projeto').id;
  });

  after(async () => {
    await hub.shutdown();
    rmSync(raiz, { recursive: true, force: true });
  });

  test('GET /integrations lê do home injetado (nunca do home real)', async () => {
    const { status, json } = await chamar(
      'GET',
      `/integrations?projectId=${projectId}`,
      undefined,
      false,
    );
    assert.equal(status, 200);
    const lista = json['integrations'] as Array<{
      agentId: string;
      hook: { arquivo: string | null };
      mcp: { arquivo: string | null } | null;
    }>;
    const claude = lista.find((i) => i.agentId === 'claude')!;
    assert.ok(claude.hook.arquivo!.startsWith(userHome), claude.hook.arquivo!);
    // Com projeto, o `.mcp.json` do Claude resolve dentro do projeto.
    assert.ok(claude.mcp!.arquivo!.startsWith(path.join(raiz, 'projeto')));
  });

  test('POST sem token é 401; prévia não grava; gravar sem base é 422; com base grava e audita', async () => {
    const semToken = await chamar('POST', '/integrations/claude/hook', {}, false);
    assert.equal(semToken.status, 401);

    const previa = await chamar('POST', '/integrations/claude/hook', {});
    assert.equal(previa.status, 200);
    const plano = previa.json['plan'] as { acao: string; base: string; arquivo: string };
    assert.equal(plano.acao, 'criar');
    assert.equal(existsSync(plano.arquivo), false, 'prévia não cria o arquivo');

    const semBase = await chamar('POST', '/integrations/claude/hook', { dryRun: false });
    assert.equal(semBase.status, 422);
    assert.equal(existsSync(plano.arquivo), false);

    const grava = await chamar('POST', '/integrations/claude/hook', { dryRun: false, base: plano.base });
    assert.equal(grava.status, 200, JSON.stringify(grava.json));
    assert.equal(existsSync(plano.arquivo), true);

    const audit = await chamar('GET', '/audit?kind=integration.install', undefined, false);
    const entradas = audit.json['entries'] as Array<{ actor: string; action: string }>;
    assert.equal(entradas.length, 1);
    assert.match(entradas[0]!.action, /hook.*claude/);
    assert.ok(entradas[0]!.actor.startsWith('cli:'));
  });

  test('PUT /policy?dryRun=1 diz o que afrouxa SEM gravar nem auditar', async () => {
    const r = await chamar('PUT', '/policy?dryRun=1', { policy: { risk: { irreversible: 'allow' } } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json['dryRun'], true);
    assert.deepEqual(r.json['loosened'], ['risk.irreversible']);
    assert.equal(existsSync(path.join(hub.config.home, 'config.json')), false, 'nada gravado');
    assert.equal(hub.config.policy.risk.irreversible, 'approve', 'nada passou a valer');
    const audit = await chamar('GET', '/audit?kind=policy.updated', undefined, false);
    assert.deepEqual(audit.json['entries'], []);
    // Prévia também valida: campo inexistente é 422.
    const invalida = await chamar('PUT', '/policy?dryRun=1', { policy: { maxDeph: 1 } });
    assert.equal(invalida.status, 422);
    // E exige token, como a gravação.
    const semToken = await chamar('PUT', '/policy?dryRun=1', { policy: {} }, false);
    assert.equal(semToken.status, 401);
  });

  test('PUT /projects/:id/policy?dryRun=1 lista clamp e campos de execução ignorados, sem gravar', async () => {
    const arquivo = path.join(raiz, 'projeto', PROJECT_CONFIG_RELATIVE);
    const antes = readFileSync(arquivo, 'utf8');
    const r = await chamar('PUT', `/projects/${projectId}/policy?dryRun=1`, {
      policy: { risk: { irreversible: 'allow' }, validation: { command: 'npm test' } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok((r.json['clamped'] as string[]).includes('risk.irreversible'));
    assert.deepEqual(r.json['ignoredExecFields'], ['validation.command']);
    assert.equal(readFileSync(arquivo, 'utf8'), antes, 'config do projeto intacta');
    assert.equal(
      readdirSync(path.dirname(arquivo)).length,
      1,
      'nenhum arquivo novo (backup/tmp) ao lado',
    );
  });
});

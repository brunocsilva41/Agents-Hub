import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { isHubError } from '@agents-hub/core';
import { cliHookEntrypoint, installRoot, loadConfig, mensagemDeJsonInvalido } from './config.js';

/**
 * `loadConfig` lê `config.json` sem validação nenhuma antes desta mudança —
 * um cast cego (`as Partial<HubConfig>`) e um merge raso de `policy`. Os dois
 * testes abaixo são os que ficariam vermelhos se qualquer um dos dois
 * voltasse: (a) prova que `policy.validation.review` parcial não apaga
 * `command`/`commandTimeoutSeconds` do padrão; (b) prova que um tipo errado
 * falha alto, em vez de virar `NaN` silencioso.
 */
describe('loadConfig — validação de config.json', () => {
  const raizes: string[] = [];

  after(() => {
    for (const raiz of raizes) {
      try {
        rmSync(raiz, { recursive: true, force: true });
      } catch {
        /* limpeza de temp é oportunista */
      }
    }
  });

  function homeComConfig(conteudo: unknown): string {
    const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-config-'));
    raizes.push(raiz);
    mkdirSync(raiz, { recursive: true });
    writeFileSync(path.join(raiz, 'config.json'), JSON.stringify(conteudo, null, 2), 'utf8');
    return raiz;
  }

  test('gate.failMode: ausente por padrão, aceita open/closed e recusa outro valor', () => {
    // Ausente = padrão por contexto no hook (fechado em sessão do Hub).
    assert.equal(loadConfig({ home: homeComConfig({}) }).gate?.failMode, undefined);
    assert.equal(
      loadConfig({ home: homeComConfig({ gate: { failMode: 'closed' } }) }).gate?.failMode,
      'closed',
    );
    assert.equal(
      loadConfig({ home: homeComConfig({ gate: { failMode: 'open' } }) }).gate?.failMode,
      'open',
    );
    assert.throws(
      () => loadConfig({ home: homeComConfig({ gate: { failMode: 'talvez' } }) }),
      (err: unknown) => isHubError(err) && err.code === 'HUB_CONFIG_INVALID',
    );
  });

  test('validation.review parcial preserva command e commandTimeoutSeconds do padrão', () => {
    const home = homeComConfig({
      policy: {
        validation: {
          review: { enabled: true },
        },
      },
    });

    const config = loadConfig({ home });

    // O merge raso que isto substitui trocava o objeto `validation` inteiro:
    // gravar só `review.enabled` apagava `command` (que devia continuar `null`,
    // o padrão) e `commandTimeoutSeconds` (que devia continuar 600).
    assert.equal(config.policy.validation.command, null);
    assert.equal(config.policy.validation.commandTimeoutSeconds, 600);
    assert.equal(config.policy.validation.review.enabled, true);
    assert.equal(
      config.policy.validation.review.agent,
      null,
      'agent não foi declarado no override, continua o padrão',
    );
  });

  test('tipo errado em port falha alto e claro, não vira NaN silencioso', () => {
    const home = homeComConfig({ port: 'abc' });

    assert.throws(
      () => loadConfig({ home }),
      (err: unknown) => {
        assert.ok(isHubError(err), 'deveria lançar HubError');
        assert.equal((err as { code: string }).code, 'HUB_CONFIG_INVALID');
        return true;
      },
    );
  });

  test('config.json com chaves desconhecidas (versão anterior do Hub) não quebra a subida', () => {
    const home = homeComConfig({ port: 5050, umaChaveQueNaoExisteMais: 'valor-antigo' });
    const config = loadConfig({ home });
    assert.equal(config.port, 5050);
  });

  // R07-07: o `HubError` já existia, mas dizia "at position 20" — ninguém conta
  // caracteres num arquivo. Agora diz caminho:linha:coluna.
  test('JSON inválido: mensagem com caminho, linha e coluna', () => {
    const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-config-'));
    raizes.push(raiz);
    const arquivo = path.join(raiz, 'config.json');
    writeFileSync(arquivo, '{\n  "port": 4747,\n  oops\n}\n', 'utf8');
    assert.throws(
      () => loadConfig({ home: raiz }, {}),
      (err: unknown) => {
        assert.ok(isHubError(err));
        assert.ok((err as Error).message.startsWith(`${arquivo}:3:3:`), (err as Error).message);
        assert.match((err as Error).message, /linha 3, coluna 3/);
        return true;
      },
    );
  });

  test('mensagem de JSON truncado aponta o fim do arquivo', () => {
    let erro: Error | undefined;
    try {
      JSON.parse('{\n  "port": 1');
    } catch (e) {
      erro = e as Error;
    }
    assert.match(mensagemDeJsonInvalido('c.json', '{\n  "port": 1', erro!), /^c\.json:2:/);
  });

  test('BOM do Bloco de Notas não invalida o config.json', () => {
    const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-config-'));
    raizes.push(raiz);
    writeFileSync(path.join(raiz, 'config.json'), '﻿{"port": 5151}', 'utf8');
    assert.equal(loadConfig({ home: raiz }, {}).port, 5151);
  });
});

// R07-08 / R14-07: `AGENTS_HUB_PORT` valia só para `hub daemon`; CLI, hook e
// `hub mcp` usavam a porta do config.json. Agora é `loadConfig` que aplica.
describe('loadConfig — variáveis de ambiente', () => {
  const raizes: string[] = [];
  after(() => {
    for (const raiz of raizes) rmSync(raiz, { recursive: true, force: true });
  });
  function home(conteudo?: unknown): string {
    const raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-config-env-'));
    raizes.push(raiz);
    if (conteudo !== undefined)
      writeFileSync(path.join(raiz, 'config.json'), JSON.stringify(conteudo), 'utf8');
    return raiz;
  }

  test('AGENTS_HUB_PORT vence o config.json', () => {
    assert.equal(loadConfig({ home: home({ port: 5000 }) }, { AGENTS_HUB_PORT: '48210' }).port, 48210);
  });

  test('override explícito vence a variável (createHub({ port: 0 }) dos testes)', () => {
    assert.equal(loadConfig({ home: home(), port: 0 }, { AGENTS_HUB_PORT: '48210' }).port, 0);
  });

  test('AGENTS_HUB_PORT=abc lança HubError com o nome da variável', () => {
    assert.throws(
      () => loadConfig({ home: home() }, { AGENTS_HUB_PORT: 'abc' }),
      (err: unknown) => isHubError(err) && /AGENTS_HUB_PORT/.test((err as Error).message),
    );
  });

  test('AGENTS_HUB_HOME do ambiente passado é respeitada', () => {
    const h = home({ port: 5252 });
    assert.equal(loadConfig({}, { AGENTS_HUB_HOME: h }).home, h);
    assert.equal(loadConfig({}, { AGENTS_HUB_HOME: h }).port, 5252);
  });
});

// Item 5.7: instalado pelo tarball, os pacotes ficam em
// `agents-hub/node_modules/@agents-hub/*`; "três níveis acima" caía em
// `node_modules/` e o daemon subia sem manifestos e sem painel.
describe('raiz da instalação', () => {
  test('pacote instalado: a raiz é o próprio agents-hub/', () => {
    // Prefixo ABSOLUTO na plataforma corrente: `installRoot` resolve o
    // caminho, e `C:` no Linux é um nome relativo que viraria `<cwd>/C:/...`.
    const prefixo = path.join(os.tmpdir(), 'npm');
    const dist = path.join(
      prefixo,
      'node_modules',
      'agents-hub',
      'node_modules',
      '@agents-hub',
      'daemon',
      'dist',
    );
    assert.equal(installRoot(dist), path.join(prefixo, 'node_modules', 'agents-hub'));
  });

  test('clone: a raiz é a do repositório (tem manifests/)', () => {
    const raiz = installRoot();
    assert.ok(existsSync(path.join(raiz, 'manifests', 'claude.yaml')), raiz);
  });

  test('o hook do Codex aponta para o bin.js que existe (não para main.js)', () => {
    const entrada = cliHookEntrypoint();
    assert.ok(entrada.endsWith(path.join('cli', 'dist', 'bin.js')), entrada);
    assert.ok(existsSync(entrada), entrada);
  });
});

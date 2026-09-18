import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { isHubError } from '@agents-hub/core';
import { loadConfig } from './config.js';

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
});

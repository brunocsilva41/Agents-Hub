import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { mcpTargets } from '@agents-hub/daemon';
import { estadoDoRegistro, renderSnippet, serverSpec, writeConfig } from './mcp-install.js';

/**
 * Vistoria 07, R07-23: `hub mcp` dizia "registrado" para qualquer arquivo que
 * contivesse a string `agents-hub` (comentário, caminho de outro projeto,
 * servidor de nome parecido). Agora: servidor pelo nome, parseado, e comparado
 * com o que `--write` gravaria. HOME temporário: nada toca config real.
 */

describe('hub mcp — detecção estruturada do registro', () => {
  let home: string;
  const url = 'http://127.0.0.1:4747';

  before(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-registro-'));
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const alvo = (id: string) => mcpTargets(home).find((t) => t.agentId === id)!;

  test('a string "agents-hub" em outro lugar do arquivo NÃO é registro', () => {
    const cursor = alvo('cursor');
    const arquivo = path.join(home, 'cursor-string.json');
    writeFileSync(
      arquivo,
      JSON.stringify({
        mcpServers: {
          'outro-servidor': { command: 'node', args: ['C:/projetos/agents-hub/tools/x.js'] },
          'agents-hub-velho': { command: 'node', args: ['y.js'] },
        },
      }),
    );
    assert.equal(estadoDoRegistro(cursor, arquivo, serverSpec('cursor', url)).estado, 'ausente');
  });

  test('servidor com o nosso nome e o nosso entrypoint: atualizado', () => {
    const cursor = alvo('cursor');
    const arquivo = path.join(home, 'cursor-ok.json');
    writeConfig(cursor, serverSpec('cursor', url), arquivo);
    assert.equal(estadoDoRegistro(cursor, arquivo, serverSpec('cursor', url)).estado, 'atualizado');
  });

  test('servidor com o nosso nome apontando para outro caminho/porta: desatualizado', () => {
    const cursor = alvo('cursor');
    const arquivo = path.join(home, 'cursor-velho.json');
    writeFileSync(
      arquivo,
      JSON.stringify({ mcpServers: { 'agents-hub': { command: 'node', args: ['C:/antigo/main.js'] } } }),
    );
    assert.equal(estadoDoRegistro(cursor, arquivo, serverSpec('cursor', url)).estado, 'desatualizado');
    // E porta diferente também.
    const outro = path.join(home, 'cursor-porta.json');
    writeConfig(cursor, serverSpec('cursor', 'http://127.0.0.1:9999'), outro);
    assert.equal(estadoDoRegistro(cursor, outro, serverSpec('cursor', url)).estado, 'desatualizado');
  });

  test('TOML do Codex: comentário com o nome não conta; a tabela sim', () => {
    const codex = alvo('codex');
    const soComentario = path.join(home, 'codex-comentario.toml');
    writeFileSync(soComentario, '# lembrar de instalar o agents-hub\nmodel = "gpt-5"\n');
    assert.equal(estadoDoRegistro(codex, soComentario, serverSpec('codex', url)).estado, 'ausente');

    const certo = path.join(home, 'codex-ok.toml');
    writeFileSync(certo, `${renderSnippet(codex, serverSpec('codex', url))}\n`);
    assert.equal(estadoDoRegistro(codex, certo, serverSpec('codex', url)).estado, 'atualizado');
  });

  test('arquivo inexistente: ausente; JSON quebrado: ilegível (não "registrado")', () => {
    const cursor = alvo('cursor');
    assert.equal(
      estadoDoRegistro(cursor, path.join(home, 'nao-existe.json'), serverSpec('cursor', url)).estado,
      'ausente',
    );
    const quebrado = path.join(home, 'quebrado.json');
    writeFileSync(quebrado, '{"mcpServers": {"agents-hub": {');
    assert.equal(estadoDoRegistro(cursor, quebrado, serverSpec('cursor', url)).estado, 'ilegivel');
  });
});

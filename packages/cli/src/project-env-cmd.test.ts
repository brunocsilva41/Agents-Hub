import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { HubClient } from './client.js';
import { ErroDeUso } from './erro-cli.js';
import { capturar, montarHubDeTeste, type HubDeTeste } from './hub-de-teste.js';
import { MASCARA, projectEnvCommand, valorParaMostrar } from './project-env-cmd.js';

/**
 * `hub project env` contra um daemon REAL isolado (vistoria 07):
 * - R07-22: valores com cara de segredo não saem em claro (listagem e eco);
 * - R07-11: `--set` sem valor, `--unset` de chave inexistente e `--agent`
 *   inexistente são erros claros, e nada é gravado.
 */

const args = (flags: Record<string, string | boolean>) => ({ command: 'project', positional: ['env'], flags });

describe('hub project env', () => {
  let h: HubDeTeste;
  let client: HubClient;

  before(async () => {
    h = await montarHubDeTeste([{ id: 'ok', modo: 'ok' }], { prefixo: 'hub-cli-env-' });
    h.hub.sessions.registerProject(h.projeto, 'projeto-env');
    // PUT /projects/:id/context exige o token de operador.
    client = new HubClient(`http://${h.hub.config.host}:${h.hub.config.port}`, { token: h.hub.operatorToken });
  });

  after(async () => {
    await h.encerrar();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  const envSalvo = async (): Promise<Record<string, Record<string, string>>> => {
    const { projects } = await client.projects();
    const id = projects.find((p) => p.path === h.projeto || p.name === 'projeto-env')!.id;
    return (await client.projectContext(id)).context.env ?? {};
  };

  test('--set de chave secreta: grava o valor real, mas o eco e a listagem mascaram', async () => {
    const c = capturar();
    await projectEnvCommand(client, args({ agent: 'ok', set: 'OPENAI_API_KEY=abc-segredo-123' }), h.projeto, c);
    assert.equal((await envSalvo())['ok']?.['OPENAI_API_KEY'], 'abc-segredo-123', 'o valor real vai para o banco');
    assert.doesNotMatch(c.texto(), /abc-segredo-123/, 'o eco não pode mostrar o segredo');
    assert.match(c.texto(), new RegExp(`OPENAI_API_KEY=${MASCARA.replace(/\*/g, '\\*')}`));

    // Valor que parece credencial sob nome inocente também é mascarado.
    await projectEnvCommand(client, args({ agent: 'ok', set: 'OPENAI_EXTRA_HEADER=Bearer xyz987' }), h.projeto, capturar());
    await projectEnvCommand(client, args({ agent: 'ok', set: 'OPENAI_BASE_URL=http://localhost:11434/v1' }), h.projeto, capturar());

    const lista = capturar();
    await projectEnvCommand(client, args({}), h.projeto, lista);
    const texto = lista.texto();
    assert.doesNotMatch(texto, /abc-segredo-123/);
    assert.doesNotMatch(texto, /xyz987/);
    assert.match(texto, /OPENAI_BASE_URL=http:\/\/localhost:11434\/v1/, 'valor comum continua visível');
  });

  test('--set sem valor é erro de uso (antes listava em silêncio)', async () => {
    await assert.rejects(
      () => projectEnvCommand(client, args({ agent: 'ok', set: true }), h.projeto, capturar()),
      (err: unknown) => err instanceof ErroDeUso && /--set precisa de um valor/.test(err.message),
    );
    await assert.rejects(
      () => projectEnvCommand(client, args({ agent: 'ok', set: 'SEM_IGUAL' }), h.projeto, capturar()),
      /formato esperado: --set CHAVE=VALOR/,
    );
  });

  test('--unset de chave inexistente é erro e não grava nada (antes dizia "removido")', async () => {
    const antes = await envSalvo();
    const c = capturar();
    await assert.rejects(
      () => projectEnvCommand(client, args({ agent: 'ok', unset: 'NAO_EXISTE' }), h.projeto, c),
      /"NAO_EXISTE" não está configurada para ok — nada removido/,
    );
    assert.doesNotMatch(c.texto(), /removido/);
    assert.deepEqual(await envSalvo(), antes);
  });

  test('--agent inexistente é erro listando os válidos e não grava nada', async () => {
    const antes = await envSalvo();
    await assert.rejects(
      () => projectEnvCommand(client, args({ agent: 'naoexiste', set: 'OPENAI_BASE_URL=x' }), h.projeto, capturar()),
      /agente "naoexiste" não registrado\. Disponíveis: ok/,
    );
    await assert.rejects(
      () => projectEnvCommand(client, args({ agent: 'naoexiste' }), h.projeto, capturar()),
      /agente "naoexiste" não registrado/,
    );
    assert.deepEqual(await envSalvo(), antes);
    assert.equal(Object.keys(antes).includes('naoexiste'), false);
  });

  test('valorParaMostrar: nomes e formatos de segredo', () => {
    assert.equal(valorParaMostrar('GITHUB_TOKEN', 'ghp_x'), MASCARA);
    assert.equal(valorParaMostrar('DB_PASSWORD', 'x'), MASCARA);
    assert.equal(valorParaMostrar('CLIENT_SECRET', 'x'), MASCARA);
    assert.equal(valorParaMostrar('HEADER', 'Bearer abc'), MASCARA);
    assert.equal(valorParaMostrar('QUALQUER', 'sk-ant-abcdefghijkl'), MASCARA);
    assert.equal(valorParaMostrar('MODEL', 'gpt-5'), 'gpt-5');
    assert.equal(valorParaMostrar('API_KEY', ''), '', 'vazio continua vazio (não finge que há valor)');
  });
});

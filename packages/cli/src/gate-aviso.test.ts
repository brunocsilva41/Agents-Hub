import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { HookStatusSummary, IntegrationSummary } from './client.js';
import { avisoDeGate } from './gate-aviso.js';
import { capturar, montarHubDeTeste, type HubDeTeste } from './hub-de-teste.js';
import { startCommand } from './start-cmd.js';

/**
 * Vistoria 14, R14-11: o padrão é `semi` + `exec: allow`, e sem o gate
 * pré-execução o irreversível só é VIGIADO (visto depois de rodar). Nada na
 * saída do `hub start` dizia isso.
 */

function integracao(agentId: string, hook: Partial<HookStatusSummary>): IntegrationSummary {
  return {
    agentId,
    mcp: null,
    hook: {
      modo: 'arquivo',
      arquivo: '/home/x/.claude/settings.json',
      instalado: false,
      avisoTimeout: null,
      erro: null,
      nota: '',
      comando: `hub hooks install ${agentId} --write`,
      instalavelPeloPainel: true,
      ...hook,
    },
  };
}

describe('aviso de gate pré-execução ausente', () => {
  test('claude sem o hook: diz que só vigia e qual comando instala', () => {
    const [linha, ...resto] = avisoDeGate('claude', integracao('claude', {}));
    assert.match(
      linha ?? '',
      /o gate pré-execução não está instalado para claude: ações de risco só serão vigiadas, não bloqueadas — rode hub hooks install claude --write/,
    );
    assert.deepEqual(resto, []);
  });

  test('codex com o bypass desligado: mesmo aviso, com o comando do codex', () => {
    const linhas = avisoDeGate('codex', integracao('codex', { modo: 'codex-inline', comando: 'hub hooks install codex --write' }));
    assert.match(linhas.join('\n'), /não está instalado para codex.*hub hooks install codex --write/);
  });

  test('hook instalado: sem aviso; com timeout antigo: pede para reinstalar', () => {
    assert.deepEqual(avisoDeGate('claude', integracao('claude', { instalado: true })), []);
    const linhas = avisoDeGate('claude', integracao('claude', { instalado: true, avisoTimeout: 'hook do gate instalado com timeout 10 s' }));
    assert.match(linhas.join('\n'), /timeout 10 s — reinstale: hub hooks install claude --write/);
  });

  test('agente sem hook possível: diz que só há vigilância reativa', () => {
    const linhas = avisoDeGate('kimi', integracao('kimi', { modo: 'nenhum', comando: null }));
    assert.match(linhas.join('\n'), /kimi não tem gate pré-execução: .*vigilância reativa/);
    assert.match(avisoDeGate('x', undefined).join('\n'), /não tem gate pré-execução/);
  });
});

describe('hub start mostra o aviso (daemon real, agente falso)', () => {
  let h: HubDeTeste;

  before(async () => {
    h = await montarHubDeTeste([{ id: 'semgate', modo: 'ok' }], { prefixo: 'hub-cli-gate-' });
    h.hub.sessions.registerProject(h.projeto, 'projeto-gate');
  });

  after(async () => {
    await h.encerrar();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  test('na saída do start, antes de acompanhar a sessão', async () => {
    const c = capturar();
    await startCommand(
      h.client,
      { command: 'start', positional: ['objetivo descritivo o bastante'], flags: { agent: 'semgate', project: h.projeto, detach: true, isolation: 'none' } },
      { log: c.log, logErro: c.logErro },
    );
    const texto = c.texto();
    assert.match(texto, /sessão iniciada/);
    assert.match(texto, /semgate não tem gate pré-execução: .*vigilância reativa/);
    assert.match(texto, /modo: /);
  });
});

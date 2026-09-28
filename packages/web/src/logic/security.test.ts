import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AuditEntrySummary, HookStatusSummary, McpStatusSummary } from '@agents-hub/client';
import {
  analisarCamada,
  avisosDePolitica,
  consultaDeAuditoria,
  estadoDoHook,
  estadoDoMcp,
  FILTROS_PADRAO,
  haEdicaoNaoSalva,
  historicoDeAprovacoes,
  podeTrocarDeAba,
  projetoDaSeguranca,
  resumoDaConfianca,
  seguirProjetoCorrente,
  sessaoDoFiltroValida,
  temAvisos,
  textoDaCamada,
  tomDaDecisao,
} from './security.js';

describe('editor de política: forma da camada', () => {
  test('JSON objeto passa; vazio é camada vazia', () => {
    assert.deepEqual(analisarCamada('{"maxDepth": 2}'), { ok: true, camada: { maxDepth: 2 } });
    assert.deepEqual(analisarCamada('   '), { ok: true, camada: {} });
  });

  test('JSON quebrado ou raiz que não é objeto é recusado antes de ir ao daemon', () => {
    const quebrado = analisarCamada('{"maxDepth": ');
    assert.equal(quebrado.ok, false);
    assert.equal(analisarCamada('[1,2]').ok, false);
    assert.equal(analisarCamada('null').ok, false);
    assert.equal(analisarCamada('3').ok, false);
  });

  test('texto da camada: vazio vira {} e ida-e-volta preserva', () => {
    assert.equal(textoDaCamada({}), '{}');
    const c = { risk: { high: 'approve' } };
    assert.deepEqual(analisarCamada(textoDaCamada(c)), { ok: true, camada: c });
  });
});

describe('avisos da prévia/gravação de política', () => {
  test('global: loosened vira "afrouxa"', () => {
    const a = avisosDePolitica({ loosened: ['risk.irreversible'] });
    assert.deepEqual(a.afrouxa, ['risk.irreversible']);
    assert.equal(temAvisos(a), true);
  });

  test('projeto: campo de execução ignorado não aparece duas vezes (também vem no clamped)', () => {
    const a = avisosDePolitica({
      clamped: ['risk.irreversible', 'validation.command'],
      ignoredExecFields: ['validation.command'],
    });
    assert.deepEqual(a.semEfeito, ['risk.irreversible']);
    assert.deepEqual(a.execIgnorados, ['validation.command']);
  });

  test('sem nada: nenhum aviso', () => {
    assert.equal(temAvisos(avisosDePolitica({ loosened: [], clamped: [] })), false);
  });
});

describe('filtros da auditoria', () => {
  test('padrão: últimas 24 h, sem filtros vazios na consulta', () => {
    assert.deepEqual(consultaDeAuditoria(FILTROS_PADRAO), { limit: 200, since: '24h' });
  });

  test('sessão, projeto, tipo e "todo o período"', () => {
    assert.deepEqual(
      consultaDeAuditoria({
        sessionId: ' ses_abc ',
        projectId: 'prj_x',
        kind: 'approval.resolved',
        periodo: '',
        limite: 50,
      }),
      { limit: 50, sessionId: 'ses_abc', projectId: 'prj_x', kind: 'approval.resolved' },
    );
  });

  test('sessão digitada à mão precisa ter forma de id', () => {
    assert.equal(sessaoDoFiltroValida(''), true);
    assert.equal(sessaoDoFiltroValida('ses_abc123'), true);
    assert.equal(sessaoDoFiltroValida('../shutdown'), false);
  });

  test('tom da decisão', () => {
    assert.equal(tomDaDecisao('allow'), 'ok');
    assert.equal(tomDaDecisao('denied'), 'nega');
    assert.equal(tomDaDecisao('approve'), 'pede');
    assert.equal(tomDaDecisao('loosened'), 'pede');
    assert.equal(tomDaDecisao(null), 'neutro');
  });
});

function entrada(p: Partial<AuditEntrySummary>): AuditEntrySummary {
  return {
    id: 'aud_1',
    ts: '2026-09-26T10:00:00.000Z',
    actor: 'gate',
    kind: 'approval.requested',
    sessionId: 'ses_a',
    projectId: 'prj_a',
    approvalId: 'apv_1',
    action: 'Bash: rm -rf build',
    decision: 'approve',
    risk: 'high',
    reason: null,
    detail: {},
    ...p,
  };
}

describe('histórico de aprovações', () => {
  test('junta pedido e resolução, com QUEM resolveu, mais recente primeiro; pendente aparece', () => {
    const h = historicoDeAprovacoes([
      // A auditoria vem do mais recente para o mais antigo.
      entrada({ id: 'aud_4', ts: '2026-09-26T10:09:00.000Z', approvalId: 'apv_2', action: 'git push' }),
      entrada({
        id: 'aud_3',
        ts: '2026-09-26T10:05:00.000Z',
        kind: 'approval.resolved',
        actor: 'web',
        decision: 'denied',
        risk: null,
      }),
      entrada({ id: 'aud_2', ts: '2026-09-26T10:02:00.000Z', kind: 'gate.decision', approvalId: null }),
      entrada({ id: 'aud_1' }),
    ]);
    assert.equal(h.length, 2);
    assert.equal(h[0]!.approvalId, 'apv_2');
    assert.equal(h[0]!.decisao, null, 'pendente');
    assert.equal(h[1]!.approvalId, 'apv_1');
    assert.equal(h[1]!.por, 'web');
    assert.equal(h[1]!.decisao, 'denied');
    assert.equal(h[1]!.risk, 'high', 'risco vem do pedido');
    assert.equal(h[1]!.pedidoPor, 'gate');
    assert.equal(h[1]!.pedidoEm, '2026-09-26T10:00:00.000Z');
  });
});

describe('confiança do projeto', () => {
  const repo = {
    path: 'C:/p/.agents-hub/config.yaml',
    sensitiveFields: [
      'validation.command = npm test',
      'env.claude.ANTHROPIC_BASE_URL = http://evil.example',
      'env.codex.OPENAI_API_KEY',
      'prompts.codex',
      'memory',
    ],
    warning: 'x',
    context: {},
  };

  test('classifica o que o repositório quer mudar', () => {
    const r = resumoDaConfianca({ ...repo, trust: 'untrusted' });
    assert.deepEqual(r.execucao, ['validation.command = npm test']);
    assert.deepEqual(r.rede, ['env.claude.ANTHROPIC_BASE_URL = http://evil.example']);
    assert.deepEqual(r.ambiente, ['env.codex.OPENAI_API_KEY']);
    assert.deepEqual(r.instrucoes, ['prompts.codex', 'memory']);
    assert.equal(r.tom, 'alerta');
    assert.equal(r.rotulo, 'não confiável');
  });

  test('suspensa é alerta com explicação de mudança; confiável é ok; vazio é neutro', () => {
    assert.match(resumoDaConfianca({ ...repo, trust: 'suspended' }).explicacao, /MUDOU/);
    assert.equal(resumoDaConfianca({ ...repo, trust: 'trusted' }).tom, 'ok');
    const vazio = resumoDaConfianca({ ...repo, sensitiveFields: [], trust: 'untrusted' });
    assert.equal(vazio.vazio, true);
    assert.equal(vazio.tom, 'neutro');
  });
});

describe('estado de hook e MCP', () => {
  const hook: HookStatusSummary = {
    modo: 'arquivo',
    arquivo: 'x',
    instalado: true,
    avisoTimeout: null,
    erro: null,
    nota: '',
    comando: null,
    instalavelPeloPainel: true,
  };
  test('hook: ativo, timeout antigo, desligado, só vigilância, ilegível', () => {
    assert.equal(estadoDoHook(hook).texto, 'gate ativo');
    assert.equal(estadoDoHook({ ...hook, avisoTimeout: 'velho' }).tom, 'alerta');
    assert.equal(estadoDoHook({ ...hook, instalado: false }).texto, 'gate desligado');
    assert.equal(estadoDoHook({ ...hook, modo: 'nenhum', instalado: false }).texto, 'só vigilância');
    assert.equal(estadoDoHook({ ...hook, erro: 'x' }).tom, 'erro');
  });
  test('hook fora do arquivo: sessões do Hub continuam gateadas (--settings por sessão)', () => {
    const r = estadoDoHook({ ...hook, instalado: false, sessoesDoHubGateadas: true });
    assert.equal(r.texto, 'gate ativo nas sessões do Hub');
    assert.equal(r.tom, 'ok');
  });
  const mcp: McpStatusSummary = {
    arquivo: 'x',
    precisaDeProjeto: false,
    formato: 'json-mcp-servers',
    verificado: true,
    nota: null,
    registrado: true,
    atualizado: true,
    erro: null,
    comando: '',
  };
  test('mcp: registrado, desatualizado, ausente, precisa de projeto', () => {
    assert.equal(estadoDoMcp(mcp).tom, 'ok');
    assert.equal(estadoDoMcp({ ...mcp, atualizado: false }).texto, 'desatualizado');
    assert.equal(estadoDoMcp({ ...mcp, registrado: false, atualizado: false }).texto, 'não registrado');
    assert.equal(estadoDoMcp({ ...mcp, precisaDeProjeto: true }).texto, 'escolha o projeto');
  });
});

describe('trocar de aba com edição não salva', () => {
  test('sem edição: troca sem perguntar', () => {
    let perguntou = false;
    const ok = podeTrocarDeAba('settings', 'timeline', { settings: false }, () => {
      perguntou = true;
      return false;
    });
    assert.equal(ok, true);
    assert.equal(perguntou, false);
  });

  test('com edição: pergunta, e "não" mantém na aba', () => {
    assert.equal(
      podeTrocarDeAba('settings', 'timeline', { settings: true }, () => false),
      false,
    );
    assert.equal(
      podeTrocarDeAba('settings', 'timeline', { settings: true }, () => true),
      true,
    );
  });

  test('clicar na própria aba não pergunta', () => {
    assert.equal(
      podeTrocarDeAba('settings', 'settings', { settings: true }, () => false),
      true,
    );
  });

  test('qualquer área suja conta', () => {
    assert.equal(haEdicaoNaoSalva({ a: false, b: true }), true);
    assert.equal(haEdicaoNaoSalva({}), false);
  });
});

describe('projeto da aba Segurança acompanha o projeto corrente do painel', () => {
  const projetos = [{ id: 'prj_alfa' }, { id: 'prj_beta' }];

  test('filtro num projeto conhecido: a aba abre nele, não no primeiro da lista', () => {
    assert.equal(projetoDaSeguranca('prj_beta', projetos), 'prj_beta');
  });

  test('"todos os projetos" (ou filtro de projeto que sumiu) cai no primeiro projeto', () => {
    assert.equal(projetoDaSeguranca('all', projetos), 'prj_alfa');
    assert.equal(projetoDaSeguranca('prj_removido', projetos), 'prj_alfa');
  });

  test('sem projeto carregado ainda: só global — e segue quando a lista chega', () => {
    assert.equal(projetoDaSeguranca('prj_beta', []), '');
    assert.equal(projetoDaSeguranca('prj_beta', projetos), 'prj_beta');
  });

  test('formulário limpo segue o novo projeto sem perguntar', () => {
    let perguntou = false;
    const novo = seguirProjetoCorrente({
      atual: 'prj_alfa',
      alvo: 'prj_beta',
      sujo: false,
      confirmar: () => {
        perguntou = true;
        return false;
      },
    });
    assert.equal(novo, 'prj_beta');
    assert.equal(perguntou, false);
  });

  test('edição não salva: pergunta antes, e "não" mantém o projeto da edição', () => {
    const base = { atual: 'prj_alfa', alvo: 'prj_beta', sujo: true };
    assert.equal(seguirProjetoCorrente({ ...base, confirmar: () => false }), 'prj_alfa');
    assert.equal(seguirProjetoCorrente({ ...base, confirmar: () => true }), 'prj_beta');
  });

  test('mesmo projeto: nada a fazer, nem pergunta', () => {
    const novo = seguirProjetoCorrente({
      atual: 'prj_beta',
      alvo: 'prj_beta',
      sujo: true,
      confirmar: () => assert.fail('não deveria perguntar'),
    });
    assert.equal(novo, 'prj_beta');
  });
});

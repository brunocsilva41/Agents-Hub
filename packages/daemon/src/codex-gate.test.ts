import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  modoExigeGate,
  montarConfigDoGate,
  segmentoDeComando,
  TIMEOUT_PADRAO_SEC,
  type AlvoDoGate,
} from './codex-gate.js';

const ALVO: AlvoDoGate = {
  comando: 'node C:\\Users\\x\\.agents-hub\\gate\\codex-hook.mjs',
  timeoutSec: TIMEOUT_PADRAO_SEC,
};

describe('configuração do gate do Codex', () => {
  test('sem bypass de confiança, o gate NÃO é garantido', () => {
    const config = montarConfigDoGate(ALVO, false);
    assert.equal(config.garantido, false);
    // O aviso precisa dizer o que de fato acontece, que é o oposto do intuitivo:
    // hook não confiável não bloqueia, é ignorado, e a ferramenta roda.
    assert.match(String(config.aviso), /IGNORADO EM SIL[ÊE]NCIO/i);
  });

  test('com bypass autorizado, o gate é garantido e a flag entra', () => {
    const config = montarConfigDoGate(ALVO, true);
    assert.equal(config.garantido, true);
    assert.ok(config.args.includes('--dangerously-bypass-hook-trust'));
    assert.equal(config.aviso, undefined);
  });

  test('a config vai em TOML inline, não JSON', () => {
    // Medido: `-c hooks=<json>` devolve "invalid type: string ... expected
    // struct HooksToml". O Codex parseia o valor do -c como TOML.
    const config = montarConfigDoGate(ALVO, true);
    const hooks = config.args[config.args.indexOf('-c') + 1] ?? '';
    assert.match(hooks, /^hooks=\{PreToolUse=\[/);
    assert.ok(!hooks.includes('"PreToolUse":'), 'não pode ser JSON');
  });

  test('caminho do Windows sobrevive ao escape de TOML', () => {
    const config = montarConfigDoGate(ALVO, true);
    const hooks = config.args[config.args.indexOf('-c') + 1] ?? '';
    // Barras invertidas precisam ir duplicadas, senão o TOML lê \U como escape
    // unicode inválido e a config inteira é recusada.
    assert.ok(hooks.includes('C:\\\\Users\\\\x'));
  });

  test('comando vazio não vira gate silencioso', () => {
    const config = montarConfigDoGate({ comando: '   ', timeoutSec: 10 }, true);
    assert.equal(config.garantido, false);
    assert.deepEqual(config.args, []);
  });

  test('segmentoDeComando não embuti aspas em caminho sem espaço', () => {
    assert.equal(segmentoDeComando('C:\\bin\\node.exe'), 'C:\\bin\\node.exe');
  });

  test('segmentoDeComando embuti aspas só quando o caminho resolvido tem espaço', () => {
    // Fora do Windows, ou sem 8.3 disponível, `caminhoCurto` devolve o
    // original — o teste real de que 8.3 elimina o espaço é de integração
    // (só faz sentido contra o volume real) e não roda aqui; o que este
    // teste garante é o contrato: espaço no resultado final SEMPRE vem entre
    // aspas, nunca cru — a causa raiz do achado #4 era exatamente aspas
    // aninhadas demais, não a ausência delas.
    const valor = segmentoDeComando('C:\\um caminho\\sem 8.3 possível\\node.exe');
    if (valor.includes(' ')) {
      assert.ok(valor.startsWith('"') && valor.endsWith('"'));
    }
  });

  test('supervised exige gate; os outros modos não', () => {
    // `supervised` promete que nada passa sem política. Rodar sem gate nesse
    // modo é pior do que não prometer — o usuário baixa a guarda por confiar.
    assert.equal(modoExigeGate('supervised'), true);
    assert.equal(modoExigeGate('semi'), false);
    assert.equal(modoExigeGate('autonomous'), false);
  });
});

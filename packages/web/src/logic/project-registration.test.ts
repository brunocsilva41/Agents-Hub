import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  avisoDeRegistroParcial,
  PROGRESSO_INICIAL,
  registrarProjeto,
  type OperacoesDoRegistro,
} from './project-registration.js';

/** Daemon falso: registra cada chamada; `recusar` diz quais pastas falham. */
function daemonFalso(recusar: Set<string>, falharDiretrizes = { vezes: 0 }) {
  const chamadas: string[] = [];
  let n = 0;
  const ops: OperacoesDoRegistro = {
    criarProjeto: async (caminho, nome) => {
      chamadas.push(`criar ${caminho} ${nome}`);
      n += 1;
      return { id: `prj_${n}` };
    },
    vincularPasta: async (id, pasta) => {
      chamadas.push(`pasta ${id} ${pasta}`);
      if (recusar.has(pasta)) throw new Error('sobrepõe outra pasta');
    },
    gravarDiretrizes: async (id, texto) => {
      chamadas.push(`diretrizes ${id} ${texto}`);
      if (falharDiretrizes.vezes > 0) {
        falharDiretrizes.vezes -= 1;
        throw new Error('disco cheio');
      }
    },
  };
  return { ops, chamadas };
}

const FORM = {
  caminho: 'C:\\p\\app',
  nome: 'app',
  extras: ['C:\\p\\lib', 'C:\\p\\ruim', 'C:\\p\\docs'],
  diretrizes: 'Use TS estrito',
};

describe('registro de projeto retomável (R03-12)', () => {
  test('falha parcial: projeto existe, progresso lembra o que entrou', async () => {
    const { ops } = daemonFalso(new Set(['C:\\p\\ruim']));
    const r = await registrarProjeto(FORM, PROGRESSO_INICIAL, ops);
    assert.equal(r.completo, false);
    assert.equal(r.progresso.projectId, 'prj_1');
    assert.deepEqual(r.progresso.pastasVinculadas, ['C:\\p\\lib', 'C:\\p\\docs']);
    assert.equal(r.progresso.diretrizesGravadas, 'Use TS estrito');
    assert.deepEqual(r.recusadas, [{ pasta: 'C:\\p\\ruim', motivo: 'sobrepõe outra pasta' }]);
    assert.match(avisoDeRegistroParcial(r) ?? '', /Projeto criado, mas 1 pasta/);
  });

  test('tentar de novo NÃO recria o projeto nem reenvia o que já entrou', async () => {
    const recusar = new Set(['C:\\p\\ruim']);
    const { ops, chamadas } = daemonFalso(recusar);
    const primeira = await registrarProjeto(FORM, PROGRESSO_INICIAL, ops);
    chamadas.length = 0;
    recusar.clear(); // o usuário resolveu a sobreposição
    const segunda = await registrarProjeto(FORM, primeira.progresso, ops);
    assert.deepEqual(chamadas, ['pasta prj_1 C:\\p\\ruim']);
    assert.equal(segunda.completo, true);
    assert.equal(avisoDeRegistroParcial(segunda), null);
  });

  test('diretrizes que falharam são regravadas na retomada; as já gravadas não', async () => {
    const { ops, chamadas } = daemonFalso(new Set(), { vezes: 1 });
    const primeira = await registrarProjeto({ ...FORM, extras: [] }, PROGRESSO_INICIAL, ops);
    assert.equal(primeira.completo, false);
    assert.equal(primeira.erroDiretrizes, 'disco cheio');
    assert.match(avisoDeRegistroParcial(primeira) ?? '', /diretrizes não foram gravadas/);
    chamadas.length = 0;
    const segunda = await registrarProjeto({ ...FORM, extras: [] }, primeira.progresso, ops);
    assert.deepEqual(chamadas, ['diretrizes prj_1 Use TS estrito']);
    assert.equal(segunda.completo, true);
    chamadas.length = 0;
    await registrarProjeto({ ...FORM, extras: [] }, segunda.progresso, ops);
    assert.deepEqual(chamadas, [], 'nada a refazer');
  });

  test('falha ao CRIAR sobe como exceção e não deixa progresso', async () => {
    const ops: OperacoesDoRegistro = {
      criarProjeto: async () => {
        throw Object.assign(new Error('path inválido'), { code: 'INVALID_PATH' });
      },
      vincularPasta: async () => assert.fail('não deveria vincular'),
      gravarDiretrizes: async () => assert.fail('não deveria gravar'),
    };
    await assert.rejects(registrarProjeto(FORM, PROGRESSO_INICIAL, ops), /path inválido/);
  });
});

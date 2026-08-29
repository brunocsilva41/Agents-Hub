import path from 'node:path';
import { isInside } from './policy.js';
import type { ProjectFolder } from './domain.js';

/**
 * Regras de composição das pastas de um projeto.
 *
 * O confinamento de acesso do Hub é por diretório: a política limita escrita ao
 * `workdir` da sessão (`isInside(ctx.workdir, alvo)`). Isso só continua
 * significando alguma coisa enquanto as pastas registradas não se sobrepõem.
 *
 * Duas pastas sobrepostas quebram a garantia de formas diferentes, e as duas
 * importam:
 *
 * - **Aninhada dentro de outra**: registrar `/repo` e `/repo/api` faz uma sessão
 *   aberta em `/repo` ter acesso ao conteúdo de `/repo/api` sem nunca tê-la
 *   escolhido. O usuário que separou as duas acreditava tê-las isolado.
 * - **Contendo outra**: registrar `/repo/api` e depois `/repo` tem o mesmo
 *   efeito, só que retroativo — a pasta estreita que já existia deixa de ser
 *   um limite.
 *
 * Por isso o caminho é único globalmente e a sobreposição é recusada em vez de
 * resolvida. Escolher qual das duas "vale" seria decidir, em nome do usuário,
 * qual política se aplica ao arquivo que está no meio.
 */

export type VerdictoDePasta = { ok: true } | { ok: false; motivo: string };

/** Normaliza para comparação: absoluto, sem barra final, sem `..` no meio. */
export function normalizarCaminho(bruto: string): string {
  return path.resolve(bruto.trim());
}

/**
 * A pasta candidata pode ser registrada, dadas as que já existem?
 *
 * `existentes` deve conter as pastas de TODOS os projetos, não só as do projeto
 * alvo: o conflito que interessa é entre diretórios do disco, e ele não respeita
 * a fronteira de projeto.
 */
export function validarNovaPasta(
  caminhoBruto: string,
  existentes: readonly ProjectFolder[],
): VerdictoDePasta {
  const bruto = caminhoBruto.trim();
  if (bruto.length === 0) {
    return { ok: false, motivo: 'caminho vazio' };
  }
  if (!path.isAbsolute(bruto)) {
    return {
      ok: false,
      motivo:
        `"${bruto}" é relativo. O daemon resolve caminho relativo contra o diretório ` +
        'onde ele subiu, que não é o que você tem em mente — informe o caminho completo.',
    };
  }

  const candidata = normalizarCaminho(bruto);

  for (const existente of existentes) {
    const outra = normalizarCaminho(existente.path);

    if (candidata === outra) {
      return {
        ok: false,
        motivo: `esta pasta já pertence ao projeto ${existente.projectId}`,
      };
    }

    if (isInside(outra, candidata)) {
      return {
        ok: false,
        motivo:
          `"${candidata}" está DENTRO de "${outra}", já registrada no projeto ` +
          `${existente.projectId}. Uma sessão aberta na pasta de fora já alcança esta aqui, ` +
          'então registrá-la separadamente prometeria um isolamento que não existiria.',
      };
    }

    if (isInside(candidata, outra)) {
      return {
        ok: false,
        motivo:
          `"${candidata}" CONTÉM "${outra}", já registrada no projeto ${existente.projectId}. ` +
          'Registrá-la faria a pasta menor deixar de ser um limite para as sessões que já a usam.',
      };
    }
  }

  return { ok: true };
}

/**
 * A pasta onde a sessão deve rodar.
 *
 * Sem escolha explícita, usa a principal. Quando nem principal existe — projeto
 * cujas pastas foram todas removidas — devolve `null` em vez de cair em algum
 * padrão: rodar um agente num diretório que ninguém escolheu é exatamente o
 * tipo de suposição que este módulo existe para impedir.
 */
export function resolverPastaDaSessao(
  pastas: readonly ProjectFolder[],
  escolhidaId?: string | undefined,
): ProjectFolder | null {
  if (escolhidaId !== undefined) {
    return pastas.find((f) => f.id === escolhidaId) ?? null;
  }
  return pastas.find((f) => f.isPrimary) ?? pastas[0] ?? null;
}

import type { ValidationOutcome } from '@agents-hub/core';

/**
 * Leitura do veredito da revisão cruzada.
 *
 * Isolado num arquivo próprio porque é o ponto onde a revisão pode fazer
 * estrago: interpretar mal reprova trabalho bom e manda o pipeline reciclar
 * uma tarefa que já estava pronta — caro em dinheiro e em confiança.
 */

/**
 * Fronteira de palavra escrita à mão, sem `\b`.
 *
 * O ponto que importa: `APROVADO` está contido em `REPROVADO`. Uma busca por
 * substring simples leria toda reprovação como aprovação, invertendo o veredito
 * exatamente no caso que mais importa acertar.
 */
const REPROVADO = /(^|[^A-Z])REPROVAD[OA]([^A-Z]|$)/;
const APROVADO = /(^|[^A-Z])APROVAD[OA]([^A-Z]|$)/;

export function interpretarRevisao(resposta: string, revisorId: string): ValidationOutcome {
  const texto = resposta.trim();
  const normalizado = texto.toUpperCase();

  const reprovou = REPROVADO.test(normalizado);
  const aprovou = APROVADO.test(normalizado);

  if (reprovou && !aprovou) {
    return {
      passed: false,
      checks: [{ name: `revisão (${revisorId})`, passed: false, detail: resumir(texto) }],
    };
  }

  // NA DÚVIDA, APROVA. Um revisor que respondeu fora do formato não é evidência
  // de defeito; tratar ambiguidade como reprovação faria o pipeline reciclar
  // trabalho bom, e o usuário desligaria a revisão na primeira vez.
  return {
    passed: true,
    checks: [
      {
        name: `revisão (${revisorId})`,
        passed: true,
        detail: aprovou
          ? resumir(texto)
          : `veredito ambíguo, tratado como aprovação: ${resumir(texto)}`,
      },
    ],
  };
}

function resumir(texto: string): string {
  const limpo = texto.replace(/\s+/g, ' ').trim();
  return limpo.length > 400 ? `${limpo.slice(0, 400)}…` : limpo || 'sem resposta';
}

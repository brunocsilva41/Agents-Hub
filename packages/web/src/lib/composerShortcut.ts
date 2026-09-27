/**
 * Quando a tecla "/" deve levar o foco ao campo de mensagem da sessão.
 *
 * O atalho é global (como em toda ferramenta operacional), e por isso mesmo
 * não pode agir quando há outra coisa na frente: com um modal aberto e o foco
 * num botão dele, o "/" era engolido (`preventDefault`) e o foco ia — ou
 * tentava ir — para o campo escondido atrás do fundo escuro; com a gaveta de
 * fluxos aberta no celular, o foco saltava para trás do fundo da gaveta
 * (vistoria 2026-09-25, 03, BAIXO).
 */
export interface ContextoDoAtalho {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** O foco está num campo de texto/seleção ou num elemento editável. */
  focoEmCampo: boolean;
  /** Há um diálogo modal aberto (paleta, Nova Sessão, confirmação…). */
  dialogoAberto: boolean;
  /** Uma gaveta (fluxos/painel) cobre a timeline. */
  gavetaAberta: boolean;
  /** O campo de mensagem está desabilitado (sessão encerrada, enviando). */
  campoDesabilitado: boolean;
}

export function deveFocarComposer(c: ContextoDoAtalho): boolean {
  if (c.key !== '/' || c.ctrlKey || c.metaKey || c.altKey) return false;
  if (c.focoEmCampo || c.dialogoAberto || c.gavetaAberta || c.campoDesabilitado) return false;
  return true;
}

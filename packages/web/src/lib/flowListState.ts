/**
 * Quais fluxos da lista da esquerda estão abertos.
 *
 * O fluxo da sessão selecionada abre sozinho (é o que se está lendo). Antes a
 * regra era `aberto = expandido || é o selecionado`, e o botão só mexia em
 * `expandido`: clicar no cabeçalho do fluxo selecionado não fazia nada, e ele
 * seguia com `aria-expanded=true` (vistoria 2026-09-25, 03, BAIXO). Agora quem
 * o recolheu à mão fica registrado, e isso vale até ele ser aberto de novo ou
 * outra sessão dele ser escolhida por fora da lista (paleta, DAG, aprovações).
 */

export interface EstadoDaLista {
  /** Abertos à mão. */
  abertos: ReadonlySet<string>;
  /** Recolhidos à mão (vale mesmo para o fluxo selecionado). */
  recolhidos: ReadonlySet<string>;
}

export const LISTA_INICIAL: EstadoDaLista = { abertos: new Set(), recolhidos: new Set() };

export function fluxoAberto(estado: EstadoDaLista, rootId: string, selectedRootId: string | null): boolean {
  if (estado.recolhidos.has(rootId)) return false;
  return estado.abertos.has(rootId) || rootId === selectedRootId;
}

/** Clique no cabeçalho: inverte o que a tela mostra agora. */
export function alternarFluxo(
  estado: EstadoDaLista,
  rootId: string,
  selectedRootId: string | null,
): EstadoDaLista {
  const abertos = new Set(estado.abertos);
  const recolhidos = new Set(estado.recolhidos);
  if (fluxoAberto(estado, rootId, selectedRootId)) {
    abertos.delete(rootId);
    recolhidos.add(rootId);
  } else {
    abertos.add(rootId);
    recolhidos.delete(rootId);
  }
  return { abertos, recolhidos };
}

/**
 * Uma sessão do fluxo foi escolhida: ele volta a abrir sozinho. Mesmo objeto
 * quando nada muda, para não re-renderizar a lista à toa.
 */
export function aoSelecionarFluxo(estado: EstadoDaLista, rootId: string | null): EstadoDaLista {
  if (!rootId || !estado.recolhidos.has(rootId)) return estado;
  const recolhidos = new Set(estado.recolhidos);
  recolhidos.delete(rootId);
  return { abertos: estado.abertos, recolhidos };
}

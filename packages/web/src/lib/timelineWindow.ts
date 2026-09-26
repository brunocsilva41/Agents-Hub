/**
 * Janela de renderização da timeline.
 *
 * Só as últimas `size` linhas vão para o DOM. O auto-scroll dependia do
 * TAMANHO do que era mostrado — que, passada a janela, fica constante: a partir
 * do 401º evento chegavam linhas novas, o tamanho continuava 400 e a tela
 * parava de acompanhar. `followKey` muda a cada evento novo no fim, com ou sem
 * janela cheia, e é nisso que o efeito de rolagem se pendura.
 */

export const TIMELINE_WINDOW = 400;
export const TIMELINE_WINDOW_STEP = 800;

export interface WindowSlice<T> {
  /** Quantas linhas carregadas ficaram acima da janela, fora do DOM. */
  hidden: number;
  shown: T[];
  /**
   * Muda sempre que o FIM da lista muda — e só aí. Página antiga carregada no
   * topo não mexe nela, então não arrasta a tela para baixo.
   */
  followKey: string;
}

export function sliceWindow<T extends { id: string }>(visible: readonly T[], size: number): WindowSlice<T> {
  const hidden = Math.max(0, visible.length - size);
  const shown = hidden > 0 ? visible.slice(hidden) : [...visible];
  const last = visible[visible.length - 1];
  return { hidden, shown, followKey: last?.id ?? '' };
}

/** Distância do topo (px) a partir da qual rolar para cima pede mais. */
export const LOAD_OLDER_THRESHOLD_PX = 80;

/**
 * O que fazer quando a pessoa rola até perto do topo: primeiro revelar o que
 * já está carregado e fora da janela; só quando não há mais nada local, pedir
 * a página anterior ao daemon.
 */
export function olderAction(input: {
  scrollTop: number;
  hidden: number;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
}): 'expand' | 'fetch' | null {
  if (input.scrollTop > LOAD_OLDER_THRESHOLD_PX) return null;
  if (input.hidden > 0) return 'expand';
  if (input.hasMoreBefore && !input.loadingOlder) return 'fetch';
  return null;
}

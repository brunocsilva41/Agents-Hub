/**
 * Quanto tempo cada aviso fica e quantos cabem na tela.
 *
 * Antes só o sucesso sumia sozinho; erro ficava até alguém clicar no ✕, sem
 * limite — dois ou três cobriam o painel direito e o botão Enviar. Erro dura
 * mais que sucesso (é o único registro de que a ação não aconteceu), mas não
 * para sempre; e a fila tem teto, descartando o mais antigo.
 */

export type ToastKind = 'ok' | 'warn' | 'error';

export const MAX_VISIBLE_TOASTS = 3;

export function toastTtlMs(kind: ToastKind): number {
  switch (kind) {
    case 'ok':
      return 4000;
    case 'warn':
      return 8000;
    case 'error':
      return 12000;
  }
}

/** Mantém só os `max` mais recentes (a lista chega em ordem de criação). */
export function capToasts<T>(list: readonly T[], max = MAX_VISIBLE_TOASTS): T[] {
  return list.length > max ? list.slice(list.length - max) : [...list];
}

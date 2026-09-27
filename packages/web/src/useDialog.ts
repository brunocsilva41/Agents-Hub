import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

/**
 * Comportamento comum de diálogo modal: foco inicial, foco preso, Esc fecha,
 * fundo inerte e foco devolvido a quem abriu.
 *
 * Antes cada modal só tinha `role="dialog" aria-modal`: Tab escapava para a
 * topbar por trás do fundo escuro, Esc não fazia nada (só a paleta fechava) e
 * o foco ficava no `<body>` ao abrir. `aria-modal` é uma PROMESSA ao leitor de
 * tela de que o resto da página está inacessível — sem `inert` no fundo ela
 * era falsa.
 *
 * Diálogos empilham (a paleta abre o de Nova Sessão, por exemplo): só o do
 * topo responde a Esc e Tab.
 */
const pilha: symbol[] = [];

/** Há algum diálogo modal aberto agora? (Esc das gavetas cede a ele.) */
export function haDialogoAberto(): boolean {
  return pilha.length > 0;
}

const FOCAVEIS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focaveisEm(raiz: HTMLElement): HTMLElement[] {
  return Array.from(raiz.querySelectorAll<HTMLElement>(FOCAVEIS)).filter(
    (el) => !el.closest('[inert]') && el.getClientRects().length > 0,
  );
}

interface Opcoes {
  /** Quem recebe o foco ao abrir. Sem isto: `[data-autofocus]`, senão o primeiro focável. */
  focoInicial?: RefObject<HTMLElement | null>;
}

export function useDialog(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  opcoes: Opcoes = {},
): void {
  // O `onClose` muda a cada render do pai; o efeito não pode depender dele,
  // senão reabriria (e roubaria o foco) a cada tecla digitada no formulário.
  const fechar = useRef(onClose);
  fechar.current = onClose;
  const focoInicial = opcoes.focoInicial;

  useEffect(() => {
    const dialogo = ref.current;
    if (!dialogo) return;
    const id = Symbol('dialogo');
    pilha.push(id);
    const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Fundo inerte: tudo que é irmão do backdrop. Toasts ficam de fora — um
    // erro precisa continuar dispensável com o modal aberto.
    const camada = dialogo.closest('.modal-backdrop, .cmd-backdrop') ?? dialogo;
    const inertizados: HTMLElement[] = [];
    for (const irmao of Array.from(camada.parentElement?.children ?? [])) {
      if (irmao === camada || !(irmao instanceof HTMLElement)) continue;
      if (irmao.inert || irmao.classList.contains('toasts')) continue;
      irmao.inert = true;
      inertizados.push(irmao);
    }

    const alvo =
      focoInicial?.current ??
      dialogo.querySelector<HTMLElement>('[data-autofocus]') ??
      focaveisEm(dialogo)[0] ??
      dialogo;
    if (alvo === dialogo && !dialogo.hasAttribute('tabindex')) dialogo.tabIndex = -1;
    alvo.focus();

    const onKey = (e: KeyboardEvent): void => {
      if (pilha[pilha.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        fechar.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const lista = focaveisEm(dialogo);
      if (lista.length === 0) {
        e.preventDefault();
        return;
      }
      const primeiro = lista[0]!;
      const ultimo = lista[lista.length - 1]!;
      const ativo = document.activeElement;
      const dentro = ativo instanceof Node && dialogo.contains(ativo);
      if (e.shiftKey && (ativo === primeiro || !dentro)) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && (ativo === ultimo || !dentro)) {
        e.preventDefault();
        primeiro.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      const i = pilha.indexOf(id);
      if (i >= 0) pilha.splice(i, 1);
      for (const el of inertizados) el.inert = false;
      if (anterior && anterior.isConnected) anterior.focus();
    };
  }, [ref, focoInicial]);
}

/**
 * Clique no fundo fecha — mas só um clique que COMEÇOU no fundo, e nunca
 * com o formulário sujo.
 *
 * Arrastar para selecionar texto num campo e soltar fora do cartão disparava
 * `click` no fundo e jogava fora tudo o que foi digitado. Com texto digitado o
 * fundo não fecha: Esc e "Cancelar" continuam lá, e são gestos deliberados.
 */
export function useFecharPeloFundo(
  onClose: () => void,
  sujo = false,
): { onMouseDown: (e: ReactMouseEvent) => void; onClick: (e: ReactMouseEvent) => void } {
  const comecouNoFundo = useRef(false);
  return {
    onMouseDown: (e) => {
      comecouNoFundo.current = e.target === e.currentTarget;
    },
    onClick: (e) => {
      if (e.target !== e.currentTarget || !comecouNoFundo.current || sujo) return;
      onClose();
    },
  };
}

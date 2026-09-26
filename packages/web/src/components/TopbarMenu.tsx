import React, { useEffect, useId, useRef, useState } from 'react';

export interface OpcaoDeAba<T extends string> {
  id: T;
  rotulo: string;
  icone: string;
}

interface Props<T extends string> {
  abas: Array<OpcaoDeAba<T>>;
  ativa: T;
  onEscolher: (id: T) => void;
  tema: 'light' | 'dark';
  onAlternarTema: () => void;
}

/**
 * Menu compacto da topbar (só aparece em telas estreitas, via CSS).
 *
 * Em 375 px as cinco abas, o tema e as ações não cabem numa linha de 52 px:
 * antes elas simplesmente saíam da tela (a topbar tinha `overflow: hidden` e
 * nada rolava) e só "Timeline" ficava clicável. Aqui as abas viram itens de
 * um menu com o padrão de teclado de menu: setas, Home/End, Esc devolve o
 * foco ao botão.
 */
export function TopbarMenu<T extends string>({
  abas,
  ativa,
  onEscolher,
  tema,
  onAlternarTema,
}: Props<T>): React.JSX.Element {
  const [aberto, setAberto] = useState(false);
  const botaoRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const itens = (): HTMLElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

  const fechar = (devolverFoco: boolean): void => {
    setAberto(false);
    if (devolverFoco) botaoRef.current?.focus();
  };

  useEffect(() => {
    if (!aberto) return;
    const atual = itens().find((el) => el.getAttribute('aria-checked') === 'true') ?? itens()[0];
    atual?.focus();
    const foraDoMenu = (e: MouseEvent): void => {
      const alvo = e.target as Node;
      if (!menuRef.current?.contains(alvo) && !botaoRef.current?.contains(alvo)) setAberto(false);
    };
    document.addEventListener('mousedown', foraDoMenu);
    return () => document.removeEventListener('mousedown', foraDoMenu);
  }, [aberto]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const lista = itens();
    const i = lista.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      lista[(i + 1) % lista.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      lista[(i - 1 + lista.length) % lista.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      lista[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      lista[lista.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      fechar(true);
    } else if (e.key === 'Tab') {
      fechar(false);
    }
  };

  const escolher = (acao: () => void): void => {
    // O foco volta ao botão ANTES da ação: se ela abrir um modal, é para cá
    // que o foco retorna quando ele fechar.
    fechar(true);
    acao();
  };

  return (
    <div className="topbar-menu">
      <button
        ref={botaoRef}
        type="button"
        className="drawer-toggle menu-toggle"
        aria-label="Mais opções"
        aria-haspopup="menu"
        aria-expanded={aberto}
        aria-controls={aberto ? menuId : undefined}
        onClick={() => setAberto((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
      {aberto && (
        <div
          ref={menuRef}
          id={menuId}
          className="topbar-menu-popup"
          role="menu"
          aria-label="Seções e preferências"
          onKeyDown={onKeyDown}
        >
          {abas.map((aba) => (
            <button
              key={aba.id}
              type="button"
              role="menuitemradio"
              aria-checked={aba.id === ativa}
              tabIndex={-1}
              className={`topbar-menu-item${aba.id === ativa ? ' ativo' : ''}`}
              onClick={() => escolher(() => onEscolher(aba.id))}
            >
              <span className="tab-icon" aria-hidden="true">
                {aba.icone}
              </span>
              <span>{aba.rotulo}</span>
            </button>
          ))}
          <div className="topbar-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="topbar-menu-item"
            onClick={() => escolher(onAlternarTema)}
          >
            <span className="tab-icon" aria-hidden="true">
              {tema === 'light' ? '☾' : '☀'}
            </span>
            <span>{tema === 'light' ? 'Usar tema escuro' : 'Usar tema claro'}</span>
          </button>
        </div>
      )}
    </div>
  );
}

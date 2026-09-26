import { useCallback, useEffect, useState } from 'react';

/**
 * Tema claro/escuro.
 *
 * Sem escolha salva, o painel segue o sistema (`prefers-color-scheme`) só pelo
 * CSS — nenhum JS precisa rodar para acertar a cor, então não há flash. A
 * escolha explícita vira `data-theme` no `<html>` e fica no `localStorage`,
 * vencendo o sistema até ser trocada de novo.
 */
export type Tema = 'light' | 'dark';

const CHAVE = 'agents-hub:tema';

function lerSalvo(): Tema | null {
  try {
    const v = window.localStorage.getItem(CHAVE);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    // Armazenamento bloqueado (janela privada, política do navegador): segue o sistema.
    return null;
  }
}

function salvar(tema: Tema): void {
  try {
    window.localStorage.setItem(CHAVE, tema);
  } catch {
    // Sem persistência a troca ainda vale para esta aba.
  }
}

function temaDoSistema(): Tema {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Aplica a escolha salva antes do primeiro render (chamado em main.tsx). */
export function aplicarTemaSalvo(): void {
  const salvo = lerSalvo();
  if (salvo) document.documentElement.dataset['theme'] = salvo;
}

export function useTema(): { tema: Tema; alternar: () => void } {
  const [tema, setTema] = useState<Tema>(() => lerSalvo() ?? temaDoSistema());

  // Sem escolha salva, acompanha o sistema mudando com o painel aberto.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!mq) return;
    const onChange = (): void => {
      if (!lerSalvo()) setTema(mq.matches ? 'light' : 'dark');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const alternar = useCallback(() => {
    setTema((atual) => {
      const proximo: Tema = atual === 'light' ? 'dark' : 'light';
      document.documentElement.dataset['theme'] = proximo;
      salvar(proximo);
      return proximo;
    });
  }, []);

  return { tema, alternar };
}

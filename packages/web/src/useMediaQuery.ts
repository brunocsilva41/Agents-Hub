import { useEffect, useState } from 'react';

/**
 * `true` enquanto a media query casa.
 *
 * O CSS decide QUANDO uma coluna vira gaveta; o JS precisa saber disso para
 * marcar a gaveta fechada como `inert` (fora da ordem de Tab e da árvore de
 * acessibilidade). Os valores aqui têm de ser os mesmos dos `@media` do CSS.
 */
export function useMediaQuery(query: string): boolean {
  const [casa, setCasa] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const onChange = (): void => setCasa(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return casa;
}

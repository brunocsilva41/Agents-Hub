import { useCallback, useEffect, useState } from 'react';
import { describeError } from '../../actions';

export type Carga<T> =
  | { estado: 'carregando'; dados: T | null; erro: null }
  | { estado: 'ok'; dados: T; erro: null }
  | { estado: 'erro'; dados: T | null; erro: string };

/**
 * Leitura com os três estados que a tela precisa dizer: carregando, falhou
 * (com o motivo) e carregado. "Falhou" nunca vira "vazio" — são coisas
 * diferentes para quem opera. A resposta de uma chave antiga (trocou a sessão
 * no meio) é descartada, e o dado de uma chave nunca aparece sob outra.
 *
 * `chave` nula = nada a carregar (ex.: nenhuma sessão escolhida). `revisao`
 * muda quando o dado pode ter mudado (a sessão andou): relê sem apagar a tela.
 */
export function useCarga<T>(
  chave: string | null,
  buscar: () => Promise<T>,
  revisao = '',
): Carga<T> & { recarregar: () => void } {
  const [versao, setVersao] = useState(0);
  const [carga, setCarga] = useState<Carga<T> & { chave: string | null }>({
    estado: 'carregando',
    dados: null,
    erro: null,
    chave: null,
  });

  useEffect(() => {
    if (chave === null) return;
    let cancelado = false;
    // Recarregar a MESMA chave mantém o dado na tela; trocar de chave zera.
    setCarga((c) => ({ estado: 'carregando', dados: c.chave === chave ? c.dados : null, erro: null, chave }));
    buscar()
      .then((dados) => {
        if (!cancelado) setCarga({ estado: 'ok', dados, erro: null, chave });
      })
      .catch((err: unknown) => {
        if (cancelado) return;
        const { title, detail } = describeError(err);
        setCarga({ estado: 'erro', dados: null, erro: detail ? `${title} (${detail})` : title, chave });
      });
    return () => {
      cancelado = true;
    };
    // `buscar` muda a cada render; a chave e a versão dizem quando buscar de novo.
  }, [chave, versao, revisao]); // eslint-disable-line react-hooks/exhaustive-deps

  const recarregar = useCallback(() => setVersao((v) => v + 1), []);
  if (carga.chave !== chave) return { estado: 'carregando', dados: null, erro: null, recarregar };
  const { chave: _chave, ...resto } = carga;
  return { ...resto, recarregar };
}

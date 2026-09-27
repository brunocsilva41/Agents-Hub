import { useCallback, useState } from 'react';
import { useAction } from '../../actions';

/**
 * `useAction` (ocupado + erro + toast de erro) com o sucesso também no lugar
 * da ação: a mensagem fica ao lado do botão que a causou, não só num toast
 * que some. `ok` pode ser função do resultado — "3 worktrees recolhidos" diz
 * mais que "feito".
 */
export function useAcao(): {
  ocupado: string | null;
  erro: string | null;
  ok: string | null;
  limpar: () => void;
  executar: <T>(
    rotulo: string,
    fn: () => Promise<T>,
    ok: string | ((r: T) => string),
  ) => Promise<T | undefined>;
} {
  const acao = useAction();
  const [ok, setOk] = useState<string | null>(null);

  const executar = useCallback(
    async <T>(
      rotulo: string,
      fn: () => Promise<T>,
      msg: string | ((r: T) => string),
    ): Promise<T | undefined> => {
      setOk(null);
      let resultado: T | undefined;
      const feito = await acao.run(rotulo, async () => {
        resultado = await fn();
      });
      if (!feito) return undefined;
      setOk(typeof msg === 'function' ? msg(resultado as T) : msg);
      return resultado;
    },
    [acao.run], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return {
    ocupado: acao.busy,
    erro: acao.error,
    ok,
    limpar: () => {
      setOk(null);
      acao.clearError();
    },
    executar,
  };
}

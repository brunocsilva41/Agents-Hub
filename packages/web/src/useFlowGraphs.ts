import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphSummary } from '@agents-hub/client';
import { describeError } from './actions';
import { hub } from './hub';
import {
  raizesParaBuscar,
  resumoDosGrafos,
  type EntradaDoGrafo,
  type ResumoDosGrafos,
} from './lib/flowGraphs';

/** Quantos `/graph` em voo ao mesmo tempo: abrir a aba não vira rajada. */
const EM_PARALELO = 4;

export interface GrafosDosFluxos {
  /** Árvore de cada raiz já carregada (ausente = carregando ou falhou). */
  grafoDe: (rootId: string) => EntradaDoGrafo<GraphSummary> | undefined;
  resumo: ResumoDosGrafos;
  /** Refaz as que falharam. */
  tentarDeNovo: () => void;
}

/**
 * Grafos (custo por sessão) de vários fluxos — DAG e Telemetria.
 *
 * Só busca a raiz cuja revisão subiu (`revisionOf`, a mesma da lista da
 * esquerda) e no máximo `EM_PARALELO` por vez; falha fica na tela até
 * "tentar de novo" (ver `lib/flowGraphs.ts`).
 */
export function useFlowGraphs(
  rootIds: readonly string[],
  revisionOf: (rootId: string) => number,
): GrafosDosFluxos {
  const cacheRef = useRef(new Map<string, EntradaDoGrafo<GraphSummary>>());
  const [versao, setVersao] = useState(0);
  const [rodada, setRodada] = useState(0);
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  const chave = rootIds.map((id) => `${id}:${revisionOf(id)}`).join('|');

  useEffect(() => {
    const cache = cacheRef.current;
    const pedidos = rootIds.map((rootId) => ({ rootId, revisao: revisionOf(rootId) }));
    const fila = raizesParaBuscar(cache, pedidos);
    if (fila.length === 0) return;
    const revisaoDe = new Map(pedidos.map((p) => [p.rootId, p.revisao]));
    for (const rootId of fila) {
      const antiga = cache.get(rootId);
      // Revisão nova de um fluxo já carregado: o dado antigo fica na tela.
      cache.set(rootId, {
        revisao: revisaoDe.get(rootId)!,
        estado: antiga?.estado === 'ok' ? 'ok' : 'carregando',
        nos: antiga?.nos ?? null,
        erro: null,
      });
    }
    setVersao((v) => v + 1);

    const buscarUma = async (rootId: string): Promise<void> => {
      const revisao = revisaoDe.get(rootId)!;
      try {
        const { graph } = await hub.graph(rootId);
        if (cache.get(rootId)?.revisao !== revisao) return;
        cache.set(rootId, { revisao, estado: 'ok', nos: graph, erro: null });
      } catch (err) {
        if (cache.get(rootId)?.revisao !== revisao) return;
        const { title, detail } = describeError(err);
        cache.set(rootId, {
          revisao,
          estado: 'erro',
          nos: null,
          erro: detail ? `${title} (${detail})` : title,
        });
      }
      if (montado.current) setVersao((v) => v + 1);
    };
    const restantes = [...fila];
    const trabalhador = async (): Promise<void> => {
      for (let id = restantes.shift(); id !== undefined; id = restantes.shift()) await buscarUma(id);
    };
    for (let i = 0; i < Math.min(EM_PARALELO, fila.length); i += 1) void trabalhador();
    // `rootIds`/`revisionOf` mudam de identidade a cada render; `chave` diz o
    // que importa, e `rodada` sobe no "tentar de novo".
  }, [chave, rodada]); // eslint-disable-line react-hooks/exhaustive-deps

  const tentarDeNovo = useCallback(() => {
    // Sem a entrada com erro, a próxima passada a busca de novo.
    for (const [id, e] of cacheRef.current) if (e.estado === 'erro') cacheRef.current.delete(id);
    setRodada((n) => n + 1);
  }, []);

  const grafoDe = useCallback((rootId: string) => cacheRef.current.get(rootId), [versao]); // eslint-disable-line react-hooks/exhaustive-deps
  return { grafoDe, resumo: resumoDosGrafos(cacheRef.current, rootIds), tentarDeNovo };
}

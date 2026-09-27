/**
 * Cache dos `/graph/:rootId` de VÁRIOS fluxos (DAG e Telemetria), por revisão.
 *
 * O grafo é a única fonte do custo por sessão, e custa uma requisição por raiz.
 * A lista da esquerda aprendeu isso do jeito difícil (vistoria 04, fan-out de
 * requisições): aqui cada raiz só é buscada de novo quando a SUA revisão sobe
 * (evento estrutural daquele fluxo), e uma falha não é repetida em laço — fica
 * como erro na tela até alguém pedir "tentar de novo".
 */

export type EstadoDoGrafo = 'carregando' | 'ok' | 'erro';

export interface EntradaDoGrafo<N> {
  revisao: number;
  estado: EstadoDoGrafo;
  nos: N[] | null;
  erro: string | null;
}

export interface PedidoDeGrafo {
  rootId: string;
  revisao: number;
}

/**
 * Raízes a buscar agora: sem entrada, ou com entrada de revisão antiga. Erro na
 * MESMA revisão não volta sozinho (sem laço de requisições contra um daemon com
 * problema); em voo também não.
 */
export function raizesParaBuscar(
  cache: ReadonlyMap<string, EntradaDoGrafo<unknown>>,
  pedidos: readonly PedidoDeGrafo[],
): string[] {
  const saida: string[] = [];
  for (const { rootId, revisao } of pedidos) {
    const e = cache.get(rootId);
    if (!e || e.revisao !== revisao) saida.push(rootId);
  }
  return saida;
}

export interface ResumoDosGrafos {
  total: number;
  prontos: number;
  carregando: number;
  falhas: number;
  /** Primeira mensagem de erro, para a tela dizer o motivo. */
  erro: string | null;
}

export function resumoDosGrafos(
  cache: ReadonlyMap<string, EntradaDoGrafo<unknown>>,
  rootIds: readonly string[],
): ResumoDosGrafos {
  let prontos = 0;
  let falhas = 0;
  let erro: string | null = null;
  for (const id of rootIds) {
    const e = cache.get(id);
    if (e?.estado === 'ok') prontos += 1;
    else if (e?.estado === 'erro') {
      falhas += 1;
      erro ??= e.erro;
    }
  }
  return { total: rootIds.length, prontos, falhas, carregando: rootIds.length - prontos - falhas, erro };
}

/** Custo por sessão a partir das árvores prontas (para sobrepor aos nós do DAG). */
export function custoPorSessao<
  N extends { sessionId: string; usd: number; tokens: number; children: N[] },
>(arvores: readonly N[]): Map<string, { usd: number; tokens: number }> {
  const mapa = new Map<string, { usd: number; tokens: number }>();
  const visitar = (no: N): void => {
    if (mapa.has(no.sessionId)) return;
    mapa.set(no.sessionId, { usd: no.usd, tokens: no.tokens });
    for (const f of no.children) visitar(f);
  };
  for (const a of arvores) visitar(a);
  return mapa;
}

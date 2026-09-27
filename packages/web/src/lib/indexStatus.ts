/**
 * Situação do índice do Hub (sessões, agentes, projetos, aprovações) POR
 * RECURSO.
 *
 * Antes a carga era um `Promise.all`: se `/agents` falhasse, nada entrava — e
 * como `ready` virava `true` mesmo assim, toda aba mostrava o seu estado VAZIO
 * ("Nenhum grafo em execução", "0 de 0 agentes", telemetria zerada). Quem
 * operava não distinguia "o Hub não tem nada" de "o Hub não respondeu"
 * (vistoria 2026-09-25, relatório 03, "Estados vazios/erro ausentes ou
 * enganosos"). Aqui cada recurso guarda se já carregou e a última falha, e cada
 * tela pergunta pela situação dos recursos de que depende.
 */

export type Recurso = 'sessions' | 'agents' | 'projects' | 'approvals';

export const ROTULO_RECURSO: Record<Recurso, string> = {
  sessions: 'sessões',
  agents: 'agentes',
  projects: 'projetos',
  approvals: 'aprovações',
};

export interface EstadoDoIndice {
  /** Já veio ao menos uma resposta boa deste recurso (há dado na tela). */
  carregado: Readonly<Record<Recurso, boolean>>;
  /** Falha da ÚLTIMA tentativa, por recurso; ausente = a última deu certo. */
  falhas: Readonly<Partial<Record<Recurso, string>>>;
}

export const INDICE_INICIAL: EstadoDoIndice = {
  carregado: { sessions: false, agents: false, projects: false, approvals: false },
  falhas: {},
};

/** Resultado de uma tentativa: o recurso respondeu, ou a mensagem da falha. */
export type Tentativa = { ok: true } | { ok: false; erro: string };

/** Aplica o desfecho das tentativas feitas agora; recurso não tentado fica como estava. */
export function aplicarTentativas(
  anterior: EstadoDoIndice,
  tentativas: Partial<Record<Recurso, Tentativa>>,
): EstadoDoIndice {
  const carregado = { ...anterior.carregado };
  const falhas: Partial<Record<Recurso, string>> = { ...anterior.falhas };
  for (const [recurso, t] of Object.entries(tentativas) as Array<[Recurso, Tentativa | undefined]>) {
    if (!t) continue;
    if (t.ok) {
      carregado[recurso] = true;
      delete falhas[recurso];
    } else {
      falhas[recurso] = t.erro;
    }
  }
  return { carregado, falhas };
}

export type Situacao = 'carregando' | 'erro' | 'vazio' | 'ok';

/**
 * O que uma tela que depende de `recursos` deve mostrar.
 *
 * - `erro`: algum recurso falhou e NUNCA carregou — não há dado nenhum para
 *   mostrar, e "vazio" seria mentira.
 * - `carregando`: ainda não veio resposta (nem boa nem ruim).
 * - `vazio` / `ok`: há dado; `vazia` diz se a lista que a tela mostra está vazia.
 *
 * Falha de uma RECARGA com dado antigo na tela não é `erro` aqui: a tela
 * continua útil, e o aviso fica no banner global (`resumoDasFalhas`).
 */
export function situacaoDaTela(
  indice: EstadoDoIndice,
  recursos: readonly Recurso[],
  vazia: boolean,
): Situacao {
  if (recursos.some((r) => !indice.carregado[r] && indice.falhas[r] !== undefined)) return 'erro';
  if (recursos.some((r) => !indice.carregado[r])) return 'carregando';
  return vazia ? 'vazio' : 'ok';
}

/** Mensagem da falha dos recursos pedidos (para a tela em `erro`), ou `null`. */
export function falhaDosRecursos(indice: EstadoDoIndice, recursos: readonly Recurso[]): string | null {
  const partes = recursos
    .filter((r) => indice.falhas[r] !== undefined)
    .map((r) => `${ROTULO_RECURSO[r]}: ${indice.falhas[r]}`);
  return partes.length > 0 ? partes.join(' · ') : null;
}

/** Texto do banner global: toda falha atual, com o nome do recurso. */
export function resumoDasFalhas(indice: EstadoDoIndice): string | null {
  return falhaDosRecursos(indice, ['sessions', 'agents', 'projects', 'approvals']);
}

/**
 * `/agents` sonda binários e só é pedido na carga inicial e na reconexão. Uma
 * recarga comum ("tentar de novo") precisa incluí-lo se ele ainda não carregou
 * ou se a última tentativa falhou — senão a falha nunca teria como sumir.
 */
export function incluirAgentes(indice: EstadoDoIndice, pedido: boolean): boolean {
  return pedido || !indice.carregado.agents || indice.falhas.agents !== undefined;
}

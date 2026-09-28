/**
 * Validação do formulário de Nova Sessão / Delegar (SessionModal).
 *
 * Mora fora do componente para ser testável sem DOM. Antes o botão só
 * conferia "tem agente, tem objetivo, tem projeto": um agente ausente vindo
 * pré-selecionado (a paleta abre o modal já com o agente escolhido) passava, e
 * o teto aceitava 0, negativo ou vazio — a sessão nascia sem limite real ou
 * falhava longe da escolha que a causou (vistoria R03-11).
 */
import type { AgentSummary } from '@agents-hub/client';

/** Faixa do teto aceita pelo formulário, em US$ (a mesma do `min`/`max` do campo). */
export const TETO_MINIMO_USD = 0.1;
export const TETO_MAXIMO_USD = 50;

/** Objetivo mais curto que isto não descreve tarefa nenhuma. */
export const OBJETIVO_MINIMO = 6;

/** O agente está de fato nesta máquina? (`probe.installed` vem da sondagem do daemon.) */
export function estaInstalado(a: Pick<AgentSummary, 'probe'>): boolean {
  return a.probe?.installed !== false;
}

export interface EntradaSessao {
  agentId: string;
  agentes: ReadonlyArray<Pick<AgentSummary, 'id' | 'name' | 'probe'>>;
  objetivo: string;
  /** Vazio quando não há projeto escolhido; ignorado ao delegar. */
  projectId: string;
  delegando: boolean;
  /** Texto do campo do teto, como digitado. */
  tetoUsd: string;
}

export interface ErrosSessao {
  agente?: string;
  objetivo?: string;
  projeto?: string;
  teto?: string;
}

/**
 * Converte o texto do teto em número dentro da faixa, ou devolve o motivo da
 * recusa. Aceita vírgula decimal (teclado pt-BR).
 */
export function lerTeto(texto: string): { ok: true; usd: number } | { ok: false; erro: string } {
  const faixa = `entre US$ ${TETO_MINIMO_USD.toFixed(2)} e US$ ${TETO_MAXIMO_USD.toFixed(2)}`;
  const limpo = texto.trim().replace(',', '.');
  if (limpo === '') return { ok: false, erro: `Informe o teto, ${faixa}.` };
  const usd = Number(limpo);
  if (!Number.isFinite(usd)) return { ok: false, erro: `O teto precisa ser um número, ${faixa}.` };
  if (usd < TETO_MINIMO_USD || usd > TETO_MAXIMO_USD) {
    return { ok: false, erro: `O teto precisa ficar ${faixa}.` };
  }
  return { ok: true, usd };
}

/** Erros de cada campo; objeto vazio = pode enviar. */
export function validarSessao(e: EntradaSessao): ErrosSessao {
  const erros: ErrosSessao = {};
  const agente = e.agentes.find((a) => a.id === e.agentId);
  if (!e.agentId || !agente) {
    erros.agente = 'Escolha um agente.';
  } else if (!estaInstalado(agente)) {
    erros.agente = `${agente.name} não está instalado nesta máquina — escolha outro agente.`;
  }
  if (e.objetivo.trim().length < OBJETIVO_MINIMO) {
    erros.objetivo = `Descreva o objetivo (ao menos ${OBJETIVO_MINIMO} caracteres).`;
  }
  if (!e.delegando && !e.projectId) erros.projeto = 'Escolha ou registre um projeto.';
  const teto = lerTeto(e.tetoUsd);
  if (!teto.ok) erros.teto = teto.erro;
  return erros;
}

export function semErros(erros: ErrosSessao): boolean {
  return Object.keys(erros).length === 0;
}

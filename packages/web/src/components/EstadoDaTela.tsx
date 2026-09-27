import type React from 'react';
import type { Situacao } from '../lib/indexStatus';

/**
 * Carregando ou falhou, dito com todas as letras e com a ação que resolve.
 *
 * Usado pelas abas que dependem do índice do Hub (sessões, agentes, projetos):
 * antes, sem resposta, cada uma desenhava o seu estado VAZIO ("Nenhum grafo em
 * execução", "0 de 0 agentes") — mentira quando o Hub só não respondeu. Nada é
 * desenhado em `ok`/`vazio`: aí quem chama mostra o dado ou o seu próprio vazio.
 */
export function EstadoDaTela({
  situacao,
  oQue,
  erro,
  onTentar,
  compacto = false,
}: {
  situacao: Situacao;
  /** "as sessões", "os agentes"… */
  oQue: string;
  erro: string | null;
  onTentar: () => void;
  /** Versão de uma linha (barra lateral, avisos no topo de uma aba). */
  compacto?: boolean;
}): React.JSX.Element | null {
  if (situacao === 'carregando') {
    return (
      <div className={`empty estado-tela${compacto ? ' estado-tela-compacto' : ''}`} role="status">
        <span className="spinner-small" aria-hidden="true" />
        <span className="empty-hint">Carregando {oQue}…</span>
      </div>
    );
  }
  if (situacao === 'erro') {
    return (
      <div
        className={`empty estado-tela estado-tela-erro${compacto ? ' estado-tela-compacto' : ''}`}
        role="alert"
      >
        {!compacto && (
          <div className="empty-icon" aria-hidden="true">
            ⚠️
          </div>
        )}
        <div className="empty-title">Não foi possível carregar {oQue}</div>
        <span className="empty-hint">
          O Hub não respondeu como devia — isto não é uma lista vazia. {erro}
        </span>
        <button type="button" onClick={onTentar}>
          Tentar de novo
        </button>
      </div>
    );
  }
  return null;
}

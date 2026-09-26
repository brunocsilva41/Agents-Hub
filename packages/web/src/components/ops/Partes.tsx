import type React from 'react';

/** Cartão de uma seção da aba Operação: título, descrição curta e ações. */
export function Cartao({
  titulo,
  descricao,
  acoes,
  children,
  id,
}: {
  titulo: string;
  descricao?: React.ReactNode;
  acoes?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}): React.JSX.Element {
  const tituloId = id ? `${id}-titulo` : undefined;
  return (
    <section className="ops-card" aria-labelledby={tituloId}>
      <div className="ops-card-head">
        <div className="ops-card-titles">
          <h3 className="ops-card-title" id={tituloId}>
            {titulo}
          </h3>
          {descricao && <p className="ops-card-desc">{descricao}</p>}
        </div>
        {acoes && <div className="ops-card-actions">{acoes}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * "Carregando…" ou o erro com "tentar de novo". Nada quando já carregou: quem
 * chama mostra o dado (ou o vazio, que é diferente de erro). Uma releitura com
 * o dado anterior ainda na tela também não pisca "carregando".
 */
export function EstadoDaCarga({
  estado,
  erro,
  oQue,
  onTentar,
  temDados = false,
}: {
  estado: 'carregando' | 'ok' | 'erro';
  erro: string | null;
  oQue: string;
  onTentar: () => void;
  temDados?: boolean;
}): React.JSX.Element | null {
  if (estado === 'carregando') {
    if (temDados) return null;
    return (
      <p className="ops-muted" role="status">
        Carregando {oQue}…
      </p>
    );
  }
  if (estado === 'erro') {
    return (
      <div className="notice danger ops-erro" role="alert">
        <span>
          Não foi possível carregar {oQue}: {erro}
        </span>
        <button type="button" onClick={onTentar}>
          Tentar de novo
        </button>
      </div>
    );
  }
  return null;
}

/** Resultado de uma ação: sucesso (status) ou erro (alert), com o texto do daemon. */
export function ResultadoDaAcao({
  ok,
  erro,
}: {
  ok: string | null;
  erro: string | null;
}): React.JSX.Element | null {
  if (erro) {
    return (
      <div className="notice danger ops-erro" role="alert">
        {erro}
      </div>
    );
  }
  if (ok) {
    return (
      <div className="notice ops-ok" role="status">
        {ok}
      </div>
    );
  }
  return null;
}

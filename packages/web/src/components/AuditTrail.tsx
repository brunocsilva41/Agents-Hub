import React, { useCallback, useEffect, useState } from 'react';
import type { AuditEntrySummary, ProjectSummary, SessionSummary } from '@agents-hub/client';
import { describeError } from '../actions';
import { formatAgo, hub, RISK_LABEL } from '../hub';
import {
  consultaDeAuditoria,
  FILTROS_PADRAO,
  PERIODOS,
  rotuloDoTipo,
  sessaoDoFiltroValida,
  TIPOS_DE_AUDITORIA,
  tomDaDecisao,
  type FiltrosDeAuditoria,
} from '../logic/security';

interface Props {
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  /** Projeto escolhido no topo da área (pré-filtro). */
  projectId: string;
}

/**
 * Trilha de auditoria (item 1.10): quem decidiu o quê, quando e por qual
 * regra — decisões do gate, aprovações, mudanças de política, confiança,
 * instalações. `GET /audit` com filtros de sessão, projeto, tipo e período.
 * O `actor` vem da origem autenticada (`web`, `cli:<usuário>`, `gate`), nunca
 * do corpo da requisição.
 */
export function AuditTrail({ projects, sessions, projectId }: Props): React.JSX.Element {
  const [filtros, setFiltros] = useState<FiltrosDeAuditoria>({ ...FILTROS_PADRAO, projectId });
  const [entradas, setEntradas] = useState<AuditEntrySummary[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    setFiltros((f) => ({ ...f, projectId }));
  }, [projectId]);

  const sessaoValida = sessaoDoFiltroValida(filtros.sessionId);

  const buscar = useCallback(async (f: FiltrosDeAuditoria): Promise<void> => {
    setCarregando(true);
    setErro(null);
    try {
      const { entries } = await hub.audit(consultaDeAuditoria(f));
      setEntradas(entries);
    } catch (err) {
      const { title, detail } = describeError(err);
      setErro(detail ? `${title} (${detail})` : title);
    } finally {
      setCarregando(false);
    }
  }, []);

  // Busca de novo a cada filtro (menos a sessão digitada, que espera ser um id).
  useEffect(() => {
    if (!sessaoDoFiltroValida(filtros.sessionId)) return;
    void buscar(filtros);
  }, [filtros, buscar]);

  const mudar = (parcial: Partial<FiltrosDeAuditoria>): void => setFiltros((f) => ({ ...f, ...parcial }));

  const exportar = (): void => {
    if (!entradas) return;
    const blob = new Blob([JSON.stringify(entradas, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auditoria-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const nomeDoProjeto = (id: string | null): string | null =>
    id ? projects.find((p) => p.id === id)?.name ?? id : null;

  return (
    <div className="settings-card">
      <h3 className="card-title">Trilha de auditoria</h3>
      <p className="card-desc">
        Decisões do gate, aprovações, política, confiança e instalações — com quem agiu. Mais
        recente primeiro.
      </p>

      <div className="sec-filtros">
        <label className="sec-filtro">
          <span>Tipo</span>
          <select value={filtros.kind} onChange={(e) => mudar({ kind: e.target.value })}>
            <option value="">todos</option>
            {TIPOS_DE_AUDITORIA.map((t) => (
              <option key={t.id} value={t.id}>
                {t.rotulo}
              </option>
            ))}
          </select>
        </label>
        <label className="sec-filtro">
          <span>Período</span>
          <select value={filtros.periodo} onChange={(e) => mudar({ periodo: e.target.value })}>
            {PERIODOS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.rotulo}
              </option>
            ))}
          </select>
        </label>
        <label className="sec-filtro">
          <span>Projeto</span>
          <select value={filtros.projectId} onChange={(e) => mudar({ projectId: e.target.value })}>
            <option value="">todos</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="sec-filtro">
          <span>Sessão</span>
          <input
            type="text"
            list="sec-sessoes"
            placeholder="ses_…"
            aria-invalid={!sessaoValida}
            value={filtros.sessionId}
            onChange={(e) => mudar({ sessionId: e.target.value })}
          />
          <datalist id="sec-sessoes">
            {sessions.slice(0, 50).map((s) => (
              <option key={s.id} value={s.id}>
                {s.agentId} — {s.title ?? ''}
              </option>
            ))}
          </datalist>
        </label>
      </div>
      {!sessaoValida && <div className="aviso-inline">Id de sessão tem a forma ses_… (letras e números).</div>}

      <div className="sec-acoes sec-acoes-topo">
        <span className="dim" role="status">
          {carregando ? 'carregando…' : entradas ? `${entradas.length} registro(s)` : ''}
        </span>
        <button onClick={() => void buscar(filtros)} disabled={carregando || !sessaoValida}>
          Atualizar
        </button>
        <button onClick={exportar} disabled={!entradas || entradas.length === 0}>
          Exportar JSON
        </button>
      </div>

      {erro && (
        <div className="settings-erro" role="alert">
          Falha ao ler a auditoria: {erro}
        </div>
      )}

      {entradas && entradas.length === 0 && !erro && (
        <div className="settings-vazio">Nada registrado com esses filtros.</div>
      )}

      {entradas && entradas.length > 0 && (
        <ul className="sec-lista" aria-label="Registros de auditoria">
          {entradas.map((e) => (
            <li key={e.id} className="sec-item">
              <div className="sec-item-cab">
                <span className="sec-tipo">{rotuloDoTipo(e.kind)}</span>
                {e.decision && (
                  <span className={`sec-badge tom-${tomDaDecisao(e.decision)}`}>{e.decision}</span>
                )}
                {e.risk && <span className="sec-badge">risco {RISK_LABEL[e.risk] ?? e.risk}</span>}
                <span className="sec-espaco" />
                <time dateTime={e.ts} title={e.ts} className="dim">
                  {formatAgo(e.ts)}
                </time>
              </div>
              <div className="sec-acao">{e.action}</div>
              <div className="sec-meta dim">
                por <strong>{e.actor}</strong>
                {e.sessionId && (
                  <>
                    {' · '}
                    <code>{e.sessionId}</code>
                  </>
                )}
                {nomeDoProjeto(e.projectId) && <> · projeto {nomeDoProjeto(e.projectId)}</>}
              </div>
              {e.reason && <div className="sec-motivo">{e.reason}</div>}
              {Object.keys(e.detail).length > 0 && (
                <details className="sec-detalhe">
                  <summary>detalhes</summary>
                  <pre>{JSON.stringify(e.detail, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

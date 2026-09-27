import React, { useMemo, useState } from 'react';
import type { GraphSummary, ProjectSummary, SessionSummary } from '@agents-hub/client';
import type { FlowSummary } from '../useHubState';
import { agentColor, formatTokens, formatUsdShort } from '../hub';
import type { Situacao } from '../lib/indexStatus';
import {
  custoNoTempo,
  custoPorAgente,
  fluxosDoPeriodo,
  PERIODOS,
  resumoDeSessoes,
  type Periodo,
} from '../lib/telemetry';
import { useFlowGraphs } from '../useFlowGraphs';
import { fluxosDoProjeto } from './DagCanvasView';
import { EstadoDaTela } from './EstadoDaTela';

interface Props {
  sessions: SessionSummary[];
  flows: FlowSummary[];
  projects: ProjectSummary[];
  /** Filtro de projeto, o mesmo da lista da Timeline e do DAG. */
  projectId: string;
  onProjectChange: (id: string) => void;
  revisionOf: (rootId: string) => number;
  situacao: Situacao;
  erro: string | null;
  onRetry: () => void;
}

/**
 * Telemetria: contagens com as definições do resto do painel e custo por
 * agente e no tempo, a partir do que o daemon expõe (`/graph` por fluxo — o
 * único lugar com custo por sessão). Contas em `lib/telemetry.ts`.
 */
export function TelemetryView({
  sessions,
  flows,
  projects,
  projectId,
  onProjectChange,
  revisionOf,
  situacao,
  erro,
  onRetry,
}: Props): React.JSX.Element {
  const [periodo, setPeriodo] = useState<Periodo>('7d');
  // Um "agora" por período escolhido: recalcular a cada render faria a janela
  // andar e as barras pularem.
  const agora = useMemo(() => Date.now(), [periodo, sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const doProjeto = useMemo(() => fluxosDoProjeto(flows, projectId), [flows, projectId]);
  const sessoesDoProjeto = useMemo(
    () => (projectId === 'all' ? sessions : sessions.filter((s) => s.projectId === projectId)),
    [sessions, projectId],
  );
  const resumo = resumoDeSessoes(sessoesDoProjeto, periodo, agora);

  const fluxosComCusto = useMemo(
    () => fluxosDoPeriodo(doProjeto, periodo, agora),
    [doProjeto, periodo, agora],
  );
  const rootIds = useMemo(() => fluxosComCusto.map((f) => f.rootId), [fluxosComCusto]);
  const grafos = useFlowGraphs(situacao === 'ok' ? rootIds : [], revisionOf);
  const nos = useMemo(() => {
    const lista: GraphSummary[] = [];
    for (const id of rootIds) {
      const e = grafos.grafoDe(id);
      if (e?.nos) lista.push(...e.nos);
    }
    return lista;
  }, [rootIds, grafos]);
  const porAgente = custoPorAgente(nos, periodo, agora);
  const faixas = custoNoTempo(nos, periodo, agora);
  const totalUsd = porAgente.reduce((s, a) => s + a.usd, 0);
  const totalTokens = porAgente.reduce((s, a) => s + a.tokens, 0);
  const maiorFaixa = Math.max(0, ...faixas.map((f) => f.usd));
  const custoCompleto = grafos.resumo.prontos === grafos.resumo.total;

  const cabecalho = (
    <div className="telemetry-header">
      <div>
        <h2 className="telemetry-title">Telemetria & Métricas do Hub</h2>
        <p className="telemetry-subtitle">
          Sessões, conclusão e custo por agente. "Ao vivo" é a mesma conta da pílula do topo.
        </p>
      </div>
      <div className="filtro-da-aba">
        <label>
          Projeto
          <select value={projectId} onChange={(e) => onProjectChange(e.target.value)}>
            <option value="all">Todos os projetos ({projects.length})</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Período
          <select value={periodo} onChange={(e) => setPeriodo(e.target.value as Periodo)}>
            {PERIODOS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.rotulo}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );

  if (situacao === 'carregando' || situacao === 'erro') {
    return (
      <div className="telemetry-page">
        {cabecalho}
        <EstadoDaTela situacao={situacao} oQue="as sessões" erro={erro} onTentar={onRetry} />
      </div>
    );
  }

  return (
    <div className="telemetry-page">
      {cabecalho}

      {situacao === 'vazio' && (
        <div className="settings-vazio telemetria-aviso">
          Nenhuma sessão no Hub ainda — as métricas aparecem quando a primeira sessão começar.
        </div>
      )}

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Sessões no período</div>
          <div className="kpi-val highlight-cyan">{resumo.total}</div>
          <div className="kpi-sub">
            {resumo.falharam} falharam · {resumo.encerradas} encerradas
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Ao vivo agora</div>
          <div className="kpi-val highlight-green">{resumo.aoVivo}</div>
          <div className="kpi-sub">rodando, aguardando, pausadas ou ociosas</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Taxa de Conclusão</div>
          <div className="kpi-val highlight-amber">
            {resumo.taxaDeConclusao === null ? '—' : `${Math.round(resumo.taxaDeConclusao * 100)}%`}
          </div>
          <div className="kpi-sub">
            {resumo.concluidas} de {resumo.terminadas}{' '}
            {resumo.terminadas === 1 ? 'terminada' : 'terminadas'}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Custo no período</div>
          <div className="kpi-val highlight-purple">
            {custoCompleto ? formatUsdShort(totalUsd) : '…'}
          </div>
          <div className="kpi-sub">
            {formatTokens(totalTokens)} tokens · {fluxosComCusto.length}{' '}
            {fluxosComCusto.length === 1 ? 'fluxo' : 'fluxos'}
          </div>
        </div>
      </div>

      {grafos.resumo.falhas > 0 && (
        <div className="notice warn telemetria-aviso" role="alert">
          O custo de {grafos.resumo.falhas} de {grafos.resumo.total} fluxo(s) não carregou (
          {grafos.resumo.erro}); os totais abaixo estão incompletos.{' '}
          <button type="button" className="linkish" onClick={grafos.tentarDeNovo}>
            tentar de novo
          </button>
        </div>
      )}
      {grafos.resumo.carregando > 0 && (
        <p className="telemetria-nota" role="status">
          Carregando o custo de {grafos.resumo.carregando} fluxo(s)…
        </p>
      )}

      <div className="telemetry-section">
        <h3 className="section-title">Custo por agente</h3>
        {porAgente.length === 0 ? (
          <div className="settings-vazio">Nenhuma sessão começou neste período.</div>
        ) : (
          <div className="agent-telemetry-table-wrap">
            <table className="telemetry-table">
              <thead>
                <tr>
                  <th>Agente</th>
                  <th>Sessões</th>
                  <th>Custo</th>
                  <th>Tokens</th>
                  <th>Parte do custo</th>
                </tr>
              </thead>
              <tbody>
                {porAgente.map((a) => {
                  const pct = totalUsd > 0 ? ((a.usd / totalUsd) * 100).toFixed(1) : '0';
                  return (
                    <tr key={a.agentId}>
                      <td>
                        <div className="table-agent-cell">
                          <span className="dot" style={{ background: agentColor(a.agentId) }} />
                          <strong>{a.agentId}</strong>
                        </div>
                      </td>
                      <td>{a.sessoes}</td>
                      <td>
                        <code className="mono">{formatUsdShort(a.usd)}</code>
                      </td>
                      <td>{formatTokens(a.tokens)}</td>
                      <td>
                        <div className="pct-bar-wrap">
                          <div
                            className="pct-bar"
                            style={{ width: `${pct}%`, background: agentColor(a.agentId) }}
                          />
                          <span>{pct}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {faixas.length > 0 && (
        <div className="telemetry-section">
          <h3 className="section-title">Custo no tempo</h3>
          <div
            className="telemetria-barras"
            role="img"
            aria-label={`Custo por faixa de tempo, total ${formatUsdShort(totalUsd)}`}
          >
            {faixas.map((f) => (
              <div
                key={f.inicio}
                className={`telemetria-barra${f.usd === 0 ? ' telemetria-barra-vazia' : ''}`}
                style={{
                  height:
                    maiorFaixa > 0 && f.usd > 0
                      ? `${Math.max(2, (f.usd / maiorFaixa) * 100)}%`
                      : undefined,
                }}
                title={`${new Date(f.inicio).toLocaleString('pt-BR')}: ${formatUsdShort(f.usd)} · ${formatTokens(f.tokens)} tokens`}
              />
            ))}
          </div>
          <div className="telemetria-eixo" aria-hidden="true">
            <span>
              {new Date(faixas[0]!.inicio).toLocaleString('pt-BR', {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
            </span>
            <span>agora</span>
          </div>
          <p className="telemetria-nota">
            O daemon guarda o custo acumulado de cada sessão: ele conta na faixa em que a sessão começou.
          </p>
        </div>
      )}
    </div>
  );
}

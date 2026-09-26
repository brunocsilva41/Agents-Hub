import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type { SessionSummary } from '@agents-hub/client';
import { formatDuration, formatTokens, formatUsd, hub, STATE_LABEL } from '../../hub';
import {
  formDoOrcamento,
  lerFormOrcamento,
  motivoDaTarefa,
  raizDe,
  ROTULO_TAREFA,
  separarDiff,
  type FormOrcamento,
} from '../../logic/operacao';
import { Cartao, EstadoDaCarga, ResultadoDaAcao } from './Partes';
import { useAcao } from './useAcao';
import { useCarga } from './useCarga';

interface Props {
  sessions: SessionSummary[];
  sessionId: string | null;
  onEscolher: (id: string) => void;
  onAbrirNaTimeline: (id: string) => void;
}

/** Rótulo de uma sessão no seletor: agente, estado e título. */
function rotulo(s: SessionSummary): string {
  const titulo = s.title ?? s.id;
  return `${s.agentId} · ${STATE_LABEL[s.state] ?? s.state} · ${titulo.length > 60 ? `${titulo.slice(0, 60)}…` : titulo}`;
}

/**
 * O que uma sessão produziu e o que se pode fazer com ela fora da timeline:
 * tarefas, diff, artefatos e o teto do fluxo.
 */
export function SessaoOps({ sessions, sessionId, onEscolher, onAbrirNaTimeline }: Props): React.JSX.Element {
  const ordenadas = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions],
  );
  const sessao = sessions.find((s) => s.id === sessionId) ?? null;

  return (
    <div className="ops-stack">
      <div className="ops-toolbar">
        <label className="ops-field ops-field-grow">
          <span>Sessão</span>
          <select
            value={sessao?.id ?? ''}
            onChange={(e) => onEscolher(e.target.value)}
            disabled={ordenadas.length === 0}
          >
            {ordenadas.length === 0 && <option value="">nenhuma sessão ainda</option>}
            {!sessao && ordenadas.length > 0 && <option value="">escolha uma sessão…</option>}
            {ordenadas.map((s) => (
              <option key={s.id} value={s.id}>
                {rotulo(s)}
              </option>
            ))}
          </select>
        </label>
        {sessao && (
          <button type="button" onClick={() => onAbrirNaTimeline(sessao.id)}>
            Abrir na Timeline
          </button>
        )}
      </div>

      {!sessao ? (
        <p className="ops-muted">
          {ordenadas.length === 0
            ? 'Nenhuma sessão no Hub ainda — crie uma em "Nova Sessão".'
            : 'Escolha uma sessão para ver tarefas, diff, artefatos e orçamento.'}
        </p>
      ) : (
        <>
          {sessao.adopted && (
            <p className="ops-muted">
              Sessão adotada de um agente externo — desanexe em Projeto › Agentes externos.
            </p>
          )}
          <Tarefas sessionId={sessao.id} revisao={sessao.updatedAt} />
          <Diff sessionId={sessao.id} />
          <Artefatos sessionId={sessao.id} revisao={sessao.updatedAt} />
          <Orcamento rootId={raizDe(sessao)} ehRaiz={raizDe(sessao) === sessao.id} revisao={sessao.updatedAt} />
        </>
      )}
    </div>
  );
}

function Tarefas({ sessionId, revisao }: { sessionId: string; revisao: string }): React.JSX.Element {
  const carga = useCarga(sessionId, () => hub.tasks(sessionId).then((r) => r.tasks), revisao);
  const tarefas = carga.dados ?? [];

  return (
    <Cartao
      titulo="Tarefas"
      descricao="O que foi pedido a esta sessão, tentativas e desfecho."
      acoes={
        <button type="button" onClick={carga.recarregar} disabled={carga.estado === 'carregando'}>
          Recarregar
        </button>
      }
    >
      <EstadoDaCarga estado={carga.estado} erro={carga.erro} temDados={carga.dados !== null} oQue="as tarefas" onTentar={carga.recarregar} />
      {carga.estado !== 'erro' && carga.dados && tarefas.length === 0 && (
        <p className="ops-muted">Esta sessão não tem tarefa (sessões adotadas não recebem tarefa do Hub).</p>
      )}
      {tarefas.length > 0 && (
        <ul className="ops-list">
          {tarefas.map((t) => {
            // Reprovação de validação já aparece na lista de checagens logo abaixo.
            const motivo = t.result?.validation && !t.attempts.at(-1)?.error ? null : motivoDaTarefa(t);
            return (
              <li key={t.id} className="ops-item">
                <div className="ops-item-head">
                  <span className={`ops-pill estado-${t.state}`}>{ROTULO_TAREFA[t.state] ?? t.state}</span>
                  <span className="ops-mono" title={t.id}>
                    {t.id}
                  </span>
                  <span className="ops-muted">
                    {t.attempts.length} tentativa{t.attempts.length === 1 ? '' : 's'} · {t.brief.agent}
                  </span>
                </div>
                <p className="ops-item-text">{t.brief.objective}</p>
                {motivo && <p className="ops-item-text ops-danger-text">{motivo}</p>}
                {t.result && (
                  <p className="ops-item-text">
                    {t.result.summary || '(sem resumo)'}{' '}
                    <span className="ops-muted">
                      · {formatUsd(t.result.usage.usd)} · {formatTokens(t.result.usage.tokens)} tokens ·{' '}
                      {formatDuration(t.result.usage.seconds)}
                    </span>
                  </p>
                )}
                {t.result?.validation && (
                  <ul className="ops-checks" aria-label="Validação">
                    {t.result.validation.checks.map((c) => (
                      <li key={c.name} className={c.passed ? 'ok' : 'falhou'}>
                        {c.passed ? '✓' : '✗'} {c.name}
                        {c.detail ? ` — ${c.detail}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Cartao>
  );
}

function Diff({ sessionId }: { sessionId: string }): React.JSX.Element {
  // O diff é o artefato mais pesado: sob pedido, não a cada evento da sessão.
  const [pedido, setPedido] = useState(false);
  useEffect(() => setPedido(false), [sessionId]);
  const carga = useCarga(pedido ? sessionId : null, () => hub.diff(sessionId));
  const arquivos = useMemo(() => (carga.dados?.diff ? separarDiff(carga.dados.diff) : []), [carga.dados]);

  return (
    <Cartao
      titulo="Diff"
      descricao="O que a sessão mudou no código (último diff capturado)."
      acoes={
        <button
          type="button"
          onClick={() => (pedido ? carga.recarregar() : setPedido(true))}
          disabled={pedido && carga.estado === 'carregando'}
        >
          {pedido ? 'Recarregar' : 'Carregar diff'}
        </button>
      }
    >
      {pedido && (
        <EstadoDaCarga estado={carga.estado} erro={carga.erro} temDados={carga.dados !== null} oQue="o diff" onTentar={carga.recarregar} />
      )}
      {pedido && carga.estado === 'ok' && carga.dados.diff === null && (
        <p className="ops-muted">{carga.dados.message ?? 'Sem diff.'}</p>
      )}
      {arquivos.length > 0 && (
        <>
          <p className="ops-muted">
            {arquivos.length} arquivo{arquivos.length === 1 ? '' : 's'} ·{' '}
            <span className="ops-add">+{arquivos.reduce((t, a) => t + a.adicoes, 0)}</span>{' '}
            <span className="ops-del">−{arquivos.reduce((t, a) => t + a.remocoes, 0)}</span>
            {carga.dados?.path && (
              <>
                {' '}
                · <span className="ops-mono">{carga.dados.path}</span>
              </>
            )}
          </p>
          <div className="ops-diff">
            {arquivos.map((a, i) => (
              <details key={`${a.caminho}-${i}`} className="ops-diff-file" open={arquivos.length <= 3}>
                <summary>
                  <span className="ops-mono ops-diff-path">{a.caminho}</span>
                  <span className="ops-add">+{a.adicoes}</span> <span className="ops-del">−{a.remocoes}</span>
                  {a.binario && <span className="ops-muted"> · binário</span>}
                </summary>
                <pre className="ops-diff-body">
                  {a.linhas.map((l, j) => (
                    <span key={j} className={`ops-diff-line ${l.tipo}`}>
                      {l.texto}
                      {'\n'}
                    </span>
                  ))}
                </pre>
              </details>
            ))}
          </div>
        </>
      )}
    </Cartao>
  );
}

const ROTULO_ARTEFATO: Record<string, string> = {
  diff: 'diff',
  file: 'arquivo',
  report: 'relatório',
  log: 'log',
  transcript: 'transcrição',
};

function Artefatos({ sessionId, revisao }: { sessionId: string; revisao: string }): React.JSX.Element {
  const carga = useCarga(sessionId, () => hub.artifacts(sessionId).then((r) => r.artifacts), revisao);
  const [copiado, setCopiado] = useState<string | null>(null);
  const lista = carga.dados ?? [];

  const copiar = (caminho: string): void => {
    void navigator.clipboard?.writeText(caminho).then(
      () => setCopiado(caminho),
      () => setCopiado(null),
    );
  };

  return (
    <Cartao
      titulo="Artefatos"
      descricao="Arquivos que o Hub guardou desta sessão, no disco do daemon."
      acoes={
        <button type="button" onClick={carga.recarregar} disabled={carga.estado === 'carregando'}>
          Recarregar
        </button>
      }
    >
      <EstadoDaCarga estado={carga.estado} erro={carga.erro} temDados={carga.dados !== null} oQue="os artefatos" onTentar={carga.recarregar} />
      {carga.estado !== 'erro' && carga.dados && lista.length === 0 && (
        <p className="ops-muted">Nenhum artefato registrado para esta sessão.</p>
      )}
      {lista.length > 0 && (
        <ul className="ops-list">
          {lista.map((a) => (
            <li key={a.id} className="ops-item ops-item-row">
              <span className="ops-pill">{ROTULO_ARTEFATO[a.kind] ?? a.kind}</span>
              <span className="ops-mono ops-grow" title={a.path}>
                {a.path}
              </span>
              {typeof navigator !== 'undefined' && navigator.clipboard && (
                <button type="button" onClick={() => copiar(a.path)} aria-label={`Copiar caminho de ${a.path}`}>
                  {copiado === a.path ? 'Copiado' : 'Copiar caminho'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Cartao>
  );
}

function Orcamento({ rootId, ehRaiz, revisao }: { rootId: string; ehRaiz: boolean; revisao: string }): React.JSX.Element {
  const carga = useCarga(rootId, () => hub.budget(rootId).then((r) => r.budget), revisao);
  const acao = useAcao();
  const [form, setForm] = useState<FormOrcamento | null>(null);
  const [erroForm, setErroForm] = useState<string | null>(null);

  // Troca de fluxo zera o formulário; recarga do MESMO fluxo não apaga o que se digitava.
  useEffect(() => {
    setForm(null);
    setErroForm(null);
    acao.limpar();
  }, [rootId]); // eslint-disable-line react-hooks/exhaustive-deps

  const budget = carga.dados;
  const valores = form ?? (budget ? formDoOrcamento(budget) : null);

  const salvar = (): void => {
    if (!budget || !valores) return;
    const lido = lerFormOrcamento(valores, budget);
    if (!lido.ok) {
      setErroForm(lido.erro);
      return;
    }
    setErroForm(null);
    void acao
      .executar('teto', () => hub.setBudget(rootId, lido.limits), (r) => `Teto salvo: US$ ${r.budget.limits.usd.toFixed(2)}.`)
      .then((r) => {
        if (!r) return;
        setForm(null);
        carga.recarregar();
      });
  };

  const campo = (chave: keyof FormOrcamento, rotuloCampo: string, dica: string) => (
    <label className="ops-field">
      <span>{rotuloCampo}</span>
      <input
        type="text"
        inputMode="decimal"
        value={valores?.[chave] ?? ''}
        disabled={!valores}
        onChange={(e) => valores && setForm({ ...valores, [chave]: e.target.value })}
        aria-describedby={`dica-${chave}`}
      />
      <small id={`dica-${chave}`} className="ops-muted">
        {dica}
      </small>
    </label>
  );

  return (
    <Cartao
      titulo="Orçamento do fluxo"
      descricao={
        ehRaiz
          ? 'Teto da raiz, que vale para o fluxo inteiro. Salvar exige o token de operador (o painel servido pelo Hub já o tem).'
          : `Esta é uma sub-sessão: o teto é o da raiz ${rootId}, que vale para o fluxo inteiro.`
      }
    >
      <EstadoDaCarga estado={carga.estado} erro={carga.erro} temDados={carga.dados !== null} oQue="o orçamento" onTentar={carga.recarregar} />
      {budget && (
        <>
          <p className="ops-muted">
            Gasto {formatUsd(budget.consumed.usd)} de {formatUsd(budget.limits.usd)} ·{' '}
            {formatTokens(budget.consumed.tokens)} de {formatTokens(budget.limits.tokens)} tokens ·{' '}
            {formatDuration(budget.consumed.seconds)} de {formatDuration(budget.limits.seconds)}
            {budget.reserved.usd > 0 && ` · ${formatUsd(budget.reserved.usd)} reservado a delegações`}
            {budget.exhausted && ' · esgotado'}
          </p>
          <form
            className="ops-form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              salvar();
            }}
          >
            {campo('usd', 'Teto em US$', 'Não pode ficar abaixo do já gasto.')}
            {campo('tokens', 'Teto em tokens', 'Número inteiro.')}
            {campo('minutos', 'Teto de tempo (min)', 'Tempo de execução somado.')}
            <div className="ops-form-actions">
              <button type="submit" className="primary" disabled={acao.ocupado !== null || !valores}>
                {acao.ocupado === 'teto' ? 'Salvando…' : 'Salvar teto'}
              </button>
              {form && (
                <button
                  type="button"
                  onClick={() => {
                    setForm(null);
                    setErroForm(null);
                  }}
                >
                  Descartar
                </button>
              )}
            </div>
          </form>
          {erroForm && (
            <div className="notice danger ops-erro" role="alert">
              {erroForm}
            </div>
          )}
          <ResultadoDaAcao ok={acao.ok} erro={acao.erro} />
        </>
      )}
    </Cartao>
  );
}

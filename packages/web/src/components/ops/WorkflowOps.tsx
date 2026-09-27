import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { ProjectSummary, WorkflowRunSummary, WorkflowValidationSummary } from '@agents-hub/client';
import { formatAgo, formatUsd, hub } from '../../hub';
import {
  execucaoEmCurso,
  lerOrcamentoWorkflow,
  resumoDaExecucao,
  ROTULO_EXECUCAO,
  ROTULO_PASSO,
} from '../../logic/operacao';
import { Cartao, EstadoDaCarga, ResultadoDaAcao } from './Partes';
import { useAcao } from './useAcao';
import { useCarga } from './useCarga';

interface Props {
  projects: ProjectSummary[];
  onAbrirSessao: (id: string) => void;
}

const EXEMPLO = `name: plano-e-execucao
description: planeja e depois executa
steps:
  - id: plano
    agent: claude
    objective: escrever o plano da mudança em PLANO.md
  - id: execucao
    agent: codex
    objective: implementar o que PLANO.md descreve
    dependsOn: [plano]
`;

/** Teto do arquivo lido do disco — o mesmo que o daemon aceita. */
const MAX_BYTES = 200_000;

/**
 * Workflow pelo painel: colar ou abrir o YAML, validar (sintaxe, dependências,
 * ciclos), disparar e acompanhar os passos. Quem conduz o encadeamento é o
 * DAEMON — fechar a aba não interrompe nada.
 */
export function WorkflowOps({ projects, onAbrirSessao }: Props): React.JSX.Element {
  const [yaml, setYaml] = useState('');
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [orcamento, setOrcamento] = useState('');
  const [validacao, setValidacao] = useState<{ texto: string; r: WorkflowValidationSummary } | null>(
    null,
  );
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const acao = useAcao();
  const arquivoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (projectId === '' && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  const runs = useCarga('runs', () => hub.workflowRuns().then((r) => r.runs), String(tick));
  const lista = runs.dados ?? [];
  const selecionada: WorkflowRunSummary | null = lista.find((r) => r.id === runId) ?? lista[0] ?? null;
  const algumaEmCurso = lista.some((r) => execucaoEmCurso(r));

  // Acompanhar: relê enquanto houver execução em curso. Terminadas não mudam.
  useEffect(() => {
    if (!algumaEmCurso) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), 2000);
    return () => window.clearTimeout(t);
  }, [algumaEmCurso, runs.dados]);

  const validacaoAtual = validacao && validacao.texto === yaml ? validacao.r : null;

  const abrirArquivo = (arquivo: File | undefined): void => {
    if (!arquivo) return;
    if (arquivo.size > MAX_BYTES) {
      setErroForm(
        `O arquivo tem ${Math.round(arquivo.size / 1000)} kB; o limite é ${MAX_BYTES / 1000} kB.`,
      );
      return;
    }
    void arquivo.text().then(
      (texto) => {
        setErroForm(null);
        setYaml(texto);
      },
      () => setErroForm('Não foi possível ler o arquivo.'),
    );
  };

  const validar = (): void => {
    setErroForm(null);
    const texto = yaml;
    void acao
      .executar(
        'validar',
        () => hub.validateWorkflow(texto),
        (r) =>
          r.valid
            ? `Válido: ${r.workflow.steps.length} passos em ${r.executionOrder.length} lote(s).`
            : 'O workflow tem erros — veja abaixo.',
      )
      .then((r) => {
        if (r) setValidacao({ texto, r });
      });
  };

  const executar = (): void => {
    const orc = lerOrcamentoWorkflow(orcamento);
    if (!orc.ok) {
      setErroForm(orc.erro);
      return;
    }
    if (!projectId) {
      setErroForm('Escolha o projeto onde os passos vão rodar.');
      return;
    }
    setErroForm(null);
    void acao
      .executar(
        'executar',
        () =>
          hub.startWorkflow({
            yaml,
            projectId,
            ...(orc.usd === undefined ? {} : { budgetUsd: orc.usd }),
          }),
        (r) => `Workflow "${r.run.name}" disparado no Hub.`,
      )
      .then((r) => {
        if (!r) return;
        setRunId(r.run.id);
        setTick((n) => n + 1);
      });
  };

  return (
    <div className="ops-stack">
      <Cartao
        id="wf-editor"
        titulo="Workflow"
        descricao="Cole o YAML ou abra um arquivo. Validar confere sintaxe, dependências e ciclos; executar dispara no Hub, que encadeia os passos mesmo com esta aba fechada."
      >
        <label className="ops-field">
          <span>YAML do workflow</span>
          <textarea
            className="ops-yaml"
            value={yaml}
            spellCheck={false}
            rows={12}
            placeholder={EXEMPLO}
            onChange={(e) => setYaml(e.target.value)}
          />
        </label>
        <div className="ops-form-grid">
          <label className="ops-field">
            <span>Projeto</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={projects.length === 0}
            >
              {projects.length === 0 && <option value="">nenhum projeto registrado</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ops-field">
            <span>Orçamento total (US$)</span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="sem teto global"
              value={orcamento}
              onChange={(e) => setOrcamento(e.target.value)}
            />
          </label>
        </div>
        <div className="ops-form-actions">
          <input
            ref={arquivoRef}
            type="file"
            accept=".yaml,.yml,text/yaml,application/yaml,text/plain"
            hidden
            onChange={(e) => {
              abrirArquivo(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button type="button" onClick={() => arquivoRef.current?.click()}>
            Abrir arquivo…
          </button>
          {yaml === '' && (
            <button type="button" onClick={() => setYaml(EXEMPLO)}>
              Usar exemplo
            </button>
          )}
          <button type="button" onClick={validar} disabled={yaml.trim() === '' || acao.ocupado !== null}>
            {acao.ocupado === 'validar' ? 'Validando…' : 'Validar'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={executar}
            disabled={
              yaml.trim() === '' ||
              projectId === '' ||
              acao.ocupado !== null ||
              validacaoAtual?.valid === false
            }
            title={validacaoAtual?.valid === false ? 'Corrija os erros de validação antes' : undefined}
          >
            {acao.ocupado === 'executar' ? 'Disparando…' : 'Executar'}
          </button>
        </div>
        {erroForm && (
          <div className="notice danger ops-erro" role="alert">
            {erroForm}
          </div>
        )}
        <ResultadoDaAcao ok={acao.ok} erro={acao.erro} />
        {validacaoAtual && !validacaoAtual.valid && (
          <ul className="ops-errors" aria-label="Erros de validação">
            {validacaoAtual.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {validacaoAtual?.valid && (
          <ol className="ops-batches" aria-label="Ordem de execução">
            {validacaoAtual.executionOrder.map((lote, i) => (
              <li key={i}>
                <strong>Lote {i + 1}</strong>
                {lote.length > 1 ? ' (em paralelo)' : ''}: {lote.join(', ')}
              </li>
            ))}
          </ol>
        )}
      </Cartao>

      <Cartao
        id="wf-execucoes"
        titulo="Execuções"
        descricao="Disparadas por aqui ou pela API. O registro vive na memória do Hub: reiniciar o daemon o apaga (as sessões dos passos continuam)."
        acoes={
          <button
            type="button"
            onClick={() => setTick((n) => n + 1)}
            disabled={runs.estado === 'carregando' && !runs.dados}
          >
            Atualizar
          </button>
        }
      >
        <EstadoDaCarga
          estado={runs.estado}
          erro={runs.erro}
          temDados={runs.dados !== null}
          oQue="as execuções"
          onTentar={() => setTick((n) => n + 1)}
        />
        {runs.dados && lista.length === 0 && <p className="ops-muted">Nenhuma execução registrada.</p>}
        {lista.length > 0 && (
          <div className="ops-runs">
            <label className="ops-field">
              <span>Execução</span>
              <select value={selecionada?.id ?? ''} onChange={(e) => setRunId(e.target.value)}>
                {lista.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {ROTULO_EXECUCAO[r.state]} · {formatAgo(r.startedAt)}
                  </option>
                ))}
              </select>
            </label>
            {selecionada && (
              <DetalheExecucao run={selecionada} projects={projects} onAbrirSessao={onAbrirSessao} />
            )}
          </div>
        )}
      </Cartao>
    </div>
  );
}

function DetalheExecucao({
  run,
  projects,
  onAbrirSessao,
}: {
  run: WorkflowRunSummary;
  projects: ProjectSummary[];
  onAbrirSessao: (id: string) => void;
}): React.JSX.Element {
  const projeto = projects.find((p) => p.id === run.projectId);
  return (
    <div className="ops-run" aria-live="polite">
      <p className="ops-muted">
        <span className={`ops-pill run-${run.state}`}>{ROTULO_EXECUCAO[run.state]}</span>{' '}
        {resumoDaExecucao(run)} · {formatUsd(run.totalUsd)}
        {run.budgetUsd !== null && ` de ${formatUsd(run.budgetUsd)}`} · {projeto?.name ?? run.projectId}
        {run.currentBatch !== null && ` · lote ${run.currentBatch + 1}/${run.batches.length}`}
      </p>
      {run.error && (
        <div className="notice danger ops-erro" role="alert">
          {run.error}
        </div>
      )}
      <ul className="ops-list">
        {run.steps.map((s) => (
          <li key={s.stepId} className="ops-item">
            <div className="ops-item-head">
              <span className={`ops-pill passo-${s.state}`}>{ROTULO_PASSO[s.state] ?? s.state}</span>
              <strong className="ops-mono">{s.stepId}</strong>
              <span className="ops-muted">
                {s.agent}
                {s.dependsOn.length > 0 && ` · depois de ${s.dependsOn.join(', ')}`}
                {s.usd > 0 && ` · ${formatUsd(s.usd)}`}
              </span>
              {s.sessionId && (
                <button type="button" className="ops-push" onClick={() => onAbrirSessao(s.sessionId!)}>
                  Ver sessão
                </button>
              )}
            </div>
            {s.detail && <p className="ops-item-text">{s.detail}</p>}
            {s.summary && <p className="ops-item-text">{s.summary}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

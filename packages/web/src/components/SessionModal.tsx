import React, { useEffect, useState } from 'react';
import type { AgentSummary, BriefInput, ProjectSummary } from '@agents-hub/client';
import { useAction } from '../actions';
import { agentColor, hub } from '../hub';

interface Props {
  agents: AgentSummary[];
  delegateFrom: { sessionId: string; agentId: string } | null;
  defaultAgentId?: string;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  onNewProject: () => void;
}

const TASK_TEMPLATES = [
  {
    label: '✨ Nova Feature',
    objective: 'Implementar a funcionalidade: ',
    criteria: '- Código coberto por testes unitários\n- Sem regressões nas rotas existentes',
  },
  {
    label: '🐛 Corrigir Bug',
    objective: 'Investigar e corrigir o bug onde: ',
    criteria: '- Reproduzir com teste antes de alterar\n- Validar com build e testes verdes',
  },
  {
    label: '♻️ Refatoração',
    objective: 'Refatorar o módulo para melhorar legibilidade e modularidade: ',
    criteria: '- Manter compatibilidade com a interface pública\n- Reduzir duplicações',
  },
  {
    label: '🧪 Criar Testes',
    objective: 'Escrever suíte de testes de integração e unidade para: ',
    criteria: '- Cobertura para casos de sucesso e de borda\n- 100% dos testes passando',
  },
];

/**
 * O agente está de fato nesta máquina?
 *
 * `probe.installed` vem da sondagem que o daemon faz contra o binário real. Um
 * agente ausente aceito aqui só falha depois, com erro de binário — longe da
 * escolha que o causou.
 */
function estaInstalado(a: AgentSummary): boolean {
  return a.probe?.installed !== false;
}

export function SessionModal({
  agents,
  delegateFrom,
  defaultAgentId,
  onClose,
  onCreated,
  onNewProject,
}: Props): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [agent, setAgent] = useState(
    // Padrão: o primeiro agente INSTALADO. Abrir o formulário já apontando para
    // um agente ausente é oferecer um caminho que não leva a lugar nenhum.
    defaultAgentId || agents.find(estaInstalado)?.id || agents[0]?.id || '',
  );
  const [objective, setObjective] = useState('');
  const [criteria, setCriteria] = useState('');
  const [budgetUsd, setBudgetUsd] = useState(delegateFrom ? '0.50' : '2.00');
  const [supervision, setSupervision] = useState<'supervised' | 'semi' | 'autonomous'>('semi');
  const [isolation, setIsolation] = useState<'worktree' | 'none'>('worktree');
  const action = useAction();

  useEffect(() => {
    if (delegateFrom) return;
    hub
      .projects()
      .then(({ projects: list }) => {
        setProjects(list);
        setProjectId((current) => current || list[0]?.id || '');
      })
      .catch(() => {});
  }, [delegateFrom]);

  // Instalados primeiro. A ordem alfabética punia quem só queria começar:
  // o primeiro cartão da grade podia ser um agente ausente.
  const agentesOrdenados = [...agents].sort((a, b) => {
    const diff = Number(estaInstalado(b)) - Number(estaInstalado(a));
    return diff !== 0 ? diff : a.name.localeCompare(b.name, 'pt-BR');
  });
  const indisponiveis = agents.filter((a) => !estaInstalado(a));

  const applyTemplate = (tpl: (typeof TASK_TEMPLATES)[0]) => {
    setObjective(tpl.objective);
    setCriteria(tpl.criteria);
  };

  const submit = async () => {
    // O objetivo vai LIMPO, exatamente como você escreveu.
    //
    // Antes, memória e prompts do `localStorage` eram concatenados aqui. Além
    // de não alcançarem a CLI nem as sessões delegadas, isso contaminava o
    // objetivo — que é o que o Hub usa para detectar um agente pedindo de volta
    // o que já pediu. Duas tarefas iguais com diretrizes diferentes passavam a
    // parecer tarefas diferentes, e a detecção deixava passar o que deveria
    // barrar.
    //
    // Agora o daemon anexa o contexto do projeto no prompt, fora do objetivo,
    // em todos os caminhos: sessão nova, delegação, retentativa e substituição.
    const brief: BriefInput = {
      agent,
      objective: objective.trim(),
      acceptanceCriteria: criteria
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
      isolation,
      supervision,
      budget: budgetUsd ? { usd: Number(budgetUsd) } : undefined,
    };

    await action.run(
      'submit',
      async () => {
        if (delegateFrom) {
          const result = await hub.delegate(delegateFrom.sessionId, brief);
          onCreated(result.sessionId);
        } else {
          const result = await hub.startSession({ projectId, brief });
          onCreated(result.session.id);
        }
      },
      delegateFrom ? 'Delegação iniciada.' : 'Sessão iniciada com sucesso.',
    );
  };

  const isValid = agent.length > 0 && objective.trim().length >= 6 && (delegateFrom || projectId);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal wizard-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header-banner">
          <div className="modal-icon-badge">{delegateFrom ? '🔄' : '⚡'}</div>
          <div>
            <h2>{delegateFrom ? `Delegar a partir de ${delegateFrom.agentId}` : 'Iniciar Nova Sessão'}</h2>
            <p className="hint">
              {delegateFrom
                ? 'Transfere uma sub-tarefa para outro agente especialista.'
                : 'Selecione o projeto, agente e defina os objetivos da execução.'}
            </p>
          </div>
        </div>

        {action.error && (
          <div className="error-banner" role="alert">
            {action.error}
          </div>
        )}

        {/* 1. Seleção de Projeto */}
        {!delegateFrom && (
          <div className="field">
            <div className="field-label-row">
              <label htmlFor="modal-project">Projeto & Pasta</label>
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  onClose();
                  onNewProject();
                }}
              >
                + Registrar nova pasta
              </button>
            </div>
            <select
              id="modal-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.length === 0 && <option value="">Nenhum projeto registrado</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.path}
                </option>
              ))}
            </select>
          </div>
        )}

        {/*
          Agente: os instalados primeiro, e os ausentes desabilitados.

          Antes os nove apareciam com o mesmo peso, inclusive os que não estão
          na máquina. Escolher um deles montava a sessão inteira para falhar
          depois, com um erro de binário não encontrado que não tem relação
          aparente com a escolha feita aqui. O dado de instalação já vinha na
          sondagem; só não estava sendo mostrado.
        */}
        <div className="field">
          <div className="field-label-row">
            <label>Agente</label>
            {indisponiveis.length > 0 && (
              <span className="help">
                {indisponiveis.length} não {indisponiveis.length === 1 ? 'está' : 'estão'} nesta
                máquina
              </span>
            )}
          </div>
          <div className="agent-selection-grid">
            {agentesOrdenados.map((a) => {
              const isSelected = agent === a.id;
              const color = agentColor(a.id);
              const disponivel = estaInstalado(a);
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={!disponivel}
                  aria-pressed={isSelected}
                  title={
                    disponivel
                      ? `${a.name} — ${a.vendor}`
                      : `${a.name} não está instalado: ${a.probe?.error ?? 'binário não encontrado'}`
                  }
                  className={`agent-card-select ${isSelected ? 'selected' : ''} ${
                    disponivel ? '' : 'indisponivel'
                  }`}
                  style={{ '--agent-color': color } as React.CSSProperties}
                  onClick={() => setAgent(a.id)}
                >
                  <div className="agent-card-avatar" style={{ background: color }}>
                    {a.id.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="agent-card-meta">
                    <div className="agent-card-name">{a.name}</div>
                    <div className="agent-card-vendor">
                      {disponivel ? a.vendor : 'não instalado'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 3. Templates Rápidos */}
        <div className="template-chips-row">
          <span className="template-label">Templates:</span>
          {TASK_TEMPLATES.map((tpl) => (
            <button
              key={tpl.label}
              type="button"
              className="template-chip-btn"
              onClick={() => applyTemplate(tpl)}
            >
              {tpl.label}
            </button>
          ))}
        </div>

        {/* 4. Objetivo e Critérios */}
        <div className="field">
          <label htmlFor="objective">Objetivo da Tarefa</label>
          <textarea
            id="objective"
            rows={3}
            placeholder="Descreva claramente o que o agente deve realizar..."
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="criteria">Critérios de Aceite (Opcional)</label>
          <textarea
            id="criteria"
            rows={2}
            placeholder="- Um critério por linha (ex: passar em npm test)..."
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
          />
        </div>

        {/* 5. Parâmetros e Orçamento */}
        <div className="field-row">
          <div className="field">
            <label>Supervisão</label>
            <select
              value={supervision}
              onChange={(e) => setSupervision(e.target.value as any)}
            >
              <option value="semi">Semi-Autônomo (Pausa em irreversíveis)</option>
              <option value="supervised">Supervisionado (Aprova todo comando)</option>
              <option value="autonomous">Autônomo (Sem atrito)</option>
            </select>
          </div>

          <div className="field">
            <label>Isolamento</label>
            <select
              value={isolation}
              onChange={(e) => setIsolation(e.target.value as any)}
            >
              <option value="worktree">Git Worktree (Seguro e isolado)</option>
              <option value="none">Direto no diretório principal</option>
            </select>
          </div>

          <div className="field">
            <label>Teto Orçamentário (USD)</label>
            <div className="budget-input-wrap">
              <input
                type="number"
                step="0.50"
                min="0.10"
                max="50.00"
                value={budgetUsd}
                onChange={(e) => setBudgetUsd(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/*
          O interruptor de "incluir memórias" saiu daqui.

          Ele ligava e desligava uma leitura do `localStorage` desta aba. Agora
          a memória do projeto é aplicada pelo daemon em toda sessão dele —
          inclusive nas delegadas, que a aba nunca alcançou —, então o controle
          não teria como desligar coisa alguma. Um interruptor que não desliga
          nada é pior do que nenhum: ele afirma que existe uma escolha.
        */}
        <div className="memory-toggle-row">
          <span className="help">
            As diretrizes deste projeto entram automaticamente. Edite-as em Configurações.
          </span>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={action.busy !== null}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary"
            onClick={submit}
            disabled={!isValid || action.busy !== null}
          >
            {action.busy !== null ? 'Iniciando…' : 'Iniciar Sessão'}
          </button>
        </div>
      </div>
    </div>
  );
}

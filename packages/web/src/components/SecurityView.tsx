import React, { useCallback, useState } from 'react';
import type { AgentSummary, ProjectSummary, SessionSummary } from '@agents-hub/client';
import { ApprovalHistory } from './ApprovalHistory';
import { AuditTrail } from './AuditTrail';
import { IntegrationsPanel } from './IntegrationsPanel';
import { PolicyEditor } from './PolicyEditor';
import { ProjectTrustPanel } from './ProjectTrustPanel';
import '../security.css';

type Secao = 'policy' | 'trust' | 'integrations' | 'approvals' | 'audit';

interface Props {
  agents: AgentSummary[];
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  /** Edição não salva (editor de política): o `App` pergunta antes de trocar de aba. */
  onSujoChange: (sujo: boolean) => void;
  onSelectSession: (id: string) => void;
  onProjectsChanged: () => void;
}

const SECOES: ReadonlyArray<{ id: Secao; icone: string; titulo: string; sub: string }> = [
  { id: 'policy', icone: '📜', titulo: 'Política', sub: 'Global e por projeto' },
  { id: 'trust', icone: '🔏', titulo: 'Confiança do projeto', sub: 'O que o repositório quer mudar' },
  { id: 'integrations', icone: '🪝', titulo: 'Gate e MCP', sub: 'Por agente; instalar com prévia' },
  { id: 'approvals', icone: '✅', titulo: 'Aprovações', sub: 'Resolvidas e por quem' },
  { id: 'audit', icone: '🧾', titulo: 'Auditoria', sub: 'Quem fez o quê, quando' },
];

/**
 * Área "Segurança" do painel (item 6.12 do GOAL, parte B; itens 1.9 e 1.10):
 * o que antes só existia pela CLI — editar política, confiar num repositório,
 * ver e instalar o gate/MCP por agente, histórico de aprovações e a trilha de
 * auditoria. Toda escrita passa pelo token de operador (cookie do painel) e
 * fica auditada no daemon.
 */
export function SecurityView(props: Props): React.JSX.Element {
  const { projects, onSujoChange } = props;
  const [secao, setSecao] = useState<Secao>('policy');
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [sujo, setSujo] = useState(false);

  const marcarSujo = useCallback(
    (v: boolean) => {
      setSujo(v);
      onSujoChange(v);
    },
    [onSujoChange],
  );

  const confirmarDescarte = (): boolean =>
    !sujo || window.confirm('Há alterações não salvas na política. Descartar?');

  const trocarSecao = (nova: Secao): void => {
    if (nova === secao || !confirmarDescarte()) return;
    setSecao(nova);
  };

  const trocarProjeto = (novo: string): void => {
    if (novo === projectId || !confirmarDescarte()) return;
    setProjectId(novo);
  };

  const projeto = projects.find((p) => p.id === projectId);

  return (
    <div className="settings-page sec-page">
      <div className="settings-header">
        <div>
          <h2 className="settings-title">Segurança</h2>
          <p className="settings-subtitle">
            Política, confiança nos repositórios, gate por agente e o registro do que foi decidido.
            Toda alteração daqui fica na auditoria.
          </p>
        </div>
        <div className="settings-header-actions">
          <label className="field-inline">
            <span>Projeto</span>
            <select value={projectId} onChange={(e) => trocarProjeto(e.target.value)}>
              <option value="">nenhum (só global)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="settings-layout sec-layout">
        <nav className="settings-nav" aria-label="Seções de segurança">
          {SECOES.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-btn ${secao === s.id ? 'active' : ''}`}
              aria-current={secao === s.id ? 'page' : undefined}
              onClick={() => trocarSecao(s.id)}
            >
              <span className="nav-icon" aria-hidden="true">
                {s.icone}
              </span>
              <div className="nav-text">
                <strong>{s.titulo}</strong>
                <span>{s.sub}</span>
              </div>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {secao === 'policy' && (
            <PolicyEditor
              projectId={projectId}
              projectName={projeto?.name ?? ''}
              onSujoChange={marcarSujo}
            />
          )}
          {secao === 'trust' && (
            <ProjectTrustPanel project={projeto} onChanged={props.onProjectsChanged} />
          )}
          {secao === 'integrations' && (
            <IntegrationsPanel
              agents={props.agents}
              projectId={projectId}
              projectName={projeto?.name ?? ''}
            />
          )}
          {secao === 'approvals' && (
            <ApprovalHistory
              sessions={props.sessions}
              projectId={projectId}
              onSelectSession={props.onSelectSession}
            />
          )}
          {secao === 'audit' && (
            <AuditTrail projects={projects} sessions={props.sessions} projectId={projectId} />
          )}
        </div>
      </div>
    </div>
  );
}

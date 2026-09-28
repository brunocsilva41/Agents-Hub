import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentSummary, ProjectSummary, SessionSummary } from '@agents-hub/client';
import { ApprovalHistory } from './ApprovalHistory';
import { AuditTrail } from './AuditTrail';
import { IntegrationsPanel } from './IntegrationsPanel';
import { PolicyEditor } from './PolicyEditor';
import { ProjectTrustPanel } from './ProjectTrustPanel';
import { projetoDaSeguranca, seguirProjetoCorrente } from '../logic/security';
import '../security.css';

type Secao = 'policy' | 'trust' | 'integrations' | 'approvals' | 'audit';

interface Props {
  agents: AgentSummary[];
  projects: ProjectSummary[];
  /** Filtro de projeto do painel (`'all'` = todos), o mesmo da Timeline, do DAG e da Telemetria. */
  projectIdCorrente: string;
  onProjectChange: (id: string) => void;
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
  const { projects, onSujoChange, onProjectChange } = props;
  const [secao, setSecao] = useState<Secao>('policy');
  const alvo = projetoDaSeguranca(props.projectIdCorrente, projects);
  const [projectId, setProjectId] = useState<string>(alvo);
  const [sujo, setSujo] = useState(false);

  // Segue o projeto corrente quando ele muda com a aba aberta (lista de
  // projetos que chega depois, projeto recém-cadastrado). Só reage à MUDANÇA
  // do alvo: escolher "nenhum (só global)" aqui não é desfeito no próximo
  // render. Com edição não salva, pergunta antes de descartá-la.
  const alvoAplicado = useRef(alvo);
  useEffect(() => {
    if (alvo === alvoAplicado.current) return;
    alvoAplicado.current = alvo;
    const novo = seguirProjetoCorrente({
      atual: projectId,
      alvo,
      sujo,
      confirmar: () => window.confirm('Há alterações não salvas na política. Descartar?'),
    });
    if (novo === projectId) return;
    setProjectId(novo);
    setSujo(false);
    onSujoChange(false);
  }, [alvo, projectId, sujo, onSujoChange]);

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
    // Projeto escolhido aqui vira o filtro do painel, como no DAG e na
    // Telemetria. "Nenhum (só global)" fica só nesta aba: não é um filtro de
    // fluxos, e virar "todos" traria a aba de volta ao primeiro projeto.
    if (novo !== '') onProjectChange(novo);
  };

  const projeto = projects.find((p) => p.id === projectId);

  return (
    <div className="settings-page sec-page">
      <div className="settings-header">
        <div>
          <h2 className="settings-title">Segurança</h2>
          <p className="settings-subtitle">
            Política, confiança nos repositórios, gate por agente e o registro do que foi decidido. Toda
            alteração daqui fica na auditoria.
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

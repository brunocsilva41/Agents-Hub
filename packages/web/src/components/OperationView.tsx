import { useEffect, useState } from 'react';
import type React from 'react';
import type { AgentSummary, ProjectSummary, SessionSummary } from '@agents-hub/client';
import { ManutencaoOps } from './ops/ManutencaoOps';
import { ProjetoOps } from './ops/ProjetoOps';
import { SaudeOps } from './ops/SaudeOps';
import { SessaoOps } from './ops/SessaoOps';
import { WorkflowOps } from './ops/WorkflowOps';
import './ops/ops.css';

type Secao = 'sessao' | 'workflow' | 'projeto' | 'saude' | 'manutencao';

const SECOES: Array<{ id: Secao; rotulo: string; icone: string }> = [
  { id: 'sessao', rotulo: 'Sessão', icone: '🧾' },
  { id: 'workflow', rotulo: 'Workflow', icone: '🔀' },
  { id: 'projeto', rotulo: 'Projeto', icone: '📁' },
  { id: 'saude', rotulo: 'Saúde', icone: '🩺' },
  { id: 'manutencao', rotulo: 'Manutenção', icone: '🧹' },
];

interface Props {
  sessions: SessionSummary[];
  agents: AgentSummary[];
  projects: ProjectSummary[];
  /** Sessão escolhida na Timeline: a seção "Sessão" começa nela. */
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  /** Vai para a Timeline já na sessão. */
  onOpenSession: (id: string) => void;
  onChanged: () => void;
}

/**
 * Aba Operação (item 6.12, parte A): o que o daemon sabe fazer e o painel não
 * mostrava — diff/artefatos/tarefas da sessão, orçamento editável, workflow,
 * pastas do projeto, adoção, saúde dos agentes e manutenção. Cada controle
 * aqui chama uma rota que existe; o que o daemon não suporta não aparece.
 */
export function OperationView({
  sessions,
  agents,
  projects,
  selectedSessionId,
  onSelectSession,
  onOpenSession,
  onChanged,
}: Props): React.JSX.Element {
  const [secao, setSecao] = useState<Secao>('sessao');
  const [sessaoId, setSessaoId] = useState<string | null>(selectedSessionId);
  useEffect(() => {
    if (selectedSessionId) setSessaoId(selectedSessionId);
  }, [selectedSessionId]);

  return (
    <div className="ops-page">
      <div className="ops-header">
        <h2 className="ops-title">Operação</h2>
        <p className="ops-subtitle">
          Resultado das sessões, workflows, projeto, saúde do Hub e manutenção. As ações que mexem em
          segurança ou disco exigem o token de operador, que o painel servido pelo Hub já recebe.
        </p>
      </div>

      <nav className="ops-subnav" aria-label="Seções de operação">
        {SECOES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={secao === s.id ? 'on' : ''}
            aria-current={secao === s.id ? 'page' : undefined}
            onClick={() => setSecao(s.id)}
          >
            <span aria-hidden="true">{s.icone}</span> {s.rotulo}
          </button>
        ))}
      </nav>

      <div className="ops-body">
        {secao === 'sessao' && (
          <SessaoOps
            sessions={sessions}
            sessionId={sessaoId}
            onEscolher={(id) => {
              setSessaoId(id || null);
              if (id) onSelectSession(id);
            }}
            onAbrirNaTimeline={onOpenSession}
          />
        )}
        {secao === 'workflow' && <WorkflowOps projects={projects} onAbrirSessao={onOpenSession} />}
        {secao === 'projeto' && (
          <ProjetoOps
            projects={projects}
            agents={agents}
            sessions={sessions}
            onAbrirSessao={onOpenSession}
            onChanged={onChanged}
          />
        )}
        {secao === 'saude' && <SaudeOps agents={agents} onChanged={onChanged} />}
        {secao === 'manutencao' && <ManutencaoOps />}
      </div>
    </div>
  );
}

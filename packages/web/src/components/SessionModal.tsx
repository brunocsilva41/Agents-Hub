import { useEffect, useState } from 'react';
import type { AgentSummary, BriefInput, ProjectSummary } from '@agents-hub/client';
import { hub } from '../hub';

interface Props {
  agents: AgentSummary[];
  /** Quando presente, é uma delegação a partir desta sessão. */
  delegateFrom: { sessionId: string; agentId: string } | null;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

/**
 * Abrir sessão ou delegar — o mesmo formulário, porque no domínio é a mesma
 * operação (ADR 04.1): só muda se existe um chamador.
 *
 * O agente é obrigatório e sem padrão: você escolhe o principal a cada vez.
 */
export function SessionModal({ agents, delegateFrom, onClose, onCreated }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [agent, setAgent] = useState('');
  const [objective, setObjective] = useState('');
  const [criteria, setCriteria] = useState('');
  const [budgetUsd, setBudgetUsd] = useState(delegateFrom ? '0.50' : '2.00');
  const [supervision, setSupervision] = useState<'supervised' | 'semi' | 'autonomous'>('semi');
  const [isolation, setIsolation] = useState<'worktree' | 'none'>('worktree');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (delegateFrom) return;
    void hub.projects().then(({ projects: list }) => {
      setProjects(list);
      setProjectId((current) => current || (list[0]?.id ?? ''));
    });
  }, [delegateFrom]);

  const installed = agents.filter((a) => a.probe?.installed === true);
  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);

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

    try {
      if (delegateFrom) {
        const result = await hub.delegate(delegateFrom.sessionId, brief);
        onCreated(result.sessionId);
      } else {
        const result = await hub.startSession({ projectId, brief });
        onCreated(result.session.id);
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const valid = agent.length > 0 && objective.trim().length >= 8 && (delegateFrom || projectId);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{delegateFrom ? 'Delegar tarefa' : 'Nova sessão'}</h2>
        <p className="hint">
          {delegateFrom
            ? `${delegateFrom.agentId} vai pedir isto a outro agente. O orçamento sai do fluxo atual.`
            : 'O agente principal é escolhido a cada sessão — não existe padrão implícito.'}
        </p>

        {error && <div className="error-banner">{error}</div>}

        {!delegateFrom && (
          <div className="field">
            <label htmlFor="project">Projeto</label>
            <select id="project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.length === 0 && <option value="">nenhum projeto registrado</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.path}
                </option>
              ))}
            </select>
            {projects.length === 0 && (
              <div className="help">registre um com: hub project add [caminho]</div>
            )}
          </div>
        )}

        <div className="field">
          <label htmlFor="agent">Agente</label>
          <select id="agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">escolha um agente…</option>
            {installed.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id} — {a.name}
              </option>
            ))}
            {installed.length > 0 && <option disabled>──────────</option>}
            {[...new Set(installed.flatMap((a) => a.capabilities))].sort().map((cap) => (
              <option key={`cap:${cap}`} value={`cap:${cap}`}>
                cap:{cap} — o Hub escolhe
              </option>
            ))}
          </select>
          <div className="help">
            {agents.length - installed.length > 0
              ? `${agents.length - installed.length} agente(s) fora da lista por não estarem instalados`
              : 'todos os agentes conhecidos estão instalados'}
          </div>
        </div>

        <div className="field">
          <label htmlFor="objective">Objetivo</label>
          <textarea
            id="objective"
            rows={4}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Refatore o módulo de pagamentos para separar cálculo de imposto da emissão de nota."
          />
          <div className="help">
            Um objetivo por sessão. O agente começa com contexto limpo: escreva de forma
            autossuficiente.
          </div>
        </div>

        <div className="field">
          <label htmlFor="criteria">Critérios de aceite (um por linha)</label>
          <textarea
            id="criteria"
            rows={3}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder={'os testes existentes continuam passando\nnenhuma migration alterada'}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div className="field">
            <label htmlFor="budget">Teto (US$)</label>
            <input
              id="budget"
              type="number"
              step="0.10"
              min="0"
              value={budgetUsd}
              onChange={(e) => setBudgetUsd(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="supervision">Supervisão</label>
            <select
              id="supervision"
              value={supervision}
              onChange={(e) => setSupervision(e.target.value as typeof supervision)}
            >
              <option value="supervised">supervisionada</option>
              <option value="semi">semi</option>
              <option value="autonomous">autônoma</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="isolation">Isolamento</label>
            <select
              id="isolation"
              value={isolation}
              onChange={(e) => setIsolation(e.target.value as typeof isolation)}
            >
              <option value="worktree">worktree</option>
              <option value="none">nenhum</option>
            </select>
          </div>
        </div>

        <div className="modal-actions">
          <button onClick={onClose} disabled={submitting}>
            Cancelar
          </button>
          <button className="primary" onClick={() => void submit()} disabled={!valid || submitting}>
            {submitting ? 'iniciando…' : delegateFrom ? 'Delegar' : 'Iniciar sessão'}
          </button>
        </div>
      </div>
    </div>
  );
}

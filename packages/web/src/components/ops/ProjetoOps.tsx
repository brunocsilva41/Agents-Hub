import { useEffect, useState } from 'react';
import type React from 'react';
import type { AgentSummary, ProjectSummary, SessionSummary } from '@agents-hub/client';
import { formatAgo, hub, STATE_LABEL } from '../../hub';
import { podeDesanexar } from '../../logic/operacao';
import { Cartao, EstadoDaCarga, ResultadoDaAcao } from './Partes';
import { useAcao } from './useAcao';
import { useCarga } from './useCarga';

interface Props {
  projects: ProjectSummary[];
  agents: AgentSummary[];
  sessions: SessionSummary[];
  onAbrirSessao: (id: string) => void;
  onChanged: () => void;
}

/**
 * Projeto depois de criado: as pastas que o compõem (adicionar/remover) e os
 * agentes externos adotados nele (adotar/desanexar).
 */
export function ProjetoOps({ projects, agents, sessions, onAbrirSessao, onChanged }: Props): React.JSX.Element {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  useEffect(() => {
    if (projectId === '' && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  if (projects.length === 0) {
    return <p className="ops-muted">Nenhum projeto registrado ainda — use "+ Nova Pasta" na Timeline.</p>;
  }
  const projeto = projects.find((p) => p.id === projectId) ?? null;

  return (
    <div className="ops-stack">
      <div className="ops-toolbar">
        <label className="ops-field ops-field-grow">
          <span>Projeto</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.path}
              </option>
            ))}
          </select>
        </label>
      </div>
      {projeto && (
        <>
          <Pastas projectId={projeto.id} />
          <Adocao
            projeto={projeto}
            agents={agents}
            sessions={sessions}
            onAbrirSessao={onAbrirSessao}
            onChanged={onChanged}
          />
        </>
      )}
    </div>
  );
}

function Pastas({ projectId }: { projectId: string }): React.JSX.Element {
  const carga = useCarga(projectId, () => hub.folders(projectId).then((r) => r.folders));
  const acao = useAcao();
  const [caminho, setCaminho] = useState('');
  const [rotulo, setRotulo] = useState('');
  const [remover, setRemover] = useState<string | null>(null);

  useEffect(() => {
    setCaminho('');
    setRotulo('');
    setRemover(null);
    acao.limpar();
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const adicionar = (): void => {
    const p = caminho.trim();
    if (!p) return;
    void acao
      .executar('adicionar', () => hub.addFolder(projectId, p, rotulo.trim() || undefined), (r) => `Pasta adicionada: ${r.folder.path}`)
      .then((r) => {
        if (!r) return;
        setCaminho('');
        setRotulo('');
        carga.recarregar();
      });
  };

  const confirmarRemocao = (folderId: string): void => {
    void acao
      .executar('remover', () => hub.removeFolder(projectId, folderId), 'Pasta removida do projeto (nada foi apagado do disco).')
      .then((r) => {
        setRemover(null);
        if (r) carga.recarregar();
      });
  };

  const pastas = carga.dados ?? [];
  return (
    <Cartao
      id="projeto-pastas"
      titulo="Pastas do projeto"
      descricao="Uma sessão roda em UMA destas pastas — é o que confina onde o agente age. Adicionar e remover exigem o token de operador."
    >
      <EstadoDaCarga estado={carga.estado} erro={carga.erro} temDados={carga.dados !== null} oQue="as pastas" onTentar={carga.recarregar} />
      {pastas.length > 0 && (
        <ul className="ops-list">
          {pastas.map((f) => (
            <li key={f.id} className="ops-item">
              <div className="ops-item-head">
                {f.isPrimary && <span className="ops-pill">principal</span>}
                <span className="ops-mono ops-grow" title={f.path}>
                  {f.path}
                </span>
                {f.label && <span className="ops-muted">{f.label}</span>}
                {!f.isPrimary && remover !== f.id && (
                  <button
                    type="button"
                    className="ops-push"
                    onClick={() => setRemover(f.id)}
                    disabled={acao.ocupado !== null}
                    aria-label={`Remover a pasta ${f.path}`}
                  >
                    Remover
                  </button>
                )}
              </div>
              {remover === f.id && (
                <div className="subform ops-confirm" role="alertdialog" aria-label="Confirmar remover pasta">
                  <span>Tirar esta pasta do projeto? Os arquivos no disco não são tocados.</span>
                  <div className="subform-actions">
                    <button type="button" className="danger" autoFocus onClick={() => confirmarRemocao(f.id)} disabled={acao.ocupado !== null}>
                      {acao.ocupado === 'remover' ? 'Removendo…' : 'Remover pasta'}
                    </button>
                    <button type="button" onClick={() => setRemover(null)}>
                      Manter
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="ops-form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          adicionar();
        }}
      >
        <label className="ops-field">
          <span>Caminho absoluto da pasta</span>
          <input type="text" value={caminho} onChange={(e) => setCaminho(e.target.value)} placeholder="C:\projetos\outra-pasta" />
        </label>
        <label className="ops-field">
          <span>Rótulo (opcional)</span>
          <input type="text" value={rotulo} onChange={(e) => setRotulo(e.target.value)} />
        </label>
        <div className="ops-form-actions">
          <button type="submit" className="primary" disabled={caminho.trim() === '' || acao.ocupado !== null}>
            {acao.ocupado === 'adicionar' ? 'Adicionando…' : 'Adicionar pasta'}
          </button>
        </div>
      </form>
      <ResultadoDaAcao ok={acao.ok} erro={acao.erro} />
    </Cartao>
  );
}

function Adocao({
  projeto,
  agents,
  sessions,
  onAbrirSessao,
  onChanged,
}: {
  projeto: ProjectSummary;
  agents: AgentSummary[];
  sessions: SessionSummary[];
  onAbrirSessao: (id: string) => void;
  onChanged: () => void;
}): React.JSX.Element {
  const acao = useAcao();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [titulo, setTitulo] = useState('');
  const [desanexar, setDesanexar] = useState<string | null>(null);

  useEffect(() => {
    if (agentId === '' && agents[0]) setAgentId(agents[0].id);
  }, [agents, agentId]);

  const adotadas = sessions
    .filter((s) => s.projectId === projeto.id && s.adopted === true)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // `adopted` só vem de daemons com o campo; sem ele não há como saber quem desanexar.
  const daemonInforma = sessions.some((s) => s.adopted !== undefined);

  const adotar = (): void => {
    if (!agentId) return;
    void acao
      .executar(
        'adotar',
        () => hub.adopt({ agentId, projectId: projeto.id, ...(titulo.trim() ? { title: titulo.trim() } : {}) }),
        (r) => `Sessão ${r.session.id} registrada para ${agentId}.`,
      )
      .then((r) => {
        if (!r) return;
        setTitulo('');
        onChanged();
      });
  };

  return (
    <Cartao
      id="projeto-adocao"
      titulo="Agentes externos (adoção)"
      descricao="Um agente rodando fora do Hub (num terminal seu) pode ser registrado como sessão-raiz, para delegar pelo Hub e aparecer no grafo. Normalmente o servidor MCP do Hub faz isso sozinho; aqui é o registro manual."
    >
      <form
        className="ops-form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          adotar();
        }}
      >
        <label className="ops-field">
          <span>Agente</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={agents.length === 0}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
        </label>
        <label className="ops-field">
          <span>Título (opcional)</span>
          <input type="text" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
        </label>
        <div className="ops-form-actions">
          <button type="submit" className="primary" disabled={!agentId || acao.ocupado !== null}>
            {acao.ocupado === 'adotar' ? 'Registrando…' : 'Adotar sessão'}
          </button>
        </div>
      </form>
      <ResultadoDaAcao ok={acao.ok} erro={acao.erro} />

      {!daemonInforma && sessions.length > 0 && (
        <p className="ops-muted">Este daemon não informa quais sessões são adotadas; atualize-o para desanexar por aqui.</p>
      )}
      {daemonInforma && adotadas.length === 0 && <p className="ops-muted">Nenhuma sessão adotada neste projeto.</p>}
      {adotadas.length > 0 && (
        <ul className="ops-list" aria-label="Sessões adotadas">
          {adotadas.map((s) => (
            <li key={s.id} className="ops-item">
              <div className="ops-item-head">
                <span className={`ops-pill estado-${s.state}`}>{STATE_LABEL[s.state] ?? s.state}</span>
                <strong>{s.title ?? s.agentId}</strong>
                <span className="ops-muted">{formatAgo(s.updatedAt)}</span>
                <button type="button" className="ops-push" onClick={() => onAbrirSessao(s.id)}>
                  Ver sessão
                </button>
                {podeDesanexar(s) && desanexar !== s.id && (
                  <button type="button" className="danger" onClick={() => setDesanexar(s.id)} disabled={acao.ocupado !== null}>
                    Desanexar
                  </button>
                )}
              </div>
              {desanexar === s.id && (
                <div className="subform ops-confirm" role="alertdialog" aria-label="Confirmar desanexar">
                  <span>Encerrar esta sessão no Hub? As sub-sessões delegadas continuam.</span>
                  <div className="subform-actions">
                    <button
                      type="button"
                      className="danger"
                      autoFocus
                      disabled={acao.ocupado !== null}
                      onClick={() =>
                        void acao.executar('detach', () => hub.detach(s.id), 'Sessão desanexada.').then((r) => {
                          setDesanexar(null);
                          if (r) onChanged();
                        })
                      }
                    >
                      {acao.ocupado === 'detach' ? 'Desanexando…' : 'Desanexar'}
                    </button>
                    <button type="button" onClick={() => setDesanexar(null)}>
                      Manter
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Cartao>
  );
}

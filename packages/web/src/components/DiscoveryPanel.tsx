import React, { useCallback, useEffect, useState } from 'react';
import type { AgentSummary } from '@agents-hub/client';
import type { AgentDiscovery, AuthState, ImportKind, ImportResult } from '@agents-hub/core';
import { describeError, useAction } from '../actions';
import { agentColor, hub } from '../hub';

/**
 * Agentes detectados: o que cada CLI já tem na máquina.
 *
 * Descobrir é só leitura, e o daemon nunca devolve segredo: credencial aparece
 * como presença/ausência e o env de servidor MCP vem mascarado. Mesmo assim,
 * esta tela só exibe os NOMES das variáveis de env — o valor não é lido, nem
 * mascarado, em lugar nenhum.
 *
 * Importar é escrita, então é sempre em dois tempos: prévia (`dryRun: true`) e
 * só depois aplicar, com confirmação explícita.
 */

interface Props {
  agents: AgentSummary[];
  /** Vazio quando ainda não há projeto: ver e atualizar funcionam; importar não. */
  projectId: string;
  projectName: string;
  /** Primeira execução: leva ao registro de projeto, que é o que destrava importar. */
  onNewProject?: () => void;
}

const AUTH_LABEL: Record<AuthState, string> = {
  present: 'autenticado',
  absent: 'sem credencial',
  unknown: 'auth desconhecida',
};

const KIND_LABEL: Record<ImportKind, { titulo: string; sub: string }> = {
  instructions: {
    titulo: 'Instruções',
    sub: 'CLAUDE.md, AGENTS.md… viram memória do projeto',
  },
  env: {
    titulo: 'Ambiente',
    sub: 'modelo/provedor padrão viram env do projeto',
  },
  mcp: {
    titulo: 'Servidores MCP',
    sub: 'registrados nos agentes de destino',
  },
};

const KINDS: ImportKind[] = ['instructions', 'env', 'mcp'];

export function DiscoveryPanel({
  agents,
  projectId,
  projectName,
  onNewProject,
}: Props): React.JSX.Element {
  const [lista, setLista] = useState<AgentDiscovery[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [atualizando, setAtualizando] = useState<string | null>(null);
  const [importando, setImportando] = useState<string | null>(null);

  const carregar = useCallback(async (): Promise<void> => {
    setCarregando(true);
    setErro(null);
    try {
      const { agents: encontrados } = await hub.discovery();
      setLista(encontrados);
    } catch (err) {
      const { title, detail } = describeError(err);
      setErro(detail ? `${title} (${detail})` : title);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const atualizar = async (agentId: string): Promise<void> => {
    setAtualizando(agentId);
    setErro(null);
    try {
      const novo = (await hub.discoverAgent(agentId, true)).agent;
      setLista((atual) => (atual ?? []).map((d) => (d.agentId === agentId ? novo : d)));
    } catch (err) {
      const { title, detail } = describeError(err);
      setErro(detail ? `${title} (${detail})` : title);
    } finally {
      setAtualizando(null);
    }
  };

  const atualizarTodos = async (): Promise<void> => {
    setAtualizando('*');
    setErro(null);
    try {
      const encontrados = await Promise.all(
        (lista ?? []).map((d) => hub.discoverAgent(d.agentId, true).then((r) => r.agent)),
      );
      setLista(encontrados);
    } catch (err) {
      const { title, detail } = describeError(err);
      setErro(detail ? `${title} (${detail})` : title);
    } finally {
      setAtualizando(null);
    }
  };

  return (
    <div className="settings-card" aria-busy={carregando}>
      <div className="disc-head">
        <div>
          <h3 className="card-title">Agentes detectados</h3>
          <p className="card-desc">
            O que cada CLI já tem instalado e configurado nesta máquina. É só leitura: nenhum valor de
            credencial ou de variável de ambiente é lido ou exibido aqui — só a presença.
          </p>
        </div>
        <button
          className="ghost"
          onClick={() => void atualizarTodos()}
          disabled={carregando || atualizando !== null || (lista?.length ?? 0) === 0}
          title="Relê tudo do disco, ignorando o cache do daemon"
        >
          {atualizando === '*' ? 'atualizando…' : 'Atualizar todos'}
        </button>
      </div>

      {projectId === '' && (
        <div className="help" role="note">
          Ver o que cada CLI tem não depende de projeto. Para <strong>importar</strong> instruções,
          ambiente ou MCP, registre antes a pasta do repositório como projeto.
          {onNewProject && (
            <>
              {' '}
              <button className="linkish" onClick={onNewProject}>
                Registrar projeto
              </button>
            </>
          )}
        </div>
      )}

      {erro !== null && (
        <div className="settings-erro" role="alert">
          {erro}
          <button className="ghost" onClick={() => void carregar()}>
            tentar de novo
          </button>
        </div>
      )}

      {carregando && lista === null && <div className="disc-vazio">Procurando agentes…</div>}

      {!carregando && lista !== null && lista.length === 0 && (
        <div className="settings-vazio">
          Nenhum agente detectado. O daemon não encontrou nenhum CLI conhecido — instale um (por exemplo{' '}
          <code>claude</code> ou <code>codex</code>) e use "Atualizar todos".
        </div>
      )}

      {lista !== null && lista.length > 0 && (
        <ul className="disc-lista">
          {lista.map((d) => (
            <AgentCard
              key={d.agentId}
              d={d}
              agents={agents}
              projectId={projectId}
              projectName={projectName}
              atualizando={atualizando === d.agentId || atualizando === '*'}
              importAberto={importando === d.agentId}
              onAtualizar={() => void atualizar(d.agentId)}
              onToggleImport={() => setImportando((a) => (a === d.agentId ? null : d.agentId))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentCard(props: {
  d: AgentDiscovery;
  agents: AgentSummary[];
  projectId: string;
  projectName: string;
  atualizando: boolean;
  importAberto: boolean;
  onAtualizar: () => void;
  onToggleImport: () => void;
}): React.JSX.Element {
  const { d } = props;
  const cor = agentColor(d.agentId);
  const modelo = [d.defaults.provider, d.defaults.model].filter(Boolean).join(' / ');
  const podeImportar = d.installed && props.projectId !== '';

  return (
    <li className="disc-card" style={{ '--disc-color': cor } as React.CSSProperties}>
      <div className="disc-card-head">
        <span className="chip-dot" style={{ background: cor }} />
        <strong className="disc-nome">{d.agentId}</strong>
        <span className={`disc-badge ${d.installed ? 'ok' : 'off'}`}>
          {d.installed ? 'instalado' : 'não instalado'}
        </span>
        {d.version && <code className="disc-versao">v{d.version}</code>}
        <span
          className={`disc-badge auth-${d.auth.state}`}
          title={
            d.auth.evidence.length > 0
              ? `Evidência:\n${d.auth.evidence.join('\n')}`
              : 'Sem evidência registrada'
          }
        >
          {AUTH_LABEL[d.auth.state]}
        </span>
        <span className="disc-spacer" />
        <button className="ghost" onClick={props.onAtualizar} disabled={props.atualizando}>
          {props.atualizando ? 'atualizando…' : 'Atualizar'}
        </button>
        <button
          className={props.importAberto ? 'primary' : ''}
          onClick={props.onToggleImport}
          disabled={!podeImportar}
          title={
            !d.installed
              ? 'Agente não instalado: nada a importar'
              : props.projectId === ''
                ? 'Crie um projeto primeiro'
                : undefined
          }
        >
          Importar para o projeto
        </button>
      </div>

      <dl className="disc-dl">
        <dt>Binário</dt>
        <dd>{d.binPath ? <code>{d.binPath}</code> : <span className="dim">não encontrado</span>}</dd>
        <dt>Modelo / provedor</dt>
        <dd>
          {modelo ? <code>{modelo}</code> : <span className="dim">não declarado</span>}
          {d.defaults.baseUrl && (
            <>
              {' '}
              em <code>{d.defaults.baseUrl}</code>
            </>
          )}
        </dd>
        <dt>Servidores MCP</dt>
        <dd>
          {d.mcpServers.length === 0 ? (
            <span className="dim">nenhum</span>
          ) : (
            <ul className="disc-sub">
              {d.mcpServers.map((s) => (
                <li key={`${s.source}:${s.name}`}>
                  <strong>{s.name}</strong>
                  <span className="disc-badge neutral">{s.transport}</span>
                  {s.isHub && (
                    <span className="disc-badge neutral" title="É o próprio Hub: não é reimportado">
                      hub
                    </span>
                  )}
                  {s.env && Object.keys(s.env).length > 0 && (
                    <span className="dim" title="Só os nomes; os valores nunca são exibidos">
                      env: {Object.keys(s.env).join(', ')}
                    </span>
                  )}
                  <span className="dim disc-fonte" title={s.source}>
                    {s.source}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Instruções</dt>
        <dd>
          {d.instructionFiles.length === 0 ? (
            <span className="dim">nenhum arquivo</span>
          ) : (
            <ul className="disc-sub">
              {d.instructionFiles.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  <span className="dim">{formatBytes(f.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>

      {d.warnings.length > 0 && (
        <ul className="disc-warnings" role="status">
          {d.warnings.map((w, i) => (
            <li key={i}>⚠️ {w}</li>
          ))}
        </ul>
      )}

      {props.importAberto && (
        <ImportFlow
          key={`${props.projectId}:${d.agentId}`}
          d={d}
          agents={props.agents}
          projectId={props.projectId}
          projectName={props.projectName}
        />
      )}
    </li>
  );
}

function ImportFlow(props: {
  d: AgentDiscovery;
  agents: AgentSummary[];
  projectId: string;
  projectName: string;
}): React.JSX.Element {
  const { d } = props;
  const [kinds, setKinds] = useState<ImportKind[]>(['instructions']);
  const [targets, setTargets] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [includeEnv, setIncludeEnv] = useState(false);
  const [previa, setPrevia] = useState<ImportResult | null>(null);
  const [aplicado, setAplicado] = useState<ImportResult | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const action = useAction();

  const destinos = props.agents.filter((a) => a.id !== d.agentId);
  const usaMcp = kinds.includes('mcp');

  // Qualquer mudança de opção invalida a prévia: aplicar tem que aplicar
  // exatamente o que foi mostrado, não o que estava marcado antes.
  const mudou = (): void => {
    setPrevia(null);
    setAplicado(null);
    setConfirmando(false);
  };

  const alternarKind = (k: ImportKind): void => {
    setKinds((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));
    mudou();
  };
  const alternarTarget = (id: string): void => {
    setTargets((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
    mudou();
  };

  const semDestino = usaMcp && targets.length === 0;
  const pedido = (dryRun: boolean) => ({
    agentId: d.agentId,
    kinds,
    dryRun,
    ...(usaMcp ? { targetAgents: targets } : {}),
    ...(overwrite ? { overwrite: true } : {}),
    ...(includeEnv ? { includeEnv: true } : {}),
  });

  const pre = async (): Promise<void> => {
    setAplicado(null);
    setConfirmando(false);
    const ok = await action.run('previa', async () => {
      setPrevia(await hub.importFromAgent(props.projectId, pedido(true)));
    });
    if (!ok) setPrevia(null);
  };

  const aplicar = async (): Promise<void> => {
    await action.run(
      'aplicar',
      async () => {
        setAplicado(await hub.importFromAgent(props.projectId, pedido(false)));
        setConfirmando(false);
      },
      `importado de ${d.agentId} para ${props.projectName}`,
    );
  };

  const resultado = aplicado ?? previa;

  return (
    <div className="disc-import">
      <h4 className="disc-import-title">
        Importar de <strong>{d.agentId}</strong> para <strong>{props.projectName}</strong>
      </h4>

      <fieldset className="disc-fieldset">
        <legend>O que importar</legend>
        {KINDS.map((k) => (
          <label key={k} className="disc-check">
            <input type="checkbox" checked={kinds.includes(k)} onChange={() => alternarKind(k)} />
            <span>
              <strong>{KIND_LABEL[k].titulo}</strong>
              <span className="dim"> — {KIND_LABEL[k].sub}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {usaMcp && (
        <fieldset className="disc-fieldset">
          <legend>Registrar os servidores MCP em</legend>
          {destinos.length === 0 && <span className="dim">Nenhum outro agente disponível.</span>}
          {destinos.map((a) => (
            <label key={a.id} className="disc-check">
              <input
                type="checkbox"
                checked={targets.includes(a.id)}
                onChange={() => alternarTarget(a.id)}
              />
              <span>{a.name}</span>
            </label>
          ))}
          <label className="disc-check">
            <input
              type="checkbox"
              checked={includeEnv}
              onChange={(e) => {
                setIncludeEnv(e.target.checked);
                mudou();
              }}
            />
            <span>
              Levar também as variáveis de ambiente dos servidores{' '}
              <span className="dim">
                (copiadas direto de um arquivo para o outro; a tela nunca mostra os valores)
              </span>
            </span>
          </label>
          {semDestino && (
            <div className="aviso-inline">Escolha ao menos um agente de destino para o MCP.</div>
          )}
        </fieldset>
      )}

      <label className="disc-check">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(e) => {
            setOverwrite(e.target.checked);
            mudou();
          }}
        />
        <span>
          Sobrescrever o que já existe no destino{' '}
          <span className="dim">(desmarcado, o que já existe é pulado)</span>
        </span>
      </label>

      {action.error !== null && (
        <div className="settings-erro" role="alert">
          {action.error}
          <button className="ghost" onClick={action.clearError}>
            dispensar
          </button>
        </div>
      )}

      <div className="disc-import-actions">
        <button
          onClick={() => void pre()}
          disabled={kinds.length === 0 || semDestino || action.busy !== null}
        >
          {action.busy === 'previa' ? 'gerando prévia…' : 'Pré-visualizar'}
        </button>
        {previa !== null && aplicado === null && !confirmando && (
          <button
            className="primary"
            onClick={() => setConfirmando(true)}
            disabled={previa.items.length === 0 || action.busy !== null}
            title={previa.items.length === 0 ? 'A prévia não tem nada a aplicar' : undefined}
          >
            Aplicar…
          </button>
        )}
      </div>

      {resultado !== null && <ResultadoImport r={resultado} />}

      {confirmando && previa !== null && aplicado === null && (
        <div className="disc-confirm" role="alertdialog" aria-label="Confirmar aplicação">
          <p>
            Isto <strong>grava</strong> {previa.items.length} alteração(ões) em{' '}
            <strong>{props.projectName}</strong> e nos destinos listados acima. A prévia não escreveu
            nada; aplicar escreve.
          </p>
          <div className="disc-import-actions">
            <button onClick={() => setConfirmando(false)} disabled={action.busy !== null}>
              Cancelar
            </button>
            <button className="danger" onClick={() => void aplicar()} disabled={action.busy !== null}>
              {action.busy === 'aplicar' ? 'aplicando…' : 'Confirmar e aplicar'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultadoImport({ r }: { r: ImportResult }): React.JSX.Element {
  return (
    <div className="disc-resultado" aria-live="polite">
      <div className="disc-resultado-title">{r.dryRun ? 'Prévia — nada foi gravado' : 'Aplicado'}</div>
      {r.items.length === 0 && <div className="dim">Nenhum item a importar.</div>}
      {r.items.length > 0 && (
        <ul className="disc-itens">
          {r.items.map((it, i) => (
            <li key={i}>
              <span className="disc-badge neutral">{KIND_LABEL[it.kind].titulo}</span>
              <span>{it.description}</span>
              <span className="dim">
                → <code>{it.target}</code>
              </span>
              {!r.dryRun && (
                <span className={`disc-badge ${it.applied ? 'ok' : 'off'}`}>
                  {it.applied ? 'aplicado' : 'não aplicado'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {r.skipped.length > 0 && (
        <>
          <div className="disc-resultado-sub">Pulados</div>
          <ul className="disc-itens">
            {r.skipped.map((s, i) => (
              <li key={i}>
                <span>{s.what}</span>
                <span className="dim">— {s.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

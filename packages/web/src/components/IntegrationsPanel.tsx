import React, { useEffect, useState } from 'react';
import type {
  AgentSummary,
  IntegrationEntrypoints,
  IntegrationPlan,
  IntegrationSummary,
} from '@agents-hub/client';
import { describeError, pushToast, useAction } from '../actions';
import { agentColor, hub } from '../hub';
import { estadoDoHook, estadoDoMcp, type RotuloDeEstado } from '../logic/security';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  agents: AgentSummary[];
  /** Projeto escolhido no topo: o MCP do Claude/OpenClaude fica no projeto. */
  projectId: string;
  projectName: string;
}

/**
 * Por agente: o gate pré-execução está ativo, com timeout antigo, ou o agente
 * só tem vigilância reativa? O MCP do Hub está registrado e atualizado?
 * (vistoria 05, "cobertura visível").
 *
 * Instalar escreve na config de OUTRA ferramenta (`~/.claude/settings.json`,
 * `~/.codex/config.toml`...). Por isso: primeiro a prévia, com o diff exato do
 * arquivo; gravar só com confirmação, e o daemon recusa se o arquivo mudou
 * depois da prévia (o que se aprovou é o que vai para o disco).
 */
export function IntegrationsPanel({ agents, projectId, projectName }: Props): React.JSX.Element {
  const [lista, setLista] = useState<IntegrationSummary[] | null>(null);
  const [pontos, setPontos] = useState<IntegrationEntrypoints | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [plano, setPlano] = useState<IntegrationPlan | null>(null);
  const action = useAction();

  useEffect(() => {
    let cancelado = false;
    setErro(null);
    hub
      .integrations(projectId === '' ? undefined : projectId)
      .then((r) => {
        if (cancelado) return;
        setLista(r.integrations);
        setPontos(r.entrypoints);
      })
      .catch((err: unknown) => {
        if (cancelado) return;
        const { title, detail } = describeError(err);
        setErro(detail ? `${title} (${detail})` : title);
      });
    return () => {
      cancelado = true;
    };
  }, [projectId, recarga]);

  const nomeDoAgente = (id: string): string => agents.find((a) => a.id === id)?.name ?? id;

  const previa = async (agentId: string, tipo: 'hook' | 'mcp'): Promise<void> => {
    await action.run(`previa:${agentId}:${tipo}`, async () => {
      const r = await hub.planIntegration(agentId, tipo, projectId === '' ? undefined : projectId);
      setPlano(r.plan);
    });
  };

  const gravar = async (): Promise<void> => {
    if (!plano) return;
    const alvo = plano;
    const ok = await action.run('gravar', async () => {
      const r = await hub.applyIntegration(
        alvo.agentId,
        alvo.tipo,
        alvo.base,
        projectId === '' ? undefined : projectId,
      );
      pushToast({
        kind: 'ok',
        title: `${alvo.tipo === 'hook' ? 'Gate' : 'MCP'} gravado em ${nomeDoAgente(alvo.agentId)}`,
        detail: r.backup ? `backup: ${r.backup}` : null,
      });
    });
    setPlano(null);
    if (ok) setRecarga((n) => n + 1);
  };

  return (
    <div className="settings-card">
      <h3 className="card-title">Gate e MCP por agente</h3>
      <p className="card-desc">
        <strong>Gate ativo</strong>: o Hub decide antes de Bash/Write/Edit rodar.{' '}
        <strong>Só vigilância</strong>: o Hub vê o evento depois. O MCP é o que deixa o agente
        chamar o Hub (delegar, consultar).
        {projectName ? ` MCP por projeto em "${projectName}".` : ' Escolha um projeto para ver o MCP por projeto.'}
      </p>

      {pontos && (!pontos.cliExiste || !pontos.mcpExiste) && (
        <p className="help help-warn">
          Build incompleto: {!pontos.cliExiste && <code>{pontos.cli}</code>}{' '}
          {!pontos.mcpExiste && <code>{pontos.mcp}</code>} não existe — instalar pelo painel fica
          indisponível até rodar o build.
        </p>
      )}

      {erro && (
        <div className="settings-erro" role="alert">
          Não foi possível ler as integrações: {erro}
          <button className="ghost" onClick={() => setRecarga((n) => n + 1)}>
            tentar de novo
          </button>
        </div>
      )}
      {action.error && (
        <div className="settings-erro" role="alert">
          {action.error}
          <button className="ghost" onClick={action.clearError}>
            dispensar
          </button>
        </div>
      )}
      {!lista && !erro && <div className="settings-vazio">carregando…</div>}

      {lista && (
        <ul className="sec-lista" aria-label="Integrações por agente">
          {lista.map((i) => {
            const hook = estadoDoHook(i.hook);
            const mcp = i.mcp ? estadoDoMcp(i.mcp) : null;
            const podeHook =
              i.hook.instalavelPeloPainel && (!i.hook.instalado || i.hook.avisoTimeout !== null) && !i.hook.erro;
            const podeMcp =
              i.mcp !== null && !i.mcp.precisaDeProjeto && !i.mcp.erro && (!i.mcp.registrado || !i.mcp.atualizado);
            return (
              <li key={i.agentId} className="sec-item sec-integ" style={{ '--disc-color': agentColor(i.agentId) } as React.CSSProperties}>
                <div className="sec-item-cab">
                  <span className="chip-dot" style={{ background: agentColor(i.agentId) }} aria-hidden="true" />
                  <strong>{nomeDoAgente(i.agentId)}</strong>
                </div>
                <div className="sec-integ-linha">
                  <span className="sec-integ-rotulo">Gate</span>
                  <Estado estado={hook} />
                  <span className="sec-espaco" />
                  {podeHook && (
                    <button
                      onClick={() => void previa(i.agentId, 'hook')}
                      disabled={action.busy !== null}
                      aria-label={`${i.hook.instalado ? 'Atualizar' : 'Instalar'} gate em ${nomeDoAgente(i.agentId)} (prévia)`}
                    >
                      {i.hook.instalado ? 'Atualizar…' : 'Instalar…'}
                    </button>
                  )}
                </div>
                {i.hook.avisoTimeout && <div className="aviso-inline">⚠️ {i.hook.avisoTimeout}</div>}
                {i.hook.erro && <div className="aviso-inline">⚠️ {i.hook.erro}</div>}
                <div className="help sec-integ-nota">
                  {i.hook.arquivo && <code>{i.hook.arquivo}</code>} {i.hook.nota}
                  {!i.hook.instalavelPeloPainel && i.hook.comando && (
                    <>
                      {' '}
                      — pelo terminal: <code>{i.hook.comando}</code>
                    </>
                  )}
                </div>

                {i.mcp && mcp && (
                  <>
                    <div className="sec-integ-linha">
                      <span className="sec-integ-rotulo">MCP</span>
                      <Estado estado={mcp} />
                      {!i.mcp.verificado && <span className="sec-badge tom-pede">formato não confirmado</span>}
                      <span className="sec-espaco" />
                      {podeMcp && (
                        <button
                          onClick={() => void previa(i.agentId, 'mcp')}
                          disabled={action.busy !== null}
                          aria-label={`${i.mcp.registrado ? 'Atualizar' : 'Registrar'} MCP em ${nomeDoAgente(i.agentId)} (prévia)`}
                        >
                          {i.mcp.registrado ? 'Atualizar…' : 'Registrar…'}
                        </button>
                      )}
                    </div>
                    {i.mcp.erro && <div className="aviso-inline">⚠️ {i.mcp.erro}</div>}
                    <div className="help sec-integ-nota">
                      {i.mcp.arquivo && <code>{i.mcp.arquivo}</code>} {i.mcp.nota ?? ''}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {plano && (
        <ConfirmDialog
          titulo={`${plano.tipo === 'hook' ? 'Gate' : 'MCP'} em ${nomeDoAgente(plano.agentId)}: prévia`}
          resumo={
            plano.acao === 'nada'
              ? 'Já está como o Hub gravaria. Nada a fazer.'
              : `${plano.acao === 'criar' ? 'Cria' : 'Altera'} ${plano.arquivo}. O original fica num backup versionado ao lado.`
          }
          perigo
          confirmarRotulo="Gravar no arquivo"
          confirmarDesabilitado={plano.acao === 'nada'}
          ocupado={action.busy === 'gravar'}
          onCancelar={() => setPlano(null)}
          onConfirmar={() => void gravar()}
        >
          {plano.avisos.map((a) => (
            <p key={a} className="help help-warn">
              ⚠️ {a}
            </p>
          ))}
          {plano.diff.length > 0 && (
            <pre className="sec-diff" aria-label={`Diff de ${plano.arquivo}`}>
              {plano.diff.map((l, n) => (
                <span key={n} className={`sec-diff-l sec-diff-${l.tipo === '+' ? 'mais' : l.tipo === '-' ? 'menos' : l.tipo === '@' ? 'salto' : 'ctx'}`}>
                  {l.tipo === '@' ? '' : `${l.tipo} `}
                  {l.texto}
                  {'\n'}
                </span>
              ))}
            </pre>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

function Estado({ estado }: { estado: RotuloDeEstado }): React.JSX.Element {
  const tom = estado.tom === 'erro' ? 'nega' : estado.tom === 'alerta' ? 'pede' : estado.tom;
  return <span className={`sec-badge tom-${tom}`}>{estado.texto}</span>;
}

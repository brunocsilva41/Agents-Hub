import React, { useEffect, useState } from 'react';
import type { ProjectSummary, RepoConfigStatusDto } from '@agents-hub/client';
import { describeError, useAction } from '../actions';
import { hub } from '../hub';
import { resumoDaConfianca, type ResumoDaConfianca } from '../logic/security';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  project: ProjectSummary | undefined;
  /** Depois de confiar/retirar: o índice de projetos muda (`trusted`). */
  onChanged: () => void;
}

/**
 * Confiança no `.agents-hub/config.yaml` do repositório (item 1.9).
 *
 * O arquivo é versionado: quem clona herda. Por isso o que ele declara de
 * sensível — comando de validação (vira processo), `*_BASE_URL` (para onde vai
 * a credencial do CLI), env, prompts e memória — só vale depois de o usuário
 * confiar NESTE conteúdo (hash). Mudou depois? Suspensa até reconfirmar. A
 * tela mostra o estado e exatamente o que passaria a valer, e pede
 * confirmação explícita para confiar ou retirar.
 */
export function ProjectTrustPanel({ project, onChanged }: Props): React.JSX.Element {
  const [repo, setRepo] = useState<RepoConfigStatusDto | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [confirmar, setConfirmar] = useState<'confiar' | 'retirar' | null>(null);
  const action = useAction();
  const projectId = project?.id ?? '';

  useEffect(() => {
    if (projectId === '') return;
    let cancelado = false;
    setRepo(null);
    setErro(null);
    hub
      .projectContext(projectId)
      .then(({ repo: r }) => {
        if (!cancelado) setRepo(r ?? null);
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

  if (!project) {
    return (
      <div className="settings-card">
        <h3 className="card-title">Confiança do projeto</h3>
        <div className="settings-vazio">
          Escolha um projeto no topo para ver o que o repositório declara.
        </div>
      </div>
    );
  }

  const resumo = repo ? resumoDaConfianca(repo) : null;

  const aplicar = async (trusted: boolean): Promise<void> => {
    const ok = await action.run(
      'confianca',
      () => hub.setProjectTrusted(project.id, trusted),
      trusted ? 'projeto marcado como confiável' : 'confiança retirada',
    );
    setConfirmar(null);
    if (ok) {
      setRecarga((n) => n + 1);
      onChanged();
    }
  };

  return (
    <div className="settings-card">
      <h3 className="card-title">Confiança do projeto</h3>
      <p className="card-desc">
        O que o <code>.agents-hub/config.yaml</code> de <strong>{project.name}</strong> pode mudar na sua
        máquina, e se está valendo.
      </p>

      {erro && (
        <div className="settings-erro" role="alert">
          Não foi possível ler o estado do repositório: {erro}
          <button className="ghost" onClick={() => setRecarga((n) => n + 1)}>
            tentar de novo
          </button>
        </div>
      )}

      {!repo && !erro && <div className="settings-vazio">carregando…</div>}

      {repo && resumo && (
        <>
          <div className={`sec-confianca tom-${resumo.tom}`}>
            <span className={`sec-badge tom-${resumo.tom === 'alerta' ? 'nega' : resumo.tom}`}>
              {resumo.rotulo}
            </span>
            <span>{resumo.explicacao}</span>
          </div>
          <p className="help">
            Arquivo: <code>{repo.path}</code>
          </p>

          {!resumo.vazio && <OQueORepoQuer resumo={resumo} />}

          {action.error && (
            <div className="settings-erro" role="alert">
              {action.error}
              <button className="ghost" onClick={action.clearError}>
                dispensar
              </button>
            </div>
          )}

          <div className="sec-acoes">
            {repo.trust !== 'untrusted' && (
              <button
                className="danger"
                onClick={() => setConfirmar('retirar')}
                disabled={action.busy !== null}
              >
                Retirar confiança…
              </button>
            )}
            {repo.trust !== 'trusted' && !resumo.vazio && (
              <button
                className="primary"
                onClick={() => setConfirmar('confiar')}
                disabled={action.busy !== null}
              >
                {repo.trust === 'suspended' ? 'Confiar no conteúdo novo…' : 'Confiar neste conteúdo…'}
              </button>
            )}
          </div>
        </>
      )}

      {confirmar === 'confiar' && resumo && (
        <ConfirmDialog
          titulo={`Confiar em "${project.name}"?`}
          resumo="Tudo abaixo passa a valer nas próximas sessões deste projeto. Se o arquivo mudar, a confiança é suspensa sozinha."
          perigo
          confirmarRotulo="Confiar"
          ocupado={action.busy === 'confianca'}
          onCancelar={() => setConfirmar(null)}
          onConfirmar={() => void aplicar(true)}
        >
          <OQueORepoQuer resumo={resumo} />
        </ConfirmDialog>
      )}
      {confirmar === 'retirar' && (
        <ConfirmDialog
          titulo={`Retirar a confiança em "${project.name}"?`}
          resumo="Comando de validação, env, BASE_URL, prompts e memória vindos do repositório deixam de valer. O que você configurou pelo Hub continua."
          confirmarRotulo="Retirar confiança"
          ocupado={action.busy === 'confianca'}
          onCancelar={() => setConfirmar(null)}
          onConfirmar={() => void aplicar(false)}
        />
      )}
    </div>
  );
}

function OQueORepoQuer({ resumo }: { resumo: ResumoDaConfianca }): React.JSX.Element {
  const grupos: Array<{ titulo: string; itens: string[]; perigo?: boolean }> = [
    { titulo: 'Executa processo na sua máquina', itens: resumo.execucao, perigo: true },
    { titulo: 'Muda para onde vai a credencial do CLI (BASE_URL)', itens: resumo.rede, perigo: true },
    { titulo: 'Variáveis de ambiente do agente', itens: resumo.ambiente },
    { titulo: 'Instruções ao agente (prompts, memória)', itens: resumo.instrucoes },
  ];
  return (
    <div className="sec-avisos">
      {grupos
        .filter((g) => g.itens.length > 0)
        .map((g) => (
          <div
            key={g.titulo}
            className={`sec-aviso ${g.perigo ? 'sec-aviso-perigo' : 'sec-aviso-alerta'}`}
          >
            <strong>{g.titulo}</strong>
            <ul>
              {g.itens.map((i) => (
                <li key={i}>
                  <code>{i}</code>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

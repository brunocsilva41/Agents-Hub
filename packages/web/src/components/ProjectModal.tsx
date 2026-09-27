import React, { useId, useRef, useState } from 'react';
import { pushToast, useAction } from '../actions';
import { hub } from '../hub';
import { erroDeCaminhoDoDaemon, problemaNoCaminhoLocal } from '../logic/project-path';
import {
  avisoDeRegistroParcial,
  PROGRESSO_INICIAL,
  registrarProjeto,
  type ProgressoDoRegistro,
  type ResultadoDoRegistro,
} from '../logic/project-registration';
import { useDialog, useFecharPeloFundo } from '../useDialog';

interface Props {
  onClose: () => void;
  /** Tudo feito: fecha o modal e seleciona o projeto. */
  onCreated: (projectId: string) => void;
  /** Projeto criado mas com pendências (pasta/diretrizes): atualiza a lista já. */
  onProjectExists?: (projectId: string) => void;
}

/** Último segmento do caminho, com barra de qualquer sistema. */
function nomeDaPasta(caminho: string): string {
  const partes = caminho.trim().split(/[\\/]/);
  return partes[partes.length - 1] ?? '';
}

export function ProjectModal({ onClose, onCreated, onProjectExists }: Props): React.JSX.Element {
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [extraFolders, setExtraFolders] = useState('');
  const [guidelines, setGuidelines] = useState('');
  // Erro do caminho principal, mostrado junto do campo. O daemon recusa pasta
  // inexistente/arquivo/relativo com 400 INVALID_PATH; antes aceitava e o
  // modal dizia "projeto registrado" para uma pasta que não existe.
  const [erroCaminho, setErroCaminho] = useState<string | null>(null);
  const action = useAction();
  const dialogRef = useRef<HTMLDivElement>(null);
  const base = useId();
  const tituloId = `${base}-titulo`;
  const descricaoId = `${base}-descricao`;

  // O que já foi feito nesta abertura do modal. "Tentar de novo" depois de uma
  // falha parcial retoma daqui: não recria o projeto nem reenvia as pastas que
  // já entraram (`logic/project-registration`).
  const progressoRef = useRef<ProgressoDoRegistro>(PROGRESSO_INICIAL);
  const [projetoCriado, setProjetoCriado] = useState(false);
  const [avisoParcial, setAvisoParcial] = useState<string | null>(null);

  /**
   * Cria o projeto, vincula as pastas extras e grava as diretrizes.
   *
   * As três coisas iam para lugares diferentes antes: a pasta principal para o
   * daemon, as diretrizes para o `localStorage` (onde nenhuma delegação as
   * enxergava) e as pastas extras para lugar nenhum — o campo era preenchido e
   * descartado.
   *
   * A falha de uma pasta extra NÃO derruba o resto: o projeto já foi criado, a
   * lista do painel é atualizada na hora (`onProjectExists`) e o modal fica
   * aberto só para o que falta.
   */
  const handleCreate = async () => {
    if (!projetoCriado) {
      const problema = problemaNoCaminhoLocal(folderPath);
      if (problema) {
        setErroCaminho(problema);
        return;
      }
    }
    setErroCaminho(null);

    const projectName = name.trim() || nomeDaPasta(folderPath) || 'Projeto';
    const extras = extraFolders
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let resultado: ResultadoDoRegistro | null = null;
    const ok = await action.run(
      'create-project',
      async () => {
        try {
          resultado = await registrarProjeto(
            { caminho: folderPath.trim(), nome: projectName, extras, diretrizes: guidelines },
            progressoRef.current,
            {
              criarProjeto: (caminho, nome) => hub.addProject(caminho, nome).then((r) => r.project),
              vincularPasta: (id, pasta) => hub.addFolder(id, pasta),
              gravarDiretrizes: (id, texto) => hub.saveProjectContext(id, { memory: texto }),
            },
          );
        } catch (err) {
          setErroCaminho(erroDeCaminhoDoDaemon(err));
          throw err;
        }
      },
    );
    const r = resultado as ResultadoDoRegistro | null;
    if (!ok || !r) return;
    const novo = progressoRef.current.projectId === null;
    progressoRef.current = r.progresso;
    const projectId = r.progresso.projectId!;
    if (r.completo) {
      pushToast({ kind: 'ok', title: 'projeto registrado', detail: null });
      onCreated(projectId);
      return;
    }
    // Parcial: o projeto existe — a lista precisa mostrá-lo já, e não pode
    // ser criado de novo.
    setProjetoCriado(true);
    setAvisoParcial(avisoDeRegistroParcial(r));
    if (novo) onProjectExists?.(projectId);
    pushToast({ kind: 'warn', title: 'Projeto criado com pendências', detail: avisoDeRegistroParcial(r) });
  };

  const sujo = [folderPath, name, extraFolders, guidelines].some((v) => v.trim() !== '');
  useDialog(dialogRef, onClose);
  const fundo = useFecharPeloFundo(onClose, sujo);

  return (
    <div className="modal-backdrop" {...fundo}>
      <div
        ref={dialogRef}
        className="modal project-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        aria-describedby={descricaoId}
      >
        <div className="modal-body">
          <div className="modal-header-banner">
            <div className="modal-icon-badge" aria-hidden="true">📁</div>
            <div>
              <h2 id={tituloId}>Registrar Novo Projeto</h2>
              <p className="hint" id={descricaoId}>
                Vincule uma pasta do seu computador para isolar tarefas, chats e permissões dos agentes.
              </p>
            </div>
          </div>

          {action.error && (
            <div className="error-banner" role="alert">
              {action.error}
            </div>
          )}
          {avisoParcial && !action.error && (
            <div className="error-banner projeto-parcial" role="alert">
              {avisoParcial}
            </div>
          )}

          <div className="field">
            <label htmlFor="folder-path">
              Caminho da Pasta Principal <span className="req">*</span>
            </label>
            <input
              id="folder-path"
              type="text"
              placeholder="Ex: C:\Users\SeuUsuario\Projetos\MeuApp ou /var/www/app"
              value={folderPath}
              readOnly={projetoCriado}
              aria-invalid={erroCaminho !== null}
              aria-describedby={erroCaminho !== null ? 'folder-path-erro' : undefined}
              onChange={(e) => {
                setFolderPath(e.target.value);
                setErroCaminho(null);
                if (!name) {
                  const autoName = e.target.value.trim().split(/[\\/]/).pop() || '';
                  if (autoName) setName(autoName);
                }
              }}
              data-autofocus
            />
            {erroCaminho !== null && (
              <div id="folder-path-erro" className="aviso-inline" role="alert">
                ⚠️ {erroCaminho}
              </div>
            )}
            <div className="help">
              Os agentes executarão ferramentas e criarão Git worktrees isolados dentro desta pasta.
            </div>
          </div>

          <div className="field">
            <label htmlFor="project-name">Nome de Exibição do Projeto</label>
            <input
              id="project-name"
              type="text"
              placeholder="Ex: Backend Core API"
              value={name}
              readOnly={projetoCriado}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="extra-folders">Pastas Adicionais Vinculadas (Opcional)</label>
            <textarea
              id="extra-folders"
              rows={2}
              placeholder="Uma pasta por linha para projetos multi-repo ou monorepos..."
              value={extraFolders}
              onChange={(e) => setExtraFolders(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="guidelines">Diretrizes & Regras do Projeto (Memória Local)</label>
            <textarea
              id="guidelines"
              rows={3}
              placeholder="Ex: Utilizar TypeScript strict, Node v22+, seguir arquitetura hexagonal e sempre escrever testes unitários em Vitest..."
              value={guidelines}
              onChange={(e) => setGuidelines(e.target.value)}
            />
            <div className="help">
              Estas instruções serão injetadas automaticamente no contexto de todas as sessões deste projeto.
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={action.busy !== null}>
            {projetoCriado ? 'Fechar' : 'Cancelar'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void handleCreate()}
            disabled={!folderPath.trim() || action.busy !== null}
          >
            {action.busy !== null ? 'Registrando…' : projetoCriado ? 'Concluir' : 'Criar & Vincular Projeto'}
          </button>
        </div>
      </div>
    </div>
  );
}

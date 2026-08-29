import React, { useState } from 'react';
import { useAction } from '../actions';
import { hub } from '../hub';

interface Props {
  onClose: () => void;
  onCreated: (projectId: string) => void;
}

/** Último segmento do caminho, com barra de qualquer sistema. */
function nomeDaPasta(caminho: string): string {
  const partes = caminho.trim().split(/[\/]/);
  return partes[partes.length - 1] ?? '';
}

export function ProjectModal({ onClose, onCreated }: Props): React.JSX.Element {
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [extraFolders, setExtraFolders] = useState('');
  const [guidelines, setGuidelines] = useState('');
  const action = useAction();

  /**
   * Cria o projeto, vincula as pastas extras e grava as diretrizes.
   *
   * As três coisas iam para lugares diferentes antes: a pasta principal para o
   * daemon, as diretrizes para o `localStorage` (onde nenhuma delegação as
   * enxergava) e as pastas extras para lugar nenhum — o campo era preenchido e
   * descartado.
   *
   * A falha de uma pasta extra NÃO derruba o resto: o projeto já foi criado, e
   * silenciar quais ficaram de fora seria pior do que relatar.
   */
  const handleCreate = async () => {
    if (!folderPath.trim()) return;

    const projectName = name.trim() || nomeDaPasta(folderPath) || 'Projeto';
    const extras = extraFolders
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    await action.run(
      'create-project',
      async () => {
        const { project } = await hub.addProject(folderPath.trim(), projectName);

        const recusadas: string[] = [];
        for (const pasta of extras) {
          try {
            await hub.addFolder(project.id, pasta);
          } catch (err) {
            // Sobreposição e caminho relativo são recusas legítimas, e o daemon
            // explica o motivo. Juntar para mostrar de uma vez, em vez de
            // abortar na primeira e deixar as outras sem tentativa.
            recusadas.push(`${pasta} — ${err instanceof Error ? err.message : 'recusada'}`);
          }
        }

        if (guidelines.trim()) {
          await hub.saveProjectContext(project.id, { memory: guidelines.trim() });
        }

        if (recusadas.length > 0) {
          throw new Error(
            `Projeto criado, mas ${recusadas.length} pasta(s) não foram vinculadas: ` +
              recusadas.join(' | '),
          );
        }

        onCreated(project.id);
      },
      'projeto registrado',
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal project-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header-banner">
          <div className="modal-icon-badge">📁</div>
          <div>
            <h2>Registrar Novo Projeto</h2>
            <p className="hint">
              Vincule uma pasta do seu computador para isolar tarefas, chats e permissões dos agentes.
            </p>
          </div>
        </div>

        {action.error && (
          <div className="error-banner" role="alert">
            {action.error}
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
            onChange={(e) => {
              setFolderPath(e.target.value);
              if (!name) {
                const autoName = e.target.value.trim().split(/[\\/]/).pop() || '';
                if (autoName) setName(autoName);
              }
            }}
            autoFocus
          />
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

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={action.busy !== null}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary"
            onClick={handleCreate}
            disabled={!folderPath.trim() || action.busy !== null}
          >
            {action.busy !== null ? 'Registrando…' : 'Criar & Vincular Projeto'}
          </button>
        </div>
      </div>
    </div>
  );
}

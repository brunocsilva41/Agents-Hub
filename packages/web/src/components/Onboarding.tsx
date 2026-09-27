import React from 'react';

/**
 * Primeira execução: nenhum projeto registrado.
 *
 * Antes, o painel abria vazio (só os estados vazios do DAG e da Timeline) e a
 * descoberta de agentes vivia enterrada em Configurações, pedindo um projeto
 * que ainda não existia (vistoria 2026-09-25, relatório 14). Aqui ficam os dois
 * primeiros passos, na ordem em que destravam o resto: registrar a pasta do
 * repositório e ver o que cada CLI já tem na máquina.
 */
export function Onboarding(props: {
  onNewProject: () => void;
  onVerAgentes: () => void;
  onDispensar: () => void;
}): React.JSX.Element {
  return (
    <section className="settings-card onboarding" aria-label="Primeiros passos" style={{ margin: 12 }}>
      <h3 className="card-title">Bem-vindo ao Agents-Hub</h3>
      <p className="card-desc">
        Nenhum projeto registrado ainda. Sessões, prompts e permissões vivem dentro de um projeto — a
        pasta de um repositório seu.
      </p>
      <ol className="empty-hint" style={{ maxWidth: 'none', paddingLeft: 18 }}>
        <li>
          <strong>Registre um projeto</strong> apontando para a pasta do repositório.
        </li>
        <li>
          <strong>Veja os agentes detectados</strong>: o que cada CLI (claude, codex…) já tem instalado e
          autenticado, e importe instruções e MCP para o projeto.
        </li>
      </ol>
      <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="primary" onClick={props.onNewProject}>
          Registrar projeto
        </button>
        <button onClick={props.onVerAgentes}>Ver agentes detectados</button>
        <button className="ghost" onClick={props.onDispensar}>
          agora não
        </button>
      </div>
    </section>
  );
}

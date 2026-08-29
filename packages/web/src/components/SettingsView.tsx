import React, { useCallback, useEffect, useState } from 'react';
import type { AgentSummary, ProjectContextDto, ProjectSummary } from '@agents-hub/client';
import { useAction } from '../actions';
import { agentColor, hub } from '../hub';

/**
 * Configurações do projeto.
 *
 * A versão anterior guardava tudo em `localStorage`. Três coisas quebravam:
 *
 * 1. A CLI e o servidor MCP não enxergavam nada do que era salvo.
 * 2. **A sessão que um agente delega a outro também não** — e é justamente o
 *    agente que recebeu a tarefa quem mais precisa das regras da casa.
 * 3. Endpoint local, modelo local e sandbox do Codex eram escritos e lidos
 *    apenas por esta tela. Nunca chegavam a lugar nenhum. O de sandbox era o
 *    pior: um controle de segurança que não fazia nada.
 *
 * Agora tudo vem e vai pelo daemon, que grava em `.agents-hub/config.yaml` do
 * projeto. Por isso a tela é POR PROJETO: é onde a configuração de fato mora.
 */

type Aba = 'prompts' | 'memory' | 'models' | 'sandbox';

interface Props {
  agents: AgentSummary[];
  projects: ProjectSummary[];
}

/** Endpoints locais comuns, para não obrigar a decorar a porta. */
const ENDPOINTS_SUGERIDOS = [
  { rotulo: 'Ollama', url: 'http://localhost:11434/v1' },
  { rotulo: 'LM Studio', url: 'http://localhost:1234/v1' },
  { rotulo: 'vLLM', url: 'http://localhost:8000/v1' },
];

export function SettingsView({ agents, projects }: Props): React.JSX.Element {
  const [aba, setAba] = useState<Aba>('prompts');
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [agenteSelecionado, setAgenteSelecionado] = useState(agents[0]?.id ?? 'claude');
  const [ctx, setCtx] = useState<ProjectContextDto>({});
  const [carregando, setCarregando] = useState(false);
  const [sujo, setSujo] = useState(false);
  const action = useAction();

  // Sem projeto não há onde guardar: a tela precisa dizer isso, não fingir
  // que salvou em algum lugar.
  const semProjeto = projectId === '';

  const carregar = useCallback(async (id: string) => {
    if (id === '') return;
    setCarregando(true);
    try {
      const { context } = await hub.projectContext(id);
      setCtx(context);
      setSujo(false);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar(projectId);
  }, [projectId, carregar]);

  useEffect(() => {
    if (projectId === '' && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  const salvar = async (): Promise<void> => {
    const ok = await action.run(
      'salvar',
      async () => {
        const { context } = await hub.saveProjectContext(projectId, ctx);
        // Recarrega do que o daemon DEVOLVEU, não do que mandamos: o filtro de
        // ambiente pode ter recusado variáveis, e a tela precisa mostrar o que
        // ficou valendo de verdade.
        setCtx(context);
      },
      'configurações salvas no projeto',
    );
    if (ok) setSujo(false);
  };

  const mudarPrompt = (agentId: string, valor: string): void => {
    setCtx((atual) => ({ ...atual, prompts: { ...(atual.prompts ?? {}), [agentId]: valor } }));
    setSujo(true);
  };

  const mudarEnv = (agentId: string, chave: string, valor: string): void => {
    setCtx((atual) => {
      const doAgente = { ...(atual.env?.[agentId] ?? {}) };
      if (valor.trim() === '') delete doAgente[chave];
      else doAgente[chave] = valor;
      return { ...atual, env: { ...(atual.env ?? {}), [agentId]: doAgente } };
    });
    setSujo(true);
  };

  const envDoAgente = ctx.env?.[agenteSelecionado] ?? {};
  const projetoAtual = projects.find((p) => p.id === projectId);

  return (
    <div className="settings-page">
      <div className="settings-header">
        <div>
          <h2 className="settings-title">Configurações do projeto</h2>
          <p className="settings-subtitle">
            Gravadas em <code>.agents-hub/config.yaml</code> do projeto, versionadas junto do
            código. Valem para o painel, para a CLI e para as sessões que um agente delega a outro.
          </p>
        </div>
        <div className="settings-header-actions">
          <label className="field-inline">
            <span>Projeto</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={projects.length === 0}
            >
              {projects.length === 0 && <option value="">nenhum projeto ainda</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            onClick={() => void salvar()}
            disabled={semProjeto || !sujo || action.busy !== null}
          >
            {action.busy === 'salvar' ? 'salvando…' : sujo ? 'Salvar' : 'Salvo'}
          </button>
        </div>
      </div>

      {action.error !== null && (
        <div className="settings-erro" role="alert">
          {action.error}
          <button className="ghost" onClick={action.clearError}>
            dispensar
          </button>
        </div>
      )}

      {semProjeto && (
        <div className="settings-vazio">
          Nenhum projeto cadastrado. Estas configurações vivem dentro de um projeto — crie um
          primeiro, apontando para a pasta do repositório.
        </div>
      )}

      <div className="settings-layout" aria-busy={carregando}>
        <aside className="settings-nav">
          <BotaoAba
            ativa={aba === 'prompts'}
            onClick={() => setAba('prompts')}
            icone="📝"
            titulo="Prompts por agente"
            sub="Instruções específicas de cada CLI"
          />
          <BotaoAba
            ativa={aba === 'memory'}
            onClick={() => setAba('memory')}
            icone="🧠"
            titulo="Memória do projeto"
            sub="Diretrizes que valem para todos"
          />
          <BotaoAba
            ativa={aba === 'models'}
            onClick={() => setAba('models')}
            icone="🖥️"
            titulo="Modelos locais"
            sub="Ollama, LM Studio, vLLM"
          />
          <BotaoAba
            ativa={aba === 'sandbox'}
            onClick={() => setAba('sandbox')}
            icone="🛡️"
            titulo="Isolamento"
            sub="O que governa cada agente"
          />
        </aside>

        <main className="settings-content">
          {aba === 'prompts' && (
            <div className="settings-card">
              <h3 className="card-title">Instruções por agente</h3>
              <p className="card-desc">
                Entram no prompt antes da tarefa, como enquadramento. Chegam também ao agente que
                recebe a tarefa por delegação, por retentativa e por substituição no fallback.
              </p>

              <ChipsDeAgente
                agents={agents}
                selecionado={agenteSelecionado}
                onSelect={setAgenteSelecionado}
              />

              <div className="field" style={{ marginTop: 16 }}>
                <label htmlFor="prompt-agente">
                  Instruções para <strong>{agenteSelecionado}</strong>
                </label>
                <textarea
                  id="prompt-agente"
                  rows={8}
                  className="settings-textarea"
                  disabled={semProjeto}
                  placeholder="Ex.: prefira mudanças pequenas e testáveis; explique a decisão antes de aplicar."
                  value={ctx.prompts?.[agenteSelecionado] ?? ''}
                  onChange={(e) => mudarPrompt(agenteSelecionado, e.target.value)}
                />
                <div className="help">
                  Fica em <code>prompts.{agenteSelecionado}</code> do arquivo do projeto.
                </div>
              </div>
            </div>
          )}

          {aba === 'memory' && (
            <div className="settings-card">
              <h3 className="card-title">Memória do projeto</h3>
              <p className="card-desc">
                Diretrizes que todo agente recebe neste projeto, qualquer que seja a tarefa.
              </p>
              <div className="field">
                <label htmlFor="memoria">Regras da casa</label>
                <textarea
                  id="memoria"
                  rows={12}
                  className="settings-textarea"
                  disabled={semProjeto}
                  placeholder={
                    'Ex.:\n- Nunca comitar direto em main.\n' +
                    '- Testes em Node test runner para toda rota nova.\n' +
                    '- Sem `any` no TypeScript.'
                  }
                  value={ctx.memory ?? ''}
                  onChange={(e) => {
                    setCtx((a) => ({ ...a, memory: e.target.value }));
                    setSujo(true);
                  }}
                />
                <div className="help">
                  Entra no prompt como enquadramento — não é misturada ao objetivo da tarefa, que é
                  o que o Hub usa para detectar um agente pedindo de volta o que já pediu.
                </div>
              </div>
            </div>
          )}

          {aba === 'models' && (
            <div className="settings-card">
              <h3 className="card-title">Modelo local por agente</h3>
              <p className="card-desc">
                Cada CLI descobre o provedor pelo ambiente. Apontar o endereço para um servidor
                local faz o agente rodar sem sair da máquina.
              </p>

              <ChipsDeAgente
                agents={agents}
                selecionado={agenteSelecionado}
                onSelect={setAgenteSelecionado}
              />

              <div className="field" style={{ marginTop: 16 }}>
                <label htmlFor="base-url">Endereço da API compatível com OpenAI</label>
                <input
                  id="base-url"
                  type="text"
                  disabled={semProjeto}
                  placeholder="http://localhost:11434/v1"
                  value={envDoAgente['OPENAI_BASE_URL'] ?? ''}
                  onChange={(e) => mudarEnv(agenteSelecionado, 'OPENAI_BASE_URL', e.target.value)}
                />
                <div className="sugestoes">
                  {ENDPOINTS_SUGERIDOS.map((s) => (
                    <button
                      key={s.url}
                      className="ghost"
                      disabled={semProjeto}
                      onClick={() => mudarEnv(agenteSelecionado, 'OPENAI_BASE_URL', s.url)}
                    >
                      {s.rotulo}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label htmlFor="api-key">Chave</label>
                <input
                  id="api-key"
                  type="text"
                  disabled={semProjeto}
                  placeholder="ollama"
                  value={envDoAgente['OPENAI_API_KEY'] ?? ''}
                  onChange={(e) => mudarEnv(agenteSelecionado, 'OPENAI_API_KEY', e.target.value)}
                />
                <div className="help">
                  Servidores locais costumam aceitar qualquer valor, mas quase todos exigem que o
                  campo exista.
                </div>
              </div>

              <div className="field">
                <label htmlFor="modelo">Modelo</label>
                <input
                  id="modelo"
                  type="text"
                  disabled={semProjeto}
                  placeholder="qwen2.5-coder:latest"
                  value={envDoAgente['MODEL'] ?? ''}
                  onChange={(e) => mudarEnv(agenteSelecionado, 'MODEL', e.target.value)}
                />
              </div>

              <p className="card-nota">
                Só variáveis de provedor são aceitas. O arquivo do projeto é versionado, então um
                repositório clonado poderia trazer <code>NODE_OPTIONS</code> ou <code>PATH</code> e
                virar execução de código na sua máquina — o daemon descarta essas na entrada e ao
                gravar.
              </p>
            </div>
          )}

          {aba === 'sandbox' && <PainelIsolamento agents={agents} />}
        </main>
      </div>
    </div>
  );
}

function BotaoAba(props: {
  ativa: boolean;
  onClick: () => void;
  icone: string;
  titulo: string;
  sub: string;
}): React.JSX.Element {
  return (
    <button
      className={`settings-nav-btn ${props.ativa ? 'active' : ''}`}
      onClick={props.onClick}
      aria-current={props.ativa ? 'page' : undefined}
    >
      <span className="nav-icon" aria-hidden="true">
        {props.icone}
      </span>
      <div className="nav-text">
        <strong>{props.titulo}</strong>
        <span>{props.sub}</span>
      </div>
    </button>
  );
}

function ChipsDeAgente(props: {
  agents: AgentSummary[];
  selecionado: string;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="agent-selector-chips" role="tablist">
      {props.agents.map((a) => (
        <button
          key={a.id}
          role="tab"
          aria-selected={props.selecionado === a.id}
          className={`agent-chip ${props.selecionado === a.id ? 'active' : ''}`}
          style={{ '--agent-chip-color': agentColor(a.id) } as React.CSSProperties}
          onClick={() => props.onSelect(a.id)}
        >
          <span className="chip-dot" style={{ background: agentColor(a.id) }} />
          <span>{a.name}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * O que de fato governa o isolamento de cada agente.
 *
 * Aqui havia um seletor de sandbox do Codex que era escrito e lido só por esta
 * tela: escolher "somente leitura" não tinha efeito nenhum sobre o agente.
 * Um controle de segurança que não controla nada é pior do que não existir,
 * porque faz baixar a guarda.
 *
 * O que existe de verdade é o modo da sessão, escolhido ao abri-la, que o
 * manifesto de cada agente traduz para a política nativa dele. Então esta aba
 * explica em vez de fingir que ajusta.
 */
function PainelIsolamento({ agents }: { agents: AgentSummary[] }): React.JSX.Element {
  const comModo = agents.filter((a) => a.caveats?.some((c) => c.includes('sandbox') || c.includes('permission-mode')));

  return (
    <div className="settings-card">
      <h3 className="card-title">Isolamento e permissões</h3>
      <p className="card-desc">
        O isolamento não se configura aqui: ele vem do <strong>modo da sessão</strong>, escolhido
        quando você a abre. Cada agente traduz esse modo para a política nativa dele.
      </p>

      <table className="tabela-modos">
        <thead>
          <tr>
            <th>Modo da sessão</th>
            <th>O que significa</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>supervised</code>
            </td>
            <td>
              O agente analisa e propõe, sem alterar arquivo. No Codex vira{' '}
              <code>--sandbox read-only</code>; no Claude, <code>--permission-mode plan</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>semi</code>
            </td>
            <td>
              Escrita limitada ao diretório da sessão — o worktree isolado, ou a pasta do projeto
              que você escolheu.
            </td>
          </tr>
          <tr>
            <td>
              <code>autonomous</code>
            </td>
            <td>Mesma escrita limitada, sem pausas para aprovação a cada passo.</td>
          </tr>
        </tbody>
      </table>

      <p className="card-nota">
        Hoje {comModo.length} de {agents.length} agentes têm essa tradução declarada no manifesto.
        Nos demais, o modo do Hub governa a política do Hub — vigilância, orçamento e o portão de
        delegação — mas não impõe nada ao próprio agente.
      </p>
    </div>
  );
}

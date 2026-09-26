import React, { useEffect, useReducer, useState } from 'react';
import type { AgentSummary, ProjectContextDto, ProjectSummary } from '@agents-hub/client';
import { prefixosDeEnvPermitidos } from '@agents-hub/core/agent-env';
import { describeError, useAction } from '../actions';
import { agentColor, hub } from '../hub';
import {
  camposDeEnvDoAgente,
  chaveEhPermitida,
  estadoInicial,
  extrasDoAgente,
  podeEditar,
  podeSalvar,
  reduzirForm,
  valorParaExibir,
  variavelConhecidaDoAgente,
} from '../logic/settings-form';
import { DiscoveryPanel } from './DiscoveryPanel';

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
 * Agora tudo vem e vai pelo daemon, que grava no banco do Hub, POR PROJETO
 * (item 1.9 do GOAL: fora do repositório, para não se confundir com o
 * `.agents-hub/config.yaml` versionado, que só vale com `hub project trust`).
 */

type Aba = 'prompts' | 'memory' | 'models' | 'sandbox' | 'discovery';

interface Props {
  agents: AgentSummary[];
  projects: ProjectSummary[];
  /** Abre o modal de registrar projeto (primeira execução, sem projetos). */
  onNewProject?: () => void;
}

/** Endpoints locais comuns, para não obrigar a decorar a porta. */
const ENDPOINTS_SUGERIDOS = [
  { rotulo: 'Ollama', url: 'http://localhost:11434/v1' },
  { rotulo: 'LM Studio', url: 'http://localhost:1234/v1' },
  { rotulo: 'vLLM', url: 'http://localhost:8000/v1' },
];

/**
 * Prefixos que o daemon aceita, vindos da mesma fonte que ele usa
 * (`@agents-hub/core/agent-env` — subcaminho sem `node:*`, seguro no bundle do
 * navegador). Antes era uma cópia à mão que precisava ser lembrada a cada
 * mudança lá.
 */
const PREFIXOS_ENV_PERMITIDOS = prefixosDeEnvPermitidos();

export function SettingsView({ agents, projects, onNewProject }: Props): React.JSX.Element {
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  // Sem projeto, a única aba útil é a que não depende de projeto: é por ela
  // que a primeira execução começa (ver os agentes que a máquina já tem).
  const [aba, setAba] = useState<Aba>(projects.length === 0 ? 'discovery' : 'prompts');
  const [agenteSelecionado, setAgenteSelecionado] = useState(agents[0]?.id ?? 'claude');
  const [form, despachar] = useReducer(reduzirForm, projectId, estadoInicial);
  const [recarga, setRecarga] = useState(0);
  const [novaChave, setNovaChave] = useState('');
  const [novoValor, setNovoValor] = useState('');
  const [mostrarChaveApi, setMostrarChaveApi] = useState(false);
  const action = useAction();

  const { ctx, sujo } = form;
  const carregando = form.status === 'carregando';
  // Sem projeto não há onde guardar: a tela precisa dizer isso, não fingir
  // que salvou em algum lugar.
  const semProjeto = projectId === '';
  // Campos só ficam editáveis com o contexto DESTE projeto carregado. Durante
  // a carga, o que se digitasse seria sobrescrito pela resposta; depois de uma
  // falha, não há contexto nenhum para editar — e salvar gravaria por cima do
  // arquivo do projeto um formulário vazio ou, antes da correção, o do
  // projeto anterior (vistoria 2026-09-25, relatório 03, ALTO).
  const bloqueado = !podeEditar(form);

  // A troca zera o formulário NA HORA (`reduzirForm`), e a resposta só é
  // aplicada se ainda for do projeto selecionado — a mesma guarda que o
  // `cancelado` dava, agora também no caminho de erro, que antes não existia.
  useEffect(() => {
    despachar({ tipo: 'trocar-projeto', projectId });
    if (projectId === '') return;
    let cancelado = false;
    hub
      .projectContext(projectId)
      .then(({ context }) => {
        if (!cancelado) despachar({ tipo: 'carregou', projectId, ctx: context });
      })
      .catch((err: unknown) => {
        if (cancelado) return;
        const { title, detail } = describeError(err);
        despachar({ tipo: 'falhou', projectId, erro: detail ? `${title} (${detail})` : title });
      });
    return () => {
      cancelado = true;
    };
  }, [projectId, recarga]);

  useEffect(() => {
    if (projectId === '' && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  // Fechar/recarregar a página com alteração não salva pergunta antes.
  useEffect(() => {
    if (!sujo) return;
    const aviso = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', aviso);
    return () => window.removeEventListener('beforeunload', aviso);
  }, [sujo]);

  const trocarProjeto = (novo: string): void => {
    if (novo === projectId) return;
    if (sujo && !window.confirm('Há alterações não salvas neste projeto. Descartar e trocar?')) {
      return;
    }
    setProjectId(novo);
  };

  const salvar = async (): Promise<void> => {
    if (!podeSalvar(form)) return;
    // Fotografa projeto e conteúdo: se o usuário trocar de projeto durante o
    // POST, a resposta não pode cair no formulário do outro.
    const alvo = projectId;
    const conteudo = ctx;
    await action.run(
      'salvar',
      async () => {
        const { context } = await hub.saveProjectContext(alvo, conteudo);
        // Recarrega do que o daemon DEVOLVEU, não do que mandamos: o filtro de
        // ambiente pode ter recusado variáveis, e a tela precisa mostrar o que
        // ficou valendo de verdade.
        despachar({ tipo: 'salvou', projectId: alvo, ctx: context });
      },
      'configurações salvas no projeto',
    );
  };

  const editar = (mudar: (atual: ProjectContextDto) => ProjectContextDto): void => {
    despachar({ tipo: 'editar', mudar });
  };

  const mudarPrompt = (agentId: string, valor: string): void => {
    editar((atual) => ({ ...atual, prompts: { ...(atual.prompts ?? {}), [agentId]: valor } }));
  };

  const mudarEnv = (agentId: string, chave: string, valor: string): void => {
    editar((atual) => {
      const doAgente = { ...(atual.env?.[agentId] ?? {}) };
      if (valor.trim() === '') delete doAgente[chave];
      else doAgente[chave] = valor;
      return { ...atual, env: { ...(atual.env ?? {}), [agentId]: doAgente } };
    });
  };

  const envDoAgente = ctx.env?.[agenteSelecionado] ?? {};
  const projetoAtual = projects.find((p) => p.id === projectId);
  const agenteAtual = agents.find((a) => a.id === agenteSelecionado);

  // Só as variáveis que ESTE agente lê (tabela em `core/agent-env.ts`); o
  // resto do env dele vai para "Outras variáveis".
  const camposFixos = camposDeEnvDoAgente(agenteSelecionado);
  const campoBaseUrl = camposFixos.find((c) => c.papel === 'baseUrl');
  const campoChave = camposFixos.find((c) => c.papel === 'apiKey');
  const campoModelo = camposFixos.find((c) => c.papel === 'model');
  const extras = extrasDoAgente(envDoAgente, agenteSelecionado);

  /**
   * Risco distinto do vazamento de chave (aviso ao lado do campo "Chave"
   * acima): aqui o problema não é o valor vazar, é o valor ser aceito. Uma
   * variável `*_BASE_URL` redireciona o canal inteiro — o CLI já autenticado
   * localmente manda a credencial nativa para o host que essa URL apontar.
   * Ver `packages/core/src/agent-env.ts` e `SECURITY.md`.
   */
  const chaveEhBaseUrl = (chave: string): boolean => chave.trim().toUpperCase().endsWith('_BASE_URL');

  /**
   * Aviso best-effort: nem a tabela de variáveis nem o manifesto dizem que o
   * agente lê isto. Não bloqueia — o CLI pode ler algo não documentado — mas
   * evita configurar `OPENAI_BASE_URL` no Claude sem perceber que é inócuo.
   */
  const variavelDocumentadaNoManifesto = (chave: string): boolean =>
    variavelConhecidaDoAgente(chave, agenteAtual);

  const adicionarExtra = (): void => {
    const chave = novaChave.trim();
    if (chave === '' || novoValor.trim() === '') return;
    mudarEnv(agenteSelecionado, chave, novoValor);
    setNovaChave('');
    setNovoValor('');
  };

  return (
    <div className="settings-page">
      <div className="settings-header">
        <div>
          <h2 className="settings-title">Configurações do projeto</h2>
          <p className="settings-subtitle">
            Gravadas no Hub desta máquina, por projeto (fora do repositório). Valem para o
            painel, para a CLI e para as sessões que um agente delega a outro. O
            <code>.agents-hub/config.yaml</code> do repositório só vale depois de{' '}
            <code>hub project trust</code>.
          </p>
        </div>
        <div className="settings-header-actions">
          <label className="field-inline">
            <span>Projeto</span>
            <select
              value={projectId}
              onChange={(e) => trocarProjeto(e.target.value)}
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
            disabled={!podeSalvar(form) || action.busy !== null}
          >
            {action.busy === 'salvar'
              ? 'salvando…'
              : form.status === 'falhou'
                ? 'Não carregado'
                : carregando
                  ? 'carregando…'
                  : sujo
                    ? 'Salvar'
                    : 'Salvo'}
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

      {form.status === 'falhou' && (
        <div className="settings-erro error-banner" role="alert">
          Não foi possível carregar a configuração de "{projetoAtual?.name ?? projectId}":{' '}
          {form.erroCarga}. Nada foi alterado no projeto; a edição fica travada até carregar.
          <button className="ghost" onClick={() => setRecarga((n) => n + 1)}>
            tentar de novo
          </button>
        </div>
      )}

      {semProjeto && (
        <div className="settings-vazio settings-card">
          <h3 className="card-title">Primeiros passos</h3>
          <p className="card-desc">
            Prompts, memória e modelos vivem dentro de um projeto — registre a pasta do
            repositório para configurá-los. Enquanto isso, veja em "Agentes detectados" o que cada
            CLI já tem instalado nesta máquina.
          </p>
          {onNewProject && (
            <button className="primary" onClick={onNewProject}>
              Registrar projeto
            </button>
          )}
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
          <BotaoAba
            ativa={aba === 'discovery'}
            onClick={() => setAba('discovery')}
            icone="🔍"
            titulo="Agentes detectados"
            sub="O que cada CLI já tem; importar"
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
                  disabled={bloqueado}
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
                  disabled={bloqueado}
                  placeholder={
                    'Ex.:\n- Nunca comitar direto em main.\n' +
                    '- Testes em Node test runner para toda rota nova.\n' +
                    '- Sem `any` no TypeScript.'
                  }
                  value={ctx.memory ?? ''}
                  onChange={(e) => {
                    const memory = e.target.value;
                    editar((a) => ({ ...a, memory }));
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

              {camposFixos.length === 0 && (
                <div className="help help-warn" style={{ marginTop: 16 }}>
                  <strong>{agenteAtual?.name ?? agenteSelecionado}</strong> não lê nenhuma variável
                  de provedor que o projeto possa definir — ele usa a própria configuração (login e
                  modelo escolhidos no CLI). Não há o que ajustar aqui para este agente.
                </div>
              )}

              {campoBaseUrl && (
              <div className="field" style={{ marginTop: 16 }}>
                <label htmlFor="base-url">
                  {campoBaseUrl.rotulo} <code>{campoBaseUrl.nome}</code>
                </label>
                <input
                  id="base-url"
                  type="text"
                  disabled={bloqueado}
                  placeholder={
                    campoBaseUrl.nome.startsWith('OPENAI_') ? 'http://localhost:11434/v1' : 'https://…'
                  }
                  value={envDoAgente[campoBaseUrl.nome] ?? ''}
                  onChange={(e) => mudarEnv(agenteSelecionado, campoBaseUrl.nome, e.target.value)}
                />
                {/* Os servidores locais sugeridos falam a API da OpenAI: só fazem
                    sentido para quem lê OPENAI_BASE_URL. */}
                {campoBaseUrl.nome.startsWith('OPENAI_') && (
                  <div className="sugestoes">
                    {ENDPOINTS_SUGERIDOS.map((s) => (
                      <button
                        key={s.url}
                        className="ghost"
                        disabled={bloqueado}
                        onClick={() => mudarEnv(agenteSelecionado, campoBaseUrl.nome, s.url)}
                      >
                        {s.rotulo}
                      </button>
                    ))}
                  </div>
                )}
                <div className="help help-warn">
                  ⚠️ Apontar esta URL para um host que você não controla envia a credencial nativa
                  do CLI para ele. Só use um servidor local ou um destino em que você confia.
                </div>
              </div>
              )}

              {campoChave && (
              <div className="field">
                <label htmlFor="api-key">
                  {campoChave.rotulo} <code>{campoChave.nome}</code>
                </label>
                <div className="budget-input-wrap">
                  <input
                    id="api-key"
                    type={mostrarChaveApi ? 'text' : 'password'}
                    disabled={bloqueado}
                    placeholder="ollama"
                    value={envDoAgente[campoChave.nome] ?? ''}
                    onChange={(e) => mudarEnv(agenteSelecionado, campoChave.nome, e.target.value)}
                  />
                  <button
                    type="button"
                    className="ghost"
                    disabled={bloqueado}
                    onClick={() => setMostrarChaveApi((v) => !v)}
                    title={mostrarChaveApi ? 'Ocultar chave' : 'Mostrar chave'}
                  >
                    {mostrarChaveApi ? '🙈' : '👁️'}
                  </button>
                </div>
                <div className="help help-warn">
                  ⚠️ Fica gravada em <strong>texto puro</strong> no banco do Hub desta máquina
                  (fora do repositório). Para um servidor local (Ollama, LM Studio) que aceita
                  qualquer valor, prefira um texto qualquer como <code>ollama</code> — não uma
                  chave de verdade. Se precisar de uma chave real, prefira o login nativo do CLI
                  ou o ambiente do próprio daemon em vez de gravar aqui.
                </div>
              </div>
              )}

              {/* Só aparece se o agente lê uma variável de modelo. O antigo campo
                  `MODEL` genérico não tinha consumidor em adapter nenhum. Modelo
                  por flag do manifesto: ver TODO em `camposDeEnvDoAgente`. */}
              {campoModelo && (
                <div className="field">
                  <label htmlFor="modelo">
                    {campoModelo.rotulo} <code>{campoModelo.nome}</code>
                  </label>
                  <input
                    id="modelo"
                    type="text"
                    disabled={bloqueado}
                    placeholder="nome do modelo no provedor"
                    value={envDoAgente[campoModelo.nome] ?? ''}
                    onChange={(e) => mudarEnv(agenteSelecionado, campoModelo.nome, e.target.value)}
                  />
                </div>
              )}

              <div className="field">
                <label>Outras variáveis de ambiente</label>
                <div className="help">
                  Prefixos aceitos pelo daemon:{' '}
                  {PREFIXOS_ENV_PERMITIDOS.map((p) => (
                    <code key={p} style={{ marginRight: 4 }}>
                      {p}*
                    </code>
                  ))}
                  . Aceito não quer dizer lido: cada CLI só obedece às variáveis que conhece — as
                  que o Hub sabe que <strong>{agenteSelecionado}</strong> lê já estão acima.
                </div>

                {extras.length > 0 && (
                  <ul className="lista-env-extra">
                    {extras.map(([chave, valor]) => (
                      <li key={chave}>
                        <code>{chave}</code>
                        <span className="valor-env-extra">{valorParaExibir(chave, valor)}</span>
                        {!variavelDocumentadaNoManifesto(chave) && (
                          <span className="aviso-inline">
                            ⚠️ nada indica que "{agenteSelecionado}" leia esta variável — pode não
                            ter efeito
                          </span>
                        )}
                        <button
                          className="ghost"
                          disabled={bloqueado}
                          onClick={() => mudarEnv(agenteSelecionado, chave, '')}
                        >
                          remover
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="env-extra-form">
                  <input
                    type="text"
                    placeholder="NOME_DA_VARIAVEL"
                    disabled={bloqueado}
                    value={novaChave}
                    onChange={(e) => setNovaChave(e.target.value.toUpperCase())}
                  />
                  <input
                    type="text"
                    placeholder="valor"
                    disabled={bloqueado}
                    value={novoValor}
                    onChange={(e) => setNovoValor(e.target.value)}
                  />
                  <button
                    className="ghost"
                    disabled={bloqueado || novaChave.trim() === '' || novoValor.trim() === ''}
                    onClick={adicionarExtra}
                  >
                    adicionar
                  </button>
                </div>
                {novaChave.trim() !== '' && !chaveEhPermitida(novaChave) && (
                  <div className="aviso-inline">
                    ⚠️ "{novaChave}" não bate com nenhum prefixo permitido — o daemon vai recusar
                    esta variável ao salvar.
                  </div>
                )}
                {novaChave.trim() !== '' && chaveEhBaseUrl(novaChave) && (
                  <div className="help help-warn">
                    ⚠️ Redirecionar esta URL pode enviar a credencial nativa do CLI (já
                    autenticado localmente) para um endpoint que você não controla — o atacante
                    recebe a chave/token de sessão e ainda pode forjar a resposta do modelo. Só
                    aponte para um servidor local (Ollama, LM Studio, vLLM) ou outro destino em que
                    você confia.
                  </div>
                )}
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

          {aba === 'discovery' && (
            <DiscoveryPanel
              agents={agents}
              projectId={projectId}
              projectName={projetoAtual?.name ?? ''}
              onNewProject={onNewProject}
            />
          )}
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

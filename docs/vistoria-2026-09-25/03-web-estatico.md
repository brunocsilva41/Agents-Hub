# 03 - Vistoria estática do painel (packages/web/src)

Método: leitura integral de todos os .tsx/.ts e leitura dirigida de styles.css (3207 linhas), cruzada com packages/daemon/src/server.ts, packages/client/src/index.ts e packages/store/src/repositories.ts. Nada foi executado no navegador; o que depende de medição visual está marcado "estimado". Caminhos relativos a `packages/`.

Contagem: CRÍTICO 0 | ALTO 4 | MÉDIO 15 | BAIXO 8

---

## ALTO

### [ALTO] Timeline mostra só os 500 PRIMEIROS eventos e perde histórico quando um evento SSE chega antes do fetch
**Evidência**
- `web/src/useHubState.ts:167-183`: `eventsOf` só busca histórico se `!events[sessionId]`. O SSE global (`hub.streamUrl()` sem sessionId) já grava `events[sessionId]` a cada evento de QUALQUER sessão viva (linhas ~123-131). Se a sessão emitiu algo depois que a página abriu, o cache existe e o histórico nunca é buscado: a timeline mostra só os eventos ao vivo desde o load.
- Quando o fetch acontece, `setEvents(prev => ({...prev, [id]: list}))` substitui o array e descarta eventos SSE que chegaram durante a requisição.
- `useHubState.ts:175` chama `hub.events(sessionId)` sem `since`/`limit`. `daemon/src/server.ts:537-541` usa `limit ?? 500`; `store/src/repositories.ts:404-407` faz `ORDER BY session_id, seq LIMIT ?` (ascendente): sessão com >500 eventos devolve os 500 mais ANTIGOS. Com SSE depois disso, fica um buraco no meio; sem SSE, nunca se vê o fim.
- O SSE do painel não usa `since` nem `Last-Event-ID` (`server.ts:684-716`: `withId` e replay só existem com `sessionId`), então uma reconexão (`source.onerror`) recarrega só o índice (`refresh`), não os eventos perdidos, apesar do comentário "preencher o buraco".
**Impacto** Timeline incompleta ou com lacuna silenciosa em sessões longas ou ativas; o operador decide (aprovar/encerrar) olhando histórico parcial.
**Correção sugerida** Ao selecionar sessão: buscar histórico sempre (paginar por `since` até esgotar, ou pedir os últimos N com opção `tail` no daemon) e MESCLAR por `seq` com o que o SSE trouxe (Map por seq) em vez de substituir. Na reconexão, para cada sessão em cache buscar `since = último seq`. Alternativa: assinar `/events?sessionId=` da sessão aberta (já tem replay + id).
**Esforço** M

### [ALTO] Ctrl/⌘+K nunca ABRE a paleta de comandos (atalho anunciado não funciona)
**Evidência** `web/src/App.tsx:495` monta `<CommandPalette>` só com `cmdOpen === true`; o listener de `keydown` (`components/CommandPalette.tsx:31-40`) mora dentro dela e, para Ctrl+K, só faz `if (isOpen) onClose()`. App.tsx não tem listener global (arquivo lido inteiro). O botão da topbar exibe `⌘K` (App.tsx:192). Na paleta há `<kbd>N</kbd>` (CommandPalette.tsx:~98) sem handler algum (controle fantasma). Também não há navegação por setas/Enter nos resultados (só clique) nem foco preso.
**Impacto** Atalho central inexistente; o rótulo "⌘" também está errado no Windows.
**Correção sugerida** Mover o `useEffect` de Ctrl/⌘+K para o `App` (`setCmdOpen(v=>!v)`), exibir `Ctrl K` conforme plataforma, remover `<kbd>N</kbd>` ou implementá-lo; adicionar setas+Enter (`role=listbox/option`, `aria-activedescendant`).
**Esforço** P

### [ALTO] Configurações: falha ao carregar o contexto de outro projeto deixa a config do projeto ANTERIOR na tela e permite gravá-la no novo
**Evidência** `components/SettingsView.tsx:85-103`: `hub.projectContext(projectId).then(...).finally(...)` sem `.catch`. Em erro, `ctx` continua com o conteúdo do projeto anterior (setCtx só roda no sucesso), `carregando` volta a false e não há mensagem (rejeição não tratada). Editar qualquer campo liga `sujo` e "Salvar" chama `hub.saveProjectContext(projectId, ctx)` (linha 113) com o `ctx` do projeto A sob o id de B, inclusive `env` com `OPENAI_API_KEY` e prompts. É o cenário que o comentário das linhas 80-84 diz evitar. Além disso, durante `carregando` os campos NÃO são desabilitados (só `aria-busy`), então digitação feita antes da resposta é sobrescrita por `setCtx(context)`.
**Impacto** Sobrescrita do `.agents-hub/config.yaml` de um projeto com dados de outro (e vazamento de chave entre repositórios versionados).
**Correção sugerida** `.catch` que faz `setCtx({})`, mostra erro e desabilita edição/salvar até recarregar com sucesso; desabilitar inputs enquanto `carregando`; limpar `ctx` no início do efeito.
**Esforço** P

### [ALTO] Topbar sem regra responsiva: abaixo de ~1100px os botões de ação ficam inalcançáveis (quebra total em <768/<600)
**Evidência** `styles.css:274-310`: `.topbar` altura fixa 52px (`height/min/max`), `.topbar-left` e `.topbar-right` com `flex-shrink:0`, sem `flex-wrap`. `topbar-left` contém marca + 5 abas com ícone+texto (`App.tsx:146-182`); `topbar-right` tem pílula de status + "Painel" + "Nova Sessão". `html, body, #root { overflow:hidden; width:100vw }` (linhas 70-80). O CSS só tem DOIS `@media` (1200px e 768px, linhas ~2640-2687) e ambos tratam só as colunas; nada para a topbar nem para <600px. Estimado: marca+abas ≈ 650px, direita ≈ 330px; em 768px e em celular "Nova Sessão", a pílula de status e "Painel" ficam cortados fora da tela, sem rolagem.
**Impacto** Em janela estreita (metade de tela, tablet, celular) não dá para abrir sessão, abrir o painel direito nem ver o status.
**Correção sugerida** `@media (max-width:1100px)`: esconder rótulos das abas e `brand-text`, `spotlight-btn` vira ícone; `@media (max-width:700px)`: `.nav-tabs` rolável horizontal ou menu; `.topbar { height:auto; flex-wrap:wrap }`. Trocar `100vh` por `100dvh`.
**Esforço** M

---

## MÉDIO

### [MÉDIO] Pausar torna a sessão impossível de encerrar/interromper/transferir pelo painel
**Evidência** `components/SidePanel.tsx:89`: `const active = state === 'running' || 'waiting_approval'`. Interromper/Pausar/Encerrar usam `disabled={!active ...}` e Transferir `!active || ...`. Mas `hub.ts` `isLiveState` inclui `paused` e `idle`, o painel os conta como "Ao Vivo" (App.tsx:117) e o Composer os aceita. O daemon aceita cancel/handoff em qualquer estado não terminal (`session-manager.ts` ~1143 e ~1187).
**Impacto** Depois de "Pausar" a sessão fica "ao vivo" segurando orçamento e o único jeito de encerrar pela UI é mandar mensagem (retomando) ou usar a CLI. Sessão `idle` também não pode ser encerrada.
**Correção sugerida** `terminal = ['completed','failed','killed'].includes(state)`; Encerrar/Transferir habilitados quando `!terminal`; Interromper e Pausar só se `running`. Adicionar botão "Retomar" (hoje a retomada só ocorre por mensagem). Encerrar também não pede confirmação.
**Esforço** P

### [MÉDIO] "ver a sessão" (Aprovações) não troca para a aba Timeline
**Evidência** `App.tsx:237-242` passa `onSelectSession={selectSession}` (só `setSelectedId` + fecha drawer, linhas 89-92). O banner de aprovações aparece em TODAS as abas; com Configurações/DAG/Swarm/Telemetria abertas o clique não muda nada visível. (Paleta e DAG fazem `setActiveTab('timeline')`, este não.)
**Impacto** Botão que parece morto na tela mais crítica (decisão pendente).
**Correção sugerida** `onSelectSession={(id)=>{selectSession(id); setActiveTab('timeline');}}`.
**Esforço** P

### [MÉDIO] Toasts de sucesso enganosos: interromper sem turno e delegação retida
**Evidência** `daemon/src/server.ts:550-558` responde `{ok:true, interrupted:false}` quando não havia turno; `SidePanel.tsx:240` sempre mostra "Turno interrompido." (resultado ignorado). `server.ts:583-603` devolve `approval` quando a política reteve a delegação; `SessionModal.tsx:129-137` mostra "Delegação iniciada." e fecha sem olhar `result.approval`. `Composer.tsx:57` ignora `mode` ('live'|'resume'|'replay'); erros do send aparecem só como texto no composer (sem toast), fora do padrão `useAction`.
**Impacto** Operador acredita que interrompeu/delegou algo que não aconteceu.
**Correção sugerida** Checar `interrupted`/`approval` no retorno e mostrar toast de aviso; usar `useAction` no Composer.
**Esforço** P

### [MÉDIO] Mensagem enviada pelo usuário nunca aparece na timeline
**Evidência** `daemon/src/session-manager.ts:1062-1110` (`send`) não emite evento para o texto do usuário (busca por `'user'`/`role` em core/daemon/adapters: nenhuma ocorrência). `Timeline.tsx:~203` tem a classe `from-user`, mas `event.agentId` é sempre truthy, então é código morto e não há CSS para ela. Sem eco local no `Composer` (limpa o campo e pronto).
**Impacto** A conversa fica com um lado só; ao reler o histórico não se sabe o que foi pedido. (Não verifiquei se algum adapter ecoa a fala do usuário; a busca acima não achou.)
**Correção sugerida** Daemon emitir `message` com `payload.role='user'` em `send`; `eventView` e Timeline renderizam bolha do usuário; no mínimo eco otimista no painel.
**Esforço** M

### [MÉDIO] Auto-scroll da timeline para de acompanhar depois de 400 eventos
**Evidência** `Timeline.tsx:39-41`: `useLayoutEffect` depende de `[shown.length, pinned]`. `shown = visible.slice(hidden)` com `WINDOW=400` tem comprimento constante (400) assim que `visible.length > 400`; novos eventos não mudam `shown.length` e o efeito não roda. O botão "Ir para o fim" também não aparece (`pinned` segue true). `pinned` também vaza entre sessões (não é resetado ao trocar).
**Impacto** Em sessão longa o operador vê o topo da janela e nada indica que há eventos novos abaixo.
**Correção sugerida** Depender de `visible.length`/`visible.at(-1)?.id` e resetar `pinned=true` quando a sessão muda.
**Esforço** P

### [MÉDIO] Falha ao buscar eventos nunca é repetida (mensagem promete retry que não existe)
**Evidência** `useHubState.ts:160-181`: `requestedRef.current.add(sessionId)` no início e nunca removido no `.catch`; `Timeline.tsx:~72` diz "Tente selecionar a sessão de novo". Reselecionar não refaz o fetch e `eventsFailed` fica true até recarregar a página.
**Impacto** Uma falha transitória de rede deixa a sessão permanentemente "falhou".
**Correção sugerida** `requestedRef.current.delete(sessionId)` no catch e botão "Tentar de novo" na tela de erro.
**Esforço** P

### [MÉDIO] "Nova Sessão" pré-seleciona o PRIMEIRO projeto (não o filtrado); formulário perde dados ao registrar pasta; agente não instalado pode ser pré-selecionado
**Evidência** `SessionModal.tsx:77-79` `setProjectId(current => current || list[0]?.id)`; App.tsx não passa `selectedProjectId` ao modal (App.tsx:466-481). O modal faz sua própria requisição `/projects` em vez de usar `state.projects`. "+ Registrar nova pasta" (linhas 174-183) faz `onClose()` (descarta objetivo/critérios) e, ao criar o projeto (`App.tsx:484-493`), NÃO reabre o modal. A paleta lista agentes não instalados (`CommandPalette.tsx` grupo "Iniciar com Agente", sem checar `probe.installed`) e `SessionModal.tsx:60-64` aceita `defaultAgentId` mesmo ausente: o cartão fica `disabled`, mas `agent` já está setado e "Iniciar" habilitado, falhando depois com erro de binário. Rótulos "Agente/Supervisão/Isolamento/Teto" sem `htmlFor`. `min/max` do orçamento (0.10/50) não são validados no submit; `"0"` é truthy e cria orçamento zero.
**Impacto** Sessão que escreve no projeto errado (risco real com vários projetos); perda de texto digitado; falha tardia.
**Correção sugerida** Passar `defaultProjectId={selectedProjectId !== 'all' ? selectedProjectId : undefined}`; receber `projects` por props; reabrir o modal após criar projeto; validar `estaInstalado(defaultAgentId)`; validar orçamento (>0, dentro do range).
**Esforço** P

### [MÉDIO] ProjectModal: falha parcial não atualiza a lista nem seleciona o projeto, e "tentar de novo" repete trabalho
**Evidência** `ProjectModal.tsx:43-72`: se alguma pasta extra falha, lança `Error` DEPOIS de criar o projeto e gravar diretrizes; `onCreated` (que faz `state.refresh()` e seleciona o projeto, App.tsx:487-491) nunca roda; o modal permanece aberto com erro. Clicar de novo chama `hub.addProject` outra vez e reenvia as mesmas pastas (as já vinculadas devem recusar por sobreposição). A lista só atualiza no próximo evento SSE estrutural. Também `nomeDaPasta` (linha 12) usa `/[\/]/`, que não divide por `\` no Windows (usada se o usuário apagar o campo Nome).
**Impacto** Estado inconsistente e confuso após erro parcial.
**Correção sugerida** Chamar `onCreated(project.id)` sempre que o projeto existir e exibir as recusas como toast; corrigir para `/[\\/]/`.
**Esforço** P

### [MÉDIO] Modais sem acessibilidade/teclado: sem Esc, sem foco preso, sem nome, clique no fundo descarta o formulário
**Evidência** `SessionModal.tsx:143-149`, `ProjectModal.tsx:78-84`: `role="dialog" aria-modal` sem `aria-labelledby`; sem handler de Escape (só a paleta tem); sem trap/restauração de foco (só `autoFocus` no ProjectModal); `onClick={onClose}` no backdrop fecha e perde tudo. Tab vaza para o app por trás. `CommandPalette` também sem trap.
**Impacto** Navegação por teclado e leitores de tela quebradas; perda acidental de dados ao clicar fora.
**Correção sugerida** Componente `Modal` comum (Esc, trap, `aria-labelledby`, devolver foco, confirmar descarte se sujo) ou `<dialog>` nativo com `showModal()`.
**Esforço** M

### [MÉDIO] Gavetas responsivas: ambas podem abrir juntas e se sobrepor, ficam focáveis fechadas e cobrem o banner de aprovações
**Evidência** `styles.css:~2640-2687`: `.col-right` (≤1200px) e `.col-left` (≤768px) viram `position:fixed; z-index:8; width:min(340px,90vw)` com `top:60px`. `App.tsx` mantém `flowsOpen` e `panelOpen` independentes (linhas 35-36): entre 375 e ~680px de largura, abrir os dois empilha duas gavetas de 340px uma sobre a outra. Fechadas usam só `transform: translateX(±120%)`: continuam na ordem de Tab e na árvore de acessibilidade (sem `visibility:hidden`/`inert`/`aria-hidden`). Sem backdrop, sem fechar por Esc/clique fora. `top:60px` ignora a altura variável do banner de aprovações (até 200px) e do `error-banner`, então a gaveta aberta cobre "Liberar/Negar" que ficam à direita.
**Impacto** Sobreposição visual, foco em elementos invisíveis, aprovações escondidas.
**Correção sugerida** Fechar uma ao abrir a outra; `visibility:hidden` (com transition) + `inert` quando fechada; backdrop clicável e Esc; posicionar a gaveta com `position:absolute` dentro de `.columns` em vez de `fixed top:60px`.
**Esforço** M

### [MÉDIO] Overflow/quebra de layout em larguras <900px e <600px (só há 2 breakpoints)
**Evidência**
- `styles.css:~1583` `.section-header-row` sem `flex-wrap`: h3 "Orçamento do fluxo" + dois `.burn-rate-chip` (`white-space:nowrap`, ambos renderizados quando `burnRate>0`, `SidePanel.tsx:112-124`) somam ~365px (estimado) numa coluna de ~268px úteis; `.scroll` tem `overflow-x:hidden` e a projeção fica cortada.
- `styles.css:~1902` `.swarm-grid minmax(340px,1fr)` com `.tab-view-container` padding 32px: em 375px a coluna útil é 311px < 340px, cartão cortado (overflow-x hidden).
- `styles.css:~3008` `.settings-layout {grid-template-columns:240px 1fr}` sem media query e `.settings-header` (~2989) sem wrap: em <900px o conteúdo (inputs, `env-extra-form`, `tabela-modos`) aperta/estoura; `.settings-nav` de 240px sempre ocupa a esquerda. `.disc-dl` fixo em `140px 1fr`.
- `.col-header` altura fixa 50px com `overflow:hidden` (~662): com "Esta sessão/Fluxo inteiro" + "Resumido/Detalhado" (`head-actions`, `flex-shrink:0`) o título da sessão encolhe até sumir em colunas estreitas.
- `.dag-nodes-lane {overflow-x:auto}` (~2125) corta o `translateY(-2px)` e o glow do card no hover/ativo.
- `.metrics-grid` 3 colunas em 300px com fontes 9-11px: valores com `text-overflow:ellipsis` (ex.: `US$ 12.3456`) truncam.
**Impacto** Conteúdo cortado sem rolagem em janelas estreitas.
**Correção sugerida** `@media (max-width:900px)` e `(max-width:600px)`: settings com nav em abas horizontais; swarm `minmax(min(340px,100%),1fr)`; header do painel com `flex-wrap`; `.col-header` `height:auto`; `.metrics-grid` 1-2 colunas.
**Esforço** M

### [MÉDIO] Estados vazios/erro ausentes ou enganosos
**Evidência**
- `components/FlowList.tsx:60-72`: com 0 fluxos (filtro "Ativos", busca sem resultado, daemon vazio) renderiza `<div>` vazio, sem mensagem nem CTA. Com o filtro padrão `active` (App.tsx:33) quem só tem sessões concluídas vê a barra lateral em branco.
- `Timeline.tsx:83-95`: sem sessão selecionada (App passa `events=[]`) mostra "Nenhum evento visível nesta sessão / ative detalhado" (mensagem errada); existe CSS `.timeline-unselected-state` (styles.css:~1436) nunca usado.
- `loading={!state.ready}` (App.tsx:436) é global; não há carregamento por sessão (fetch em curso mostra "nenhum evento").
- `useBudget` (`useHubState.ts` ~283-289) engole erro e devolve `null`: o bloco de orçamento some sem aviso.
- `state.error` (App.tsx:230) aparece só como banner, sem "tentar de novo".
**Impacto** O operador não distingue vazio, carregando e falha.
**Correção sugerida** Empty state em `FlowList` (com "ver todos"/"Nova sessão"), usar `.timeline-unselected-state` quando `!selected`, carregamento por sessão, `budgetFailed` visível.
**Esforço** P

### [MÉDIO] Aba "Grafo DAG" não é um grafo, não é operável por teclado e ignora o filtro de projeto
**Evidência** `components/DagCanvasView.tsx`: desenha uma raiz e UMA faixa horizontal com todas as demais sessões após "➔", sem arestas pai/filho (não usa `hub.graph`, que devolve a árvore com `children` e custo/tokens por nó, usada só em `FlowTree`). Rótulos fixos "Root Coordinator"/"Sub-agent / Task"; `dot running` fixo em todo cluster (linha ~53, mesmo fluxo concluído); custo/orçamento ausentes. Cartões são `<div onClick>` sem `role/tabIndex/onKeyDown` (linhas ~82 e ~122). Recebe `state.flows` sem o filtro de projeto de App.tsx:95-115.
**Impacto** Delegações em cadeia (A→B→C, handoffs) ficam indistinguíveis de irmãos; aba enganosa; inacessível por teclado.
**Correção sugerida** Usar `hub.graph(rootId)` e desenhar árvore/SVG com arestas por `parentId` (delegação vs handoff), estado real e custo; cartões como `<button>`; aplicar o filtro de projeto.
**Esforço** G

### [MÉDIO] Vite dev: `/discovery` não está no proxy; aba "Agentes detectados" quebra em `npm run dev`
**Evidência** `web/vite.config.ts:6-17` `API_ROUTES` não lista `/discovery`, e `hub.ts` (`fetchDiscovery`/`refreshDiscovery`, ~173-183) chama `/discovery` na mesma origem. No servidor de dev (porta 4748) a rota cai no fallback do Vite (HTML) e `call()` lança `RESPOSTA_NAO_JSON`. (`/projects/:id/import` funciona, coberto por `/projects`.) Em produção (daemon serve o build) funciona.
**Impacto** Falha só em desenvolvimento; confunde diagnóstico.
**Correção sugerida** Adicionar `'/discovery'` a `API_ROUTES`. Trocar `fetchDiscovery/refreshDiscovery/importFromAgent` pelos métodos que o `HubClient` já tem (`discovery`, `discoverAgent`, import em `client/src/index.ts:96-118`); o comentário de `hub.ts` ("ainda não estão no HubClient") está desatualizado.
**Esforço** P

### [MÉDIO] Configurações: alterações não salvas somem sem aviso; "Modelos locais" pode conter controles fantasma
**Evidência** `SettingsView.tsx`: `sujo` é zerado ao trocar de projeto (linha ~94) e o componente desmonta ao trocar de aba do topo (App.tsx:245-248), perdendo edições sem confirmação/`beforeunload`. A aba "Modelos locais" (linhas ~348-427) grava `OPENAI_BASE_URL`, `OPENAI_API_KEY` e `MODEL` no env do projeto para o agente escolhido, mas oferece o mesmo bloco a TODOS os agentes (inclui claude/gemini, que não leem `OPENAI_*`). `MODEL` não tem consumidor em nenhum adapter (grep em `adapters/src`: só `discovery/claude.ts` e `discovery/openclaude.ts` citam; `core/src/agent-env.ts:70` apenas o permite). O aviso "manifesto não documenta" só vale para variáveis extras, não para os três campos fixos. Valores extras aparecem em texto claro (`valor-env-extra`, linha ~448) mesmo se forem chaves.
**Impacto** Perda de edição; o usuário acredita ter configurado o modelo e nada muda.
**Correção sugerida** Confirmar ao sair com `sujo`; mostrar o bloco só para agentes cujo manifesto declare base URL/modelo; mascarar valores de chaves (`*_KEY`, `*_TOKEN`) na lista.
**Esforço** M

### [MÉDIO] Cobertura do painel vs. sistema: faltam superfícies (ver seção F)
Resumo: workflow, prune/sweep, mcp/hooks, doctor/health, adopt/detach, diff/artifacts/tasks por sessão, budget editável, pastas do projeto pós-criação, re-sondagem de agentes. Detalhe em "F. Superfícies sem painel" abaixo.

---

## BAIXO

### [BAIXO] Abas superiores com ARIA inválido e controles sem nome acessível
**Evidência** `App.tsx:146`: `<nav role="tablist">` com `<button>` sem `role="tab"`, `aria-selected` nem `tabpanel` (`SettingsView.tsx:560-566` usa `role=tab` mas também sem `tabpanel`). `flows-toggle` (App.tsx:124-134) contém só um SVG, sem `aria-label`. Botão "+" (App.tsx:325-331) só tem `title`. O campo de busca da barra lateral (linha 336) e `select.project-dropdown` (294) sem `<label>`/`aria-label`. Elementos clicáveis que são `div`: marca (App.tsx:136), cabeçalho "Memória & Contexto" (`SidePanel.tsx:184-188`, sem `aria-expanded`), cabeçalho de raciocínio (`Timeline.tsx` ~130), cartões DAG. Emojis usados como ícone sem `aria-hidden`.
**Impacto** Leitor de tela/teclado não operam esses controles.
**Correção sugerida** `aria-current="page"` ou `role=tab` completo, `aria-label` nos ícones, trocar `div onClick` por `button`.
**Esforço** P

### [BAIXO] Contraste e movimento
**Evidência** `styles.css:29` `--text-faint:#64748b` sobre `--bg:#06080d`/`--bg-panel:#0d121c` dá ~4,0-4,2:1 (estimado por cálculo de luminância), abaixo de 4,5:1, e é usado em textos de 9-11px (`.metric-label`, `.ev-time`, `.flow-when`, `.budget-rest-label` 9px). Não há `prefers-reduced-motion` (pulsos `pulseDot`, `shimmer`, radar); `<meta name="color-scheme" content="dark light">` mas só existe tema escuro.
**Correção sugerida** Clarear `--text-faint` (~#8593a8) e `@media (prefers-reduced-motion: reduce)` desligando animações.
**Esforço** P

### [BAIXO] Fontes via Google Fonts em painel local
**Evidência** `styles.css:6` `@import url('https://fonts.googleapis.com/...')`. Offline ou com rede restrita atrasa o carregamento (há fallback) e faz requisição a terceiro a cada abertura de um painel que controla agentes locais.
**Correção sugerida** Empacotar as fontes (fontsource) ou usar só a pilha do sistema.
**Esforço** P

### [BAIXO] Lista de fluxos: fluxo selecionado não pode ser recolhido
**Evidência** `FlowList.tsx:~64`: `open = expanded.has(rootId) || rootId === selectedRootId`; o botão alterna `expanded`, mas a raiz selecionada continua aberta com `aria-expanded=true`. O clique parece sem efeito.
**Esforço** P

### [BAIXO] Botões: `margin-left:4px` global e `transform` no hover
**Evidência** `styles.css:~112-121` `button {margin-left:4px}` e `button:hover {transform:translateY(-1px)}` (~131-135) valem para todo botão, gerando deslocamento de 4px em linhas de botões e "tremor" em listas; muitos componentes anulam com `transform:none !important` (ex.: `.nav-tab`, `.toast-close`, `.settings-nav-btn`), sinal de regra global ampla demais.
**Esforço** P

### [BAIXO] Toasts: fila sem teto e sem "dispensar todos"
**Evidência** `actions.ts:20-41`: erro persiste até fechar; N ações falhas empilham N toasts fixos no canto inferior direito (`.toasts` `position:fixed; bottom:16px; z-index:100`), podendo cobrir o Composer/botão "Enviar" em telas baixas.
**Esforço** P

### [BAIXO] Telemetria rasa e inconsistente com o resto
**Evidência** `TelemetryView.tsx:12-16`: "Ativas" conta só `running|waiting_approval`, enquanto a pílula "Ao Vivo" (App.tsx:117) e a lista usam `isLiveState` (inclui `paused`/`idle`). "Taxa de Conclusão" = concluídas/total (inclui sessões em andamento; sem sessões mostra 100%). Sem custo (USD), tokens, falhas, tempo nem orçamento por fluxo, embora `hub.budget`/`hub.graph` existam. Prop `agents` recebida e não usada. O subtítulo "Execuções registradas no banco" é só a lista em memória.
**Correção sugerida** Usar `isLiveState`; somar `graph.usd/tokens` por fluxo; adicionar falhas/killed e gráfico simples de custo.
**Esforço** M

### [BAIXO] Código morto/duplicado e atalho "/" global
**Evidência** `.from-user` sem CSS; `.timeline-unselected-state` sem uso; `hub.ts` (~140-188) duplica `HubClient.discovery*/import*`. O listener global de "/" (`Composer.tsx:31-42`) também dispara com modal aberto quando o foco está num botão/`body`, movendo o foco para o campo escondido pelo backdrop.
**Esforço** P

---

## F. Superfícies do daemon/CLI sem nenhuma tela no painel
O painel usa apenas: sessions, agents, approvals (list + resolve), projects (list/add), folders (add), context (get/put), events, graph, budget, sessions start/delegate/send/interrupt/pause/cancel/handoff, discovery/import e o SSE `/events`. Confirmado por grep: `hub.health`, `probeAgents`, `adopt`, `detach`, `task`, `diff`, `artifacts`, `tasks`, `approval`, `context(ref)`, `folders`, `removeFolder`, `sweep`, `shutdown` não são chamados em `web/src`.

Para cobrir 100% faltam:
1. **Diff e artefatos da sessão** (`GET /sessions/:id/diff`, `/artifacts`): visualizador de diff por sessão (o principal resultado do trabalho do agente) e lista de artefatos.
2. **Tarefas da sessão / status de tarefa** (`/sessions/:id/tasks`, `/tasks/:id`): tentativas, retentativas, estado, motivo de falha.
3. **Workflow** (`hub workflow validate|run`): editor/upload de YAML, validação (ciclos/dependências), execução em lotes com progresso.
4. **Manutenção** (`hub prune`, `POST /maintenance/sweep`): botão "recolher worktrees expirados" com prévia do que será removido.
5. **MCP e hooks** (`hub mcp`, `hub hooks`, gate `POST /hooks/pretooluse`): status do gate PreToolUse por agente, instalação (com prévia; escrita só com confirmação), registro do MCP do Hub nos CLIs.
6. **Saúde/diagnóstico** (`GET /health`, `hub doctor`, `hub status`): versão, home, sessões vivas, assinantes SSE, resultado de `doctor`. A UI só tem a pílula conectado/desconectado.
7. **Sondagem de agentes** (`POST /agents/probe`): botão "re-sondar" no Swarm; instalar um CLI só passa a constar quando o cache do daemon expira.
8. **Adoção/desanexação** (`POST /sessions/adopt`, `/sessions/:id/detach`): listar agentes externos conectados e desanexar.
9. **Projetos**: listar/remover pastas vinculadas (`GET/DELETE /projects/:id/folders[/:folderId]`) depois da criação; renomear/remover projeto (também não há rota de delete no daemon); editar pasta principal.
10. **Orçamento**: editar teto (USD/tokens/tempo) do fluxo, ver reservas por delegação; hoje é só leitura, e supervisão/isolamento não são editáveis depois de criar a sessão.
11. **Aprovações**: histórico das resolvidas (`GET /approvals` com filtro, `GET /approvals/:id`), campo `by`, lote, confirmação extra para risco `high/critical`.
12. **Contexto por referência** (`GET /context?ref=`): abrir o contexto de um evento/tarefa citado.
13. **Busca/exportação de eventos**: filtro por tipo, busca de texto, exportar JSON/MD da sessão.
14. **Eventos por fluxo** (`/events?rootId=`, `since`): não usados; o painel mantém um SSE global sem replay.
15. **Renomear sessão**, **retomar sessão pausada** (hoje só por mensagem), **retry/substituição de agente (fallback)** sem ação explícita.
16. **Shutdown do daemon** (`POST /shutdown`) e **API de automação** (`/api/tasks`, `/api/descriptor.json`): deixados fora do proxy do Vite de propósito (vite.config.ts:19-23). Manter fora, no máximo um link para o descriptor.

---

## Verificado OK (leitura estática)
- Todos os `onClick` dos botões principais têm handler real e chamam rota existente: interrupt/pause/cancel/handoff/delegate/send/approvals/:id/projects/folders/context/import/discovery/graph/budget/events/sessions conferidos contra `server.ts` e `client/src/index.ts`. Nenhum botão com handler vazio nem chamada a rota inexistente (o problema é de dois controles sem handler: `<kbd>N</kbd>` e o atalho Ctrl+K, descritos acima).
- `import` roda `dryRun` por padrão e o painel exige prévia e confirmação antes de aplicar (`DiscoveryPanel.tsx` ~339-357, 461-481); valores de env de MCP nunca são exibidos.
- Erros de ação centralizados em `useAction`/toasts, com `describeError` tratando 403 (origem), 422 (`issues`) e resposta não-JSON.
- Guarda contra corrida em `SidePanel` (flag `cancelado`), `useFlowGraph` e `useBudget` (busca pela raiz do fluxo, correto).
- Merge de timeline de fluxo ordena por `ts` e deduplica por `id`; teto de 12 sessões-irmãs evita rajada de requisições.
- Agrupamento de fluxos por `rootId` e estado mais urgente por fluxo estão corretos.
- Modais empilhados: nunca há dois modais de sessão/projeto ao mesmo tempo ("registrar nova pasta" fecha o primeiro); toasts (z-index 100, depois no DOM) ficam acima dos backdrops (também 100); z-index da topbar (20) e gavetas (8) não conflitam com modais.
- Foco visível global (`:focus-visible`) e anel de foco em inputs; `sr-only` implementado; regiões `role=alert/status` nos erros; `Approvals` usa `aria-live`.
- Path traversal do servidor estático tratado (`daemon/src/static.ts`); nenhum `dangerouslySetInnerHTML` no painel.

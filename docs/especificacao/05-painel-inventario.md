# SPEC-05 — Inventário funcional do painel

Especificação congelada do painel web em TS/React, para a UI nativa em C ter **paridade total**
([ADR 07](../decisoes/07-reescrita-nativa.md), 7.3 e 7.4). Descreve **o que** a interface faz: telas,
dados, controles, rotas, validações, estados e textos. O visual (CSS) entra só como tokens de tema,
breakpoints e o que é exigido de acessibilidade.

- **Base:** lida em `main @ 82f40cc` em 2026-09-30 e revalidada em `main @ fe69182`
  (`git diff 82f40cc..fe69182 -- packages/web packages/client` vazio). Nada foi executado (sem daemon, sem navegador).
- **Leitura:** 33 arquivos de componente `.tsx` (`App.tsx` + 26 em `components/` + 6 em
  `components/ops/`), 6 hooks (`useHubState.ts`, `useFlowGraphs.ts`, `useDialog.ts`,
  `useMediaQuery.ts`, `ops/useAcao.ts`, `ops/useCarga.ts`), `actions.ts`, `hub.ts`, `theme.ts`,
  `main.tsx`, `logic/*.ts` (7 de produção), `lib/*.ts` (16 de produção, sem `fakeClock.ts`, que só serve aos testes) e os trechos de tema e
  `@media` dos 4 arquivos CSS. Testes (`*.test.ts`, `e2e/`) não foram lidos.
- **Controles listados:** 198 (linhas `C001`–`C198`; controle que se repete por item de lista — um
  botão por aprovação, um cartão por agente — conta uma vez).
- **Convenção de citação:** `arquivo:linha` é relativo a `packages/web/src/`, salvo quando o
  caminho começa com `packages/`. As rotas HTTP foram conferidas em `packages/client/src/index.ts`
  (o `HubClient` que o painel usa, `hub.ts:7`).

## 1. Estrutura geral da janela

A janela tem, de cima para baixo: topbar, banner de erro do índice, fila de aprovações, cartão de
boas-vindas, a área da aba ativa, modais e a fila de toasts (`App.tsx:272-877`).

| Faixa | Quando aparece | Fonte |
|---|---|---|
| Topbar | sempre | `App.tsx:280-455` |
| Banner "Falha ao atualizar dados do Hub" | `state.error` não nulo | `App.tsx:461-468` |
| Fila de aprovações | há aprovação pendente; em **todas** as abas | `App.tsx:471-479`, `components/Approvals.tsx:43` |
| Boas-vindas (Onboarding) | índice de projetos carregado, zero projetos, não dispensado, aba ≠ Configurações | `App.tsx:482-490`, `logic/settings-form.ts:202-204` |
| Área da aba | uma das 7 abas | `App.tsx:493-816` |
| Modais | Nova Sessão/Delegar, Registrar projeto, Paleta | `App.tsx:819-873` |
| Toasts | sempre montado; some sem avisos | `App.tsx:875`, `components/Toasts.tsx:14` |

### 1.1 Mapa de abas

Sete abas, na ordem da topbar (`App.tsx:262-270`). O rótulo de Swarm traz o total de agentes.

| Id | Rótulo | Ícone | Conteúdo |
|---|---|---|---|
| `timeline` | Timeline | 💬 | 3 colunas: fluxos, timeline, painel (§5) |
| `dag` | Grafo DAG | 🕸 | `DagCanvasView` (§7) |
| `swarm` | `Swarm (N)` | 🤖 | `AgentSwarmView` (§6) |
| `telemetry` | Telemetria | 📊 | `TelemetryView` (§8) |
| `operation` | Operação | 🛠 | `OperationView` com 5 seções (§9) |
| `settings` | Configurações | ⚙️ | `SettingsView` com 5 subabas (§11) |
| `security` | Segurança | 🔐 | `SecurityView` com 5 seções (§10) |

Aba inicial: `timeline` (`App.tsx:62`). **Toda** troca de aba passa por `setActiveTab`, que pergunta
antes de sair com edição não salva em Configurações ou no editor de política:
`"Há alterações não salvas nesta aba. Sair e descartá-las?"` (`App.tsx:71-79`,
`logic/security.ts:317-326`). Cancelar mantém a aba.

**Filtro de projeto compartilhado.** Um único `selectedProjectId` (`'all'` = todos) é usado pela
lista de fluxos, pelo DAG, pela Telemetria e pela Segurança, e pré-seleciona o projeto da Nova
Sessão (`App.tsx:60`, `:541-542`, `:571-572`, `:510-511`, `:824`).

**Sessão selecionada compartilhada.** `selectedId` é o mesmo na Timeline, no DAG e na Operação
(`App.tsx:46`, `:534`, `:556-557`).

## 2. Rotas HTTP e SSE usadas pelo painel

Todas as chamadas saem do `HubClient` na mesma origem do daemon (`hub.ts:7`).

| Método e rota | Método do cliente | Usado por |
|---|---|---|
| `GET /health` | `health` (`index.ts:115-117`) | Operação › Saúde |
| `GET /agents` | `agents` (`:119-121`) | índice (`useHubState.ts:148`) |
| `POST /agents/probe` | `probeAgents` (`:123-125`) | Operação › Saúde |
| `GET /projects` | `projects` (`:128-130`) | índice; modal Nova Sessão |
| `POST /projects` | `addProject` (`:132-134`) | modal Registrar projeto |
| `GET /discovery` | `discovery` (`:138-140`) | Configurações › Agentes detectados (o painel nunca passa `refresh`: `DiscoveryPanel.tsx:67`; releitura só por `/discovery/:id`) |
| `GET /discovery/:agentId?refresh=1` | `discoverAgent` (`:142-144`) | idem |
| `POST /projects/:id/import` | `importFromAgent` (`:147-159`) | idem (prévia e aplicar) |
| `POST /projects/:id/trust` | `setProjectTrusted` (`:162-167`) | Segurança › Confiança |
| `GET /sessions` | `sessions` (`:170-174`) | índice |
| `POST /sessions` | `startSession` (`:184-195`) | modal Nova Sessão |
| `POST /sessions/adopt` | `adopt` (`:198-206`) | Operação › Projeto |
| `POST /sessions/:id/detach` | `detach` (`:208-210`) | Operação › Projeto |
| `POST /sessions/:id/delegate` | `delegate` (`:221-223`) | modal Delegar |
| `POST /sessions/:id/send` | `send` (`:225-227`) | compositor |
| `POST /sessions/:id/interrupt` | `interrupt` (`:233-235`) | painel da direita |
| `POST /sessions/:id/pause` | `pause` (`:237-239`) | painel da direita |
| `POST /sessions/:id/cancel` | `cancel` (`:241-243`), corpo `{reason:'via painel'}` | painel da direita |
| `POST /sessions/:id/handoff` | `handoff` (`:245-251`) | painel da direita |
| `GET /sessions/:id/diff` | `diff` (`:259-261`) | Operação › Sessão |
| `GET /sessions/:id/artifacts` | `artifacts` (`:263-265`) | Operação › Sessão |
| `GET /sessions/:id/tasks` | `tasks` (`:267-269`) | Operação › Sessão |
| `GET /sessions/:id/events?tail=1&limit=500` / `?before=N&limit=500` / `?since=N&limit=5000` | `events` (`:443-451`) | timeline (`lib/eventHistory.ts:92`, `:124-125`, `:150`) |
| `GET /approvals` | `approvals` (`:272-274`) | índice |
| `POST /approvals/:id` `{decision}` | `resolveApproval` (`:284-289`) | fila de aprovações |
| `GET /policy[?projectId=]` | `policy` (`:296-300`) | Segurança › Política |
| `PUT /policy[?dryRun=1]` | `setGlobalPolicy`/`previewGlobalPolicy` (`:305-335`) | idem |
| `PUT /projects/:id/policy[?dryRun=1]` | `setProjectPolicy`/`previewProjectPolicy` (`:318-345`) | idem |
| `GET /audit?…` | `audit` (`:348-358`) | Segurança › Aprovações e Auditoria |
| `GET /integrations[?projectId=]` | `integrations` (`:361-368`) | Segurança › Gate e MCP |
| `POST /integrations/:agentId/:tipo` `{dryRun,base?,projectId?}` | `planIntegration`/`applyIntegration` (`:371-398`) | idem |
| `POST /maintenance/sweep` | `sweep` (`:426-435`) | Operação › Manutenção |
| `GET /projects/:id/folders` | `folders` (`:460-462`) | Operação › Projeto |
| `POST /projects/:id/folders` | `addFolder` (`:464-473`) | Operação › Projeto; modal Registrar projeto |
| `DELETE /projects/:id/folders/:folderId` | `removeFolder` (`:475-480`) | Operação › Projeto |
| `GET /projects/:id/context` | `projectContext` (`:486-490`) | painel da direita, Configurações, Confiança |
| `PUT /projects/:id/context` | `saveProjectContext` (`:492-497`) | Configurações; modal Registrar projeto |
| `GET /graph/:rootId` | `graph` (`:499-501`) | lista de fluxos, DAG, Telemetria |
| `GET /budget/:rootId` | `budget` (`:503-505`) | painel da direita, Operação › Sessão |
| `PUT /budget/:rootId` `{limits}` | `setBudget` (`:511-516`) | Operação › Sessão |
| `POST /workflows/validate` | `validateWorkflow` (`:520-522`) | Operação › Workflow |
| `POST /workflows/runs` | `startWorkflow` (`:525-532`) | idem |
| `GET /workflows/runs` | `workflowRuns` (`:534-536`) | idem |
| `GET /events` (SSE, sem filtro) | `streamUrl` (`:543-545`) | estado ao vivo (`useHubState.ts:203`) |

Métodos do cliente que o painel **não** chama (conferido por busca em `packages/web/src`): `session`,
`heartbeat`, `task`, `approval`, `context`, `gateToolCall`, `shutdown`, `backup`, `workflowRun`,
`stream` (o painel usa `EventSource` com `streamUrl`).

**Autenticação.** O navegador recebe o token de operador num cookie `HttpOnly` `hub_operator` ao
carregar o documento (`packages/daemon/src/server.ts:276-281`,
`packages/daemon/src/operator-auth.ts:210-225`); o painel não manipula token nenhum. O cliente
aceita `Authorization: Bearer` (`packages/client/src/index.ts:109-112`). Ver §16.

## 3. Estado ao vivo

### 3.1 Carga do índice

O índice tem quatro recursos: sessões, aprovações, projetos e agentes (`lib/indexStatus.ts:14`).

- **Carga inicial:** os quatro, cada um por si (`Promise.allSettled`) — a falha de um não descarta
  os outros (`useHubState.ts:142-162`, `:198-200`).
- **`refresh()`** (botões "Tentar de novo", depois de ações): sessões, aprovações e projetos;
  agentes só se ainda não carregaram ou se a última tentativa falhou (`useHubState.ts:196`,
  `lib/indexStatus.ts:98-100`).
- **Por recurso** guarda-se "já carregou" e "última falha" (`lib/indexStatus.ts:23-55`). Cada tela
  pede a sua situação: `erro` (falhou e nunca carregou), `carregando`, `vazio` ou `ok`
  (`lib/indexStatus.ts:70-78`). Falha de uma **recarga** com dado antigo na tela não vira `erro`;
  aparece só no banner global, com o nome do recurso (`lib/indexStatus.ts:88-91`,
  `App.tsx:461-468`).

### 3.2 Assinatura SSE

Um único `EventSource` em `GET /events`, sem filtro, alimenta tudo (`useHubState.ts:202-247`).

- Frame: `data: <EventEnvelope JSON>` (com `id:` opcional), sem nome de evento
  (`packages/daemon/src/sse.ts:62-65`); o painel lê em `onmessage` e ignora JSON inválido
  (`useHubState.ts:223-229`).
- `onopen` → conectado. `onerror` → desconectado e marca "caiu" (`useHubState.ts:208-222`).
- **Reconexão:** ao reabrir depois de uma queda, recarrega o índice **com** agentes, repõe o buraco
  de cada timeline já carregada (`since=<último seq>`, limite 5000) e invalida grafo/orçamento
  (`useHubState.ts:210-217`, `lib/eventHistory.ts:116-135`). O `/events` global não tem replay.
- A pílula da topbar mostra `N ao vivo` conectado ou `Desconectado` (`App.tsx:374-392`).

### 3.3 O que cada evento faz

Todo evento entra na timeline da sua sessão (`useHubState.ts:231`) e passa pelo notificador de
aprovação (`:232`). Só eventos **estruturais** recarregam o índice (`lib/hubEvents.ts:11-28`):
`session.started`, `session.ended`, `session.handoff`, `user.message`, `delegation.requested`,
`delegation.completed`, `approval.requested`, `approval.resolved`, `turn.completed`,
`budget.exceeded`, `budget.warning`, `error`.

Num evento estrutural (`useHubState.ts:234-241`):

1. **Patch imediato** só do que o evento afirma: `session.ended` com `payload.state` terminal troca o
   estado; `approval.requested` põe `waiting_approval` numa sessão não terminal; `updatedAt` avança
   para o `ts` do evento. Nenhum estado é deduzido (`lib/hubEvents.ts:49-71`).
2. A raiz do fluxo é marcada como "tocada" (ou `*` se a sessão é desconhecida).
3. **Recarga agrupada:** `GET /sessions` + `GET /approvals`, debounce de 300 ms contado do último
   pedido, no máximo 1500 ms depois do primeiro; nunca duas buscas em voo — o que chega durante
   uma busca gera exatamente mais uma (`useHubState.ts:165-194`,
   `lib/refetchScheduler.ts:48-123`). Agentes e projetos **não** são relidos por evento.
4. Grafo e orçamento sobem de revisão **só** no fluxo tocado (`revisionOf`); raiz `*` sobe a revisão
   geral (`useHubState.ts:174-182`, `:280-283`).

### 3.4 Fluxos

Um fluxo = sessões com o mesmo `rootId` (não `parentId === null`: handoff cria irmã sem pai)
(`useHubState.ts:292-321`). Por fluxo: sessões da mais recente para a mais antiga, agentes
distintos, título (da raiz), **estado mais urgente** (`waiting_approval` < `running` < `paused` <
`idle` < `failed` < `killed` < `completed`, `hub.ts:80-101`), `live`, `updatedAt`. Ordem da lista:
vivos antes, depois o mais recente (`useHubState.ts:318-320`).

"Ao vivo" = `running`, `waiting_approval`, `paused` ou `idle` — a mesma definição na pílula, na lista
e na telemetria (`lib/sessionControls.ts:23-25`).

### 3.5 Histórico da timeline (paginação, recentes primeiro)

Uma timeline por sessão, sem React (`lib/eventHistory.ts:35-190`).

- **Primeira busca:** a página **mais recente** (`tail=1`, `limit=500`) (`lib/eventHistory.ts:150`,
  `lib/eventMerge.ts:19`). Disparada quando a sessão é mostrada pela primeira vez
  (`useHubState.ts:251-263`).
- **Mescla por `seq`**, nunca substitui: o que o SSE trouxe durante a busca fica
  (`lib/eventHistory.ts:152-154`, `lib/eventMerge.ts:29-49`). Duplicado ao vivo é ignorado
  (`lib/eventMerge.ts:69-90`).
- **Teto ao vivo:** 3000 eventos por sessão; passou, corta o começo e marca "há anteriores"
  (`lib/eventMerge.ts:16`, `:88`; `lib/eventHistory.ts:78`).
- **Anteriores:** `before=<menor seq>`, `limit=500`; página cheia = provavelmente há mais
  (`lib/eventHistory.ts:84-101`, `lib/eventMerge.ts:120-122`).
- **Falha:** até 5 tentativas automáticas com espera 1, 2, 4, 8, 16 s (teto 30 s); depois só pelo
  botão (`lib/eventMerge.ts:135-146`, `lib/eventHistory.ts:161-177`). "Tentar de novo" zera o
  contador (`lib/eventHistory.ts:104-109`).
- **Fluxo inteiro:** junta as timelines de até 12 sessões do fluxo (as mais recentes), ordena por
  `ts` e depois `seq`, sem duplicar por `id` (`App.tsx:97-114`, `useHubState.ts:483`, `:493-499`).
  Carregar anteriores pede a página de cada sessão que ainda tem; tentar de novo refaz só as que
  falharam (`useHubState.ts:519-536`).

**Janela de desenho:** só os últimos 400 eventos visíveis vão para a tela; rolar até 80 px do topo
primeiro revela mais 800 já carregados, e só sem nada local pede a página anterior ao daemon
(`lib/timelineWindow.ts:11-12`, `:36`, `:43-53`; `components/Timeline.tsx:93-115`). Ao crescer
para cima, a posição de leitura é preservada (`Timeline.tsx:79-91`). Colado no fim (a menos de
60 px), acompanha cada evento novo (`Timeline.tsx:74-77`, `:106-107`). Trocar de sessão,
abrangência ou nível de detalhe volta a colar no fim e fecha a janela (`Timeline.tsx:64-67`).

### 3.6 Renderização de cada evento

Tradução única de `EventEnvelope` para texto, tipo e "detalhado" (`lib/eventView.ts:58-173`). O
texto tem ANSI removido e `\r` vira quebra (`lib/eventView.ts:45-50`).

| `type` | Texto | Tipo | Só em "Detalhado" |
|---|---|---|---|
| `session.started` | `▸ agente externo conectado` / `▸ sessão iniciada` | lifecycle | não |
| `session.ended` | `▪ encerrada — <reason>` | lifecycle | não |
| `session.handoff` | `🔄 controle transferido: A → B (motivo)` | handoff | não |
| `turn.started` | `… turno iniciado` | lifecycle | **sim** |
| `turn.completed` | interrompido: `⏹ <message>`; senão `✓ turno concluído — US$ x.xxxx` | lifecycle | não |
| `message` | texto | message | não |
| `user.message` | texto | user | não |
| `message.delta` | texto | message | **sim** |
| `reasoning` | texto | reasoning | **sim** |
| `tool.call` | `⚒ <tool> <input compacto ≤220>` | tool | não |
| `tool.result` | `⚒ ferramenta falhou` / `⚒ ok` | error/reasoning | **sim** |
| `command.executed` | `$ <command> → <exitCode>` | command | não |
| `file.changed` | `✎ <caminhos>` | file | não |
| `delegation.requested` | `→ delegou para X (nível N): <objetivo>` | delegation | não |
| `delegation.completed` | `← X retornou: <state> — <error>` | delegation | não |
| `approval.requested` | `⏸ aguardando aprovação: <action>` | error | não |
| `budget.warning` | `⚠️ alerta: consumo atingiu mais de 80% do orçamento` | warn | não |
| `budget.exceeded` | `✗ orçamento do fluxo esgotado` | error | não |
| `error` | `✗ <message\|error\|text>` | error | não |
| `log` | texto ou dados compactos | log | **sim** |
| outro | `<type> <payload compacto>` | log | **sim** |

Evento com texto vazio não aparece (`Timeline.tsx:53-60`). Forma na tela
(`Timeline.tsx:258-383`): raciocínio = cabeçalho recolhível `Raciocínio Interno (<agente>)`; tool,
command e file = cartão com selo `TOOL_CALL`/`TERMINAL`/`FILE_OP`; handoff = faixa
`Transferência de Controle (Handoff)`; user = bolha `você` (com `→ <agente>` em "Fluxo inteiro");
o resto = bolha do agente com avatar de 2 letras. Hora = `HH:MM:SS` do `ts` (`hub.ts:49-51`).

**Markdown: o painel atual NÃO renderiza.** O texto vai cru num `<span>`/`<pre>`
(`Timeline.tsx:297`, `:322`, `:337`, `:354`, `:378`). A renderização é pendência (§15, K4).

### 3.7 Notificação do sistema para aprovação

Com permissão concedida e a janela em segundo plano, cada `approval.requested` (uma vez por
`approvalId`) vira notificação do SO: título `Agents-Hub: <agente> espera sua decisão`, corpo = ação
(até 180 caracteres), clicar traz a janela para frente (`lib/approvalNotice.ts:25-41`, `:44-70`).
Com a janela visível, não notifica. A permissão só é pedida pelo botão C016.

## 4. Topbar e elementos globais

A topbar encolhe por degraus de largura (§13.2); rótulos escondidos continuam no nome acessível.

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C001 | Botão "Fluxos" (☰) | Vai para Timeline e alterna a gaveta de fluxos; abrir fecha a do painel. `aria-expanded`, `aria-controls="coluna-fluxos"`. Visível só ≤ 768 px | `App.tsx:181-186`, `:282-304` |
| C002 | Marca "AGENTS HUB v0.1" | Vai para a Timeline | `App.tsx:306-322` |
| C003 | Abas (7 botões) | Troca de aba (com a pergunta de §1.1). `aria-current="page"` na ativa | `App.tsx:324-340` |
| C004 | Busca "Buscar sessões, agentes, comandos…" + atalho | Abre a paleta. Rótulo do atalho `⌘K` no Mac, `Ctrl K` nos demais | `App.tsx:344-370`, `components/CommandPalette.tsx:23-29` |
| C005 | Alternar tema (☾/☀) | Claro ↔ escuro, grava a escolha (§13.1) | `App.tsx:394-402` |
| C006 | Botão "Painel" | Vai para Timeline e alterna a gaveta do painel; abrir fecha a de fluxos. Visível só ≤ 1200 px | `App.tsx:188-193`, `:404-425` |
| C007 | "Nova Sessão" | Abre o modal de Nova Sessão sem agente pré-escolhido | `App.tsx:427-445` |
| C008 | "Mais opções" (⋮) | Abre o menu compacto (só ≤ 600 px). `aria-haspopup="menu"` | `components/TopbarMenu.tsx:91-106` |
| C009 | Itens de aba no menu (7, `menuitemradio`) | Troca de aba; o foco volta ao ⋮ antes da ação | `TopbarMenu.tsx:116-131`, `:82-87` |
| C010 | Item "Usar tema escuro/claro" no menu | Alterna o tema | `TopbarMenu.tsx:133-144` |
| C011 | "Tentar de novo" do banner de erro | `refresh()` do índice | `App.tsx:461-468` |
| C012 | ✕ "Dispensar aviso" em cada toast | Remove o toast | `components/Toasts.tsx:24-30` |

Pílula de status (não é controle): `role="status"`, título `N sessões ao vivo` ou
`Desconectado do Hub` (`App.tsx:374-392`). Menu ⋮ abre com foco no item marcado; clique fora fecha
(`TopbarMenu.tsx:46-56`).

### 4.1 Fila de aprovações

Banner no topo de toda aba, não dispensável (`components/Approvals.tsx:33-43`). Cabeçalho
`role="status" aria-live="polite"`: `N sessão parada esperando sua decisão` /
`sessões paradas…` (`:59-65`). Por aprovação (`:73-176`): selo de risco em português
(`orçamento`, `baixo`, `médio`, `alto`, `crítico` — `hub.ts:106-112`); se não for de orçamento, selo
`já executada — sessão parada` (quando `detail.alreadyExecuted === true`) ou
`retida antes de executar`; agente; `há Xmin · HH:MM:SS`; a ação; o título da sessão;
`detail.reason` se houver.

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C013 | "ver a sessão" | Vai para Timeline e seleciona a sessão | `Approvals.tsx:112-118`, `App.tsx:474-477` |
| C014 | "Liberar" | `POST /approvals/:id {decision:'approved'}`; toast `Liberado — a sessão volta a andar.`; recarrega o índice. Desabilitado com qualquer decisão em curso; mostra `…` | `Approvals.tsx:45-55`, `:122-147` |
| C015 | "Negar" | Idem com `denied`; toast `Negado.` | `Approvals.tsx:148-174` |
| C016 | "Avisar no sistema" | Pede permissão de notificação; some depois de concedida ou negada | `Approvals.tsx:10-23` |

Erro da decisão aparece num banner `role="alert"` dentro da fila e num toast (`Approvals.tsx:67-71`,
`actions.ts:139-143`).

### 4.2 Boas-vindas (primeira execução)

Cartão `Bem-vindo ao Agents-Hub` com dois passos (`components/Onboarding.tsx:12-44`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C017 | "Registrar projeto" | Abre o modal Registrar projeto | `Onboarding.tsx:34-36`, `App.tsx:486` |
| C018 | "Ver agentes detectados" | Vai para Configurações (abre na subaba Agentes detectados quando não há projeto) | `Onboarding.tsx:37`, `App.tsx:487`, `SettingsView.tsx:80` |
| C019 | "agora não" | Esconde o cartão nesta execução (não persiste) | `Onboarding.tsx:38-40`, `App.tsx:90`, `:488` |

## 5. Aba Timeline

Três colunas: fluxos (esquerda), timeline (centro), painel & telemetria (direita)
(`App.tsx:579-816`). Larguras em desktop: 310 px, flexível, 300 px (`styles.css:963-965`). Em tela
estreita as laterais viram gavetas (§13.2).

### 5.1 Coluna de fluxos

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C020 | "+ Nova Pasta" | Abre o modal Registrar projeto | `App.tsx:598-605` |
| C021 | Seleção "Filtrar por projeto" | `Todos os Projetos (N)` + um por projeto; muda o filtro compartilhado | `App.tsx:607-619` |
| C022 | Segmento "Ativos N" | Mostra só fluxos com sessão ao vivo | `App.tsx:624-632` |
| C023 | Segmento "Todos N" | Mostra todos os fluxos (ver defeito K3 em §15) | `App.tsx:633-638` |
| C024 | "+" (Nova Sessão) | Abre o modal Nova Sessão | `App.tsx:642-649` |
| C025 | Campo "Filtrar fluxos ou agentes…" | Filtra por agente, título ou id de sessão (sem diferenciar maiúsculas) | `App.tsx:248-255`, `:654-661` |
| C026 | Cabeçalho do fluxo (botão) | Abre/recolhe o fluxo; se o fluxo não contém a sessão selecionada, seleciona a primeira sessão viva (ou a mais recente) | `components/FlowList.tsx:131-181` |
| C027 | Nó da árvore do fluxo (botão) | Seleciona a sessão. Mostra estado, agente, `US$` curto · tokens, título | `components/FlowTree.tsx:39-62` |
| C028 | "tentar de novo" do grafo do fluxo | Rebusca `/graph` do fluxo | `FlowTree.tsx:16-26`, `useHubState.ts:409-412` |
| C029 | "Nova sessão" (Hub vazio) | Abre o modal Nova Sessão; texto `Nenhuma sessão no Hub ainda.` (`FlowList.tsx:77`) | `FlowList.tsx:74-84` |
| C030 | "Ver todos" (filtro sem resultado) | Zera filtro de status, busca e projeto; texto `Nenhum fluxo com este filtro ou busca.` (`FlowList.tsx:88`) | `FlowList.tsx:85-95`, `App.tsx:676-680` |

Ordem dos filtros: projeto, status, busca (`App.tsx:236-258`). Cabeçalho do fluxo: ponto de estado,
tags de agente, `· N sessões` quando há mais sessões que agentes, `há X`, título, selo de estado
(`FlowList.tsx:143-166`). Fluxo **abre sozinho** quando contém a selecionada, mas pode ser recolhido
à mão; recolhido fica assim até outra sessão dele ser escolhida por fora da lista
(`lib/flowListState.ts:21-57`). O grafo de um fluxo (`GET /graph/:rootId`) só é buscado com ele
aberto, e relido quando a revisão **daquele** fluxo sobe (`FlowList.tsx:126`,
`useHubState.ts:375-414`). Estados: `Carregando árvore do fluxo…`; falha
`⚠️ Falha ao carregar o grafo deste fluxo — não é um fluxo sem sessões, a busca falhou.`; vazio
`Este fluxo não possui sessões registradas` (`FlowList.tsx:183-198`, `FlowTree.tsx:15-29`). A
árvore é recursiva por `children` (`FlowTree.tsx:64-68`). Estado da lista: carregando/erro por
`EstadoDaTela` compacto (§12) (`FlowList.tsx:73`).

### 5.2 Coluna central: cabeçalho, timeline e compositor

Cabeçalho: avatar de 2 letras, agente, estado em português, título, id e `há X`; sem seleção,
`Selecione uma sessão ao lado` (`App.tsx:688-723`). Rótulos de estado: `ociosa`, `rodando`,
`aguardando você`, `pausada`, `concluída`, `falhou`, `encerrada` (`hub.ts:62-70`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C031 | "Esta sessão" | Timeline só da sessão selecionada (`aria-pressed`) | `App.tsx:727-733` |
| C032 | "Fluxo inteiro" | Timeline mesclada do fluxo, com o agente em cada linha | `App.tsx:734-740`, `:774` |
| C033 | "Resumido" | Esconde os tipos "só em Detalhado" (§3.6) | `App.tsx:744-750` |
| C034 | "Detalhado" | Mostra tudo | `App.tsx:751-757` |
| C035 | Botão de carregar anteriores | Texto conforme o caso: `↑ Mostrar N eventos anteriores` (N ≤ 800), `Carregando anteriores…` (desabilitado), `↻ Falhou — tentar carregar anteriores de novo`, `↑ Carregar eventos anteriores`; ao lado `N ocultos acima` | `Timeline.tsx:206-223` |
| C036 | "Ir para o fim" | Aparece quando o usuário saiu do fim; rola e volta a acompanhar | `Timeline.tsx:231-253` |
| C037 | Cabeçalho do raciocínio | Expande/recolhe o texto (`role="button"`, Enter/Espaço, `aria-expanded`) | `Timeline.tsx:273-300` |
| C038 | "Tentar de novo agora" (falha sem eventos) | Refaz a busca das sessões que falharam | `Timeline.tsx:150-166` |
| C039 | "tentar de novo" (aviso com eventos ao vivo) | Idem | `Timeline.tsx:187-197` |
| C040 | Campo de mensagem | Enter envia; Shift+Enter quebra linha; `/` foca (§12.1). Desabilitado enviando ou com sessão terminada | `components/Composer.tsx:97-118` |
| C041 | "Enviar" | `POST /sessions/:id/send {text}` com o texto aparado; limpa o campo | `Composer.tsx:66-86`, `:125-151` |

Estados da área central (`App.tsx:762-790`, `Timeline.tsx:117-181`):

- Sessões carregando ou com erro e nada selecionado: `EstadoDaTela` "as sessões".
- Nada selecionado: `Nenhuma sessão no Hub ainda` + `Inicie uma em “Nova Sessão”…` (Hub vazio) ou
  `Nenhuma sessão selecionada` + `Escolha um fluxo ao lado para ver a timeline.`
- Carregando sem eventos: esqueleto de 5 linhas, `aria-label="Carregando timeline"`.
- Falha sem eventos: `Falha ao carregar os eventos desta sessão` + `Não é uma sessão sem eventos —
  a busca falhou (rede instável ou daemon reiniciando).` + `Tentando de novo automaticamente em N s.`
  ou `As tentativas automáticas acabaram.`
- Falha com eventos ao vivo: aviso `⚠️ O histórico desta sessão não carregou; mostrando só o que
  chegou ao vivo.` + o mesmo texto de tentativa.
- Vazio: `Nenhum evento visível nesta sessão` + dica para ativar "detalhado" (em Resumido) ou
  `Nenhum evento nesta sessão`.

Compositor (`Composer.tsx:23-155`): só aparece com sessão selecionada (`App.tsx:789`). Trocar de
sessão apaga o rascunho e o erro (`:31-34`). Placeholder por estado (`:110-116`): terminada →
`Sessão <estado> — não é reaberta; continue numa nova: hub start --from <id> --agent <agente> "…"`;
pausada → `Sessão pausada — enviar uma mensagem retoma <agente>`; senão → `Falar com <agente>…
(Pressione Enter para enviar, Shift+Enter para nova linha)`. Dica `/ para focar` com o campo vazio e
a sessão viva (`:119-123`). Envio em modo `replay` gera toast `Mensagem enviada em um turno novo.` /
`O agente não retoma a sessão nativa: recebeu o histórico resumido junto.`
(`lib/sessionControls.ts:136-145`). A fala aparece na timeline pelo evento `user.message`, não
localmente (`Composer.tsx:73-74`). Erro: banner `role="alert"` + toast (`:77-83`).

### 5.3 Coluna direita: Painel & Telemetria

Cabeçalho `Painel & Telemetria` + agente (`components/SidePanel.tsx:116-123`). Sem sessão:
`Nenhuma sessão selecionada` / `Selecione um fluxo para ver detalhes, memórias e telemetria.`
(`:538-546`).

**Orçamento do fluxo** (`GET /budget/:rootId` da **raiz** do fluxo — `App.tsx:136-137`,
`useHubState.ts:430-473`; relido quando a revisão do fluxo sobe; trocar de fluxo apaga o anterior
da tela):

- Carregando: `Carregando o orçamento…` (`SidePanel.tsx:125-132`).
- Erro: `Não foi possível carregar o orçamento: <erro>` + "tentar de novo" (`:133-143`).
- Dado (`:144-215`): `% consumido` (pressão, teto 100 %), `restante` em US$, barra
  `role="progressbar"`; nível `danger` se esgotado ou ≥ 90 %, `warn` ≥ 60 %, senão `ok`
  (`:111-112`); três cartões Custo/Tokens/Tempo "de <limite>"; com taxa de queima > 0, chips
  `⚡ $x.xxx/min` e `📈 <US$ projetado> · <tokens projetados>`; `isWarning` e não esgotado →
  `⚠️ Atenção: Consumo passou de 80% do teto.`; esgotado → `🛑 Orçamento esgotado: Tarefas novas
  estão bloqueadas.`

**Memória & Contexto** (`GET /projects/:projectId/context`, campo `memory`) (`SidePanel.tsx:47-77`,
`:220-287`): cartão `📁 Regras do Projeto` com a memória, ou `este projeto ainda não tem memória
configurada.`, ou falha `⚠️ Não foi possível buscar a memória do projeto — não é um projeto sem
memória.`; cartão `🛡️ Modo de Isolamento` (worktree / pasta principal); cartão `📂 Pasta de
Execução` com o `workdir`.

**Controles da Sessão.** Habilitação derivada só do estado informado pelo daemon
(`lib/sessionControls.ts:45-82`): terminal desabilita os quatro (`sessão já terminou`); com ação em
curso, todos esperam (`aguardando a ação anterior`); Interromper e Pausar só com `running`
(`waiting_approval` → `resolva a aprovação pendente primeiro`; `paused` → `já está pausada` /
`nenhum turno em andamento`); Transferir exige outro agente **instalado** (`nenhum outro agente
instalado`); Encerrar vale em qualquer estado não terminal. O motivo vira a dica do botão. Pausada
mostra `Pausada — envie uma mensagem para retomar.`

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C042 | "tentar de novo" (orçamento) | Rebusca o orçamento | `SidePanel.tsx:138-140` |
| C043 | "Memória & Contexto" (divulgação) | Expande/recolhe o bloco (`aria-expanded`); começa aberto | `SidePanel.tsx:27`, `:224-239` |
| C044 | "tentar de novo" (memória) | Rebusca o contexto do projeto | `SidePanel.tsx:246-252` |
| C045 | "Interromper" | `POST …/interrupt`; toast conforme a resposta: `interrupted:false` → aviso `Nada foi interrompido` / `A sessão não tinha turno em andamento.`; senão `Turno interrompido.` / `A sessão continua viva e ociosa — envie uma mensagem para retomar.` | `SidePanel.tsx:293-319`, `lib/sessionControls.ts:95-111` |
| C046 | "Pausar" | `POST …/pause`; toast `Pedido de pausa aceito pelo Hub.` | `SidePanel.tsx:320-346` |
| C047 | "Transferir" | Abre/fecha o subformulário de handoff | `SidePanel.tsx:347-369` |
| C048 | "Encerrar" | 1º clique só abre a confirmação (`aria-expanded`); desabilitado com a confirmação aberta | `SidePanel.tsx:370-392` |
| C049 | "Encerrar sessão" (confirmação) | `POST …/cancel {reason:'via painel'}`; toast `Pedido de encerramento aceito pelo Hub.`; foco inicial aqui | `SidePanel.tsx:413-426` |
| C050 | "Manter rodando" | Fecha a confirmação | `SidePanel.tsx:427` |
| C051 | "Delegar sub-tarefa a partir daqui" | Abre o modal em modo Delegar a partir da sessão | `SidePanel.tsx:432-447`, `App.tsx:805-811` |
| C052 | Seleção "Novo agente" (handoff) | Só agentes instalados diferentes do atual, `Nome (id)` | `SidePanel.tsx:457-469`, `:102` |
| C053 | Campo "Motivo da transferência (opcional)…" | Motivo aparado; vazio não vai | `SidePanel.tsx:473-479`, `:90` |
| C054 | "Confirmar Handoff" | `POST …/handoff {agentId, reason?}`; toast `Sessão transferida para <agente>.`; exige agente; `Transferindo…` | `SidePanel.tsx:85-100`, `:481-487` |
| C055 | "Cancelar" (handoff) | Fecha o subformulário | `SidePanel.tsx:488` |

Confirmação de encerramento: `role="alertdialog"`, texto `Encerrar esta sessão? O processo do
agente é finalizado e não há como retomar.` (`SidePanel.tsx:401-411`). Trocar de sessão fecha a
confirmação e o handoff (`:34-37`). Depois de qualquer ação com sucesso, recarrega o índice
(`:79-83`).

**Detalhes Técnicos** (`SidePanel.tsx:494-534`): Agente, Estado, Supervisão (`mode`), Profundidade
(`Nível N`), Sessão Nativa (`Sim`/`—`, com o id na dica), ID da Sessão (12 primeiros caracteres + `…`).

## 6. Aba Swarm

Grade de cartões, um por agente de `GET /agents` (`components/AgentSwarmView.tsx:16-155`). Título
`Swarm de Agentes Conectados`; subtítulo `N de M agentes de IA integrados…` com N = instalados
(`:57`, `:62-68`). Cartão: avatar, nome, `vendor · id`, pílula `v<versão>` (ou `detectado`) /
`Não Instalado`, descrição, capacidades + `stream: <streamFormat>` + `strategy: <sessionStrategy>`,
ressalvas `⚠ …` (`:72-127`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C056 | "Iniciar Sessão" (por cartão) | Abre Nova Sessão com o agente pré-escolhido; desabilitado se não instalado | `AgentSwarmView.tsx:129-148`, `App.tsx:524` |
| C057 | "Verificar de novo" (sem agentes) | `refresh()` | `AgentSwarmView.tsx:33-53` |

Estados: carregando/erro por `EstadoDaTela` "os agentes"; vazio `Nenhum agente registrado no Hub` /
`O daemon não tem manifesto de agente carregado. Rode hub doctor para ver o motivo.`
(`AgentSwarmView.tsx:23-53`).

## 7. Aba Grafo DAG

Cada fluxo do filtro de projeto como **árvore** com arestas pai/filho (`components/DagCanvasView.tsx:43-163`).
A árvore sai da lista de sessões (sem requisição); o custo por nó vem de `GET /graph/:rootId`.

- **Arestas** (`lib/flowTree.ts:38-80`): cada sessão vai sob o seu `parentId`; aresta `delegation`
  quando tem pai, `handoff` quando é irmã sem pai (mesma raiz), `root` na raiz. Pai fora da lista →
  pendura na raiz; raiz fora da lista → cada órfão vira raiz. Irmãos por `createdAt`. Rótulos:
  `Raiz do fluxo`, `Delegada`, `Transferida (handoff)`; marcador `↳` (delegação) ou `⇄` (handoff)
  (`DagCanvasView.tsx:37-41`, `:289-293`). Indentação por profundidade (`:287`).
- **Cabeçalho do fluxo** (`:214-238`): `Fluxo #<rootId[4..12]>`, estado, `há X`, agentes,
  `N sessão(ões) · US$ total · tokens total`.
- **Nó** (`:294-339`): avatar, agente, papel da aresta, estado, título (ou `Sem título` na raiz /
  `Tarefa secundária`), `há X`, custo `US$ · tokens` ou `custo indisponível` / `custo…`.
- **Custo:** até 4 `/graph` em paralelo; cada raiz só é rebuscada quando a sua revisão sobe; erro não
  é repetido sozinho (`useFlowGraphs.ts:12-100`, `lib/flowGraphs.ts:30-40`). Só busca com a situação
  das sessões `ok` (`DagCanvasView.tsx:69`).
- **Tokens desconhecidos:** gasto > 0 e 0 tokens mostra `sem contagem de tokens` (`lib/tokens.ts:18-25`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C058 | Seleção "Projeto" | Muda o filtro compartilhado | `DagCanvasView.tsx:81-92` |
| C059 | Nó (`treeitem`) | Clique/Enter: seleciona a sessão e vai para a Timeline. Tabulação itinerante: um nó por fluxo no Tab; ↑/↓/Home/End/→(1º filho)/←(pai) | `DagCanvasView.tsx:194-207`, `:294-339`, `lib/flowTree.ts:87-116`, `App.tsx:535-538` |
| C060 | "tentar de novo" (custo) | Refaz os `/graph` que falharam; aviso `O custo de N fluxo(s) não carregou: <erro>` | `DagCanvasView.tsx:141-148` |
| C061 | "Ver todos os projetos" (vazio com filtro) | Filtro = todos | `DagCanvasView.tsx:124-128` |
| C062 | "Criar Nova Sessão" (vazio) | Abre Nova Sessão | `DagCanvasView.tsx:129-131` |

Estados: carregando/erro por `EstadoDaTela` "as sessões"; vazio com filtro `Nenhum fluxo em
“<projeto>”` / `Este projeto ainda não tem sessões…`; vazio sem filtro `Nenhum fluxo no Hub ainda` /
`Inicie uma sessão para visualizar o grafo…` (`DagCanvasView.tsx:97-136`).

## 8. Aba Telemetria

Contagens com as definições do resto do painel e custo por agente e no tempo, a partir de
`/sessions` e `/graph` (`components/TelemetryView.tsx:32-275`, `lib/telemetry.ts:1-191`).

- **KPIs** (`TelemetryView.tsx:134-170`, `lib/telemetry.ts:63-82`): `Sessões no período` (criadas
  no período) + `N falharam · N encerradas`; `Ao vivo agora` (independe do período) +
  `rodando, aguardando, pausadas ou ociosas`; `Taxa de Conclusão` = concluídas ÷ terminadas, `—`
  sem terminadas; `Custo no período` (`…` enquanto algum grafo não carregou) + tokens e nº de fluxos.
- **Custo por agente** (`TelemetryView.tsx:187-235`, `lib/telemetry.ts:130-148`): tabela Agente,
  Sessões, Custo, Tokens, Parte do custo (%). Conta sessões **começadas** no período (`startedAt`
  do nó do grafo); maior custo primeiro. Vazio: `Nenhuma sessão começou neste período.`
- **Custo no tempo** (`TelemetryView.tsx:237-272`, `lib/telemetry.ts:163-191`): barras; 24 faixas de
  1 h, 7 ou 30 de 1 dia, ou 12 faixas desde a primeira sessão em "Tudo". Dica de cada barra: data,
  US$ e tokens. Eixo: data inicial e `agora`. Nota: `O daemon guarda o custo acumulado de cada
  sessão: ele conta na faixa em que a sessão começou.`
- Só busca `/graph` dos fluxos cujo `updatedAt` cai no período (`lib/telemetry.ts:113-120`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C063 | Seleção "Projeto" | Muda o filtro compartilhado | `TelemetryView.tsx:89-100` |
| C064 | Seleção "Período" | `Últimas 24 h`, `Últimos 7 dias` (padrão), `Últimos 30 dias`, `Tudo` | `TelemetryView.tsx:48`, `:101-110`, `lib/telemetry.ts:22-27` |
| C065 | "tentar de novo" (custo) | Refaz os grafos que falharam; aviso `O custo de N de M fluxo(s) não carregou (<erro>); os totais abaixo estão incompletos.` | `TelemetryView.tsx:172-180` |

Estados: carregando/erro por `EstadoDaTela`; Hub vazio mostra `Nenhuma sessão no Hub ainda — as
métricas aparecem quando a primeira sessão começar.` e os KPIs zerados; `Carregando o custo de N
fluxo(s)…` (`TelemetryView.tsx:115-132`, `:181-185`).

## 9. Aba Operação

Cinco seções num subnav; começa em "Sessão" (`components/OperationView.tsx:11-19`, `:48`). Texto
de topo: as ações de segurança/disco exigem o token de operador (`:57-61`). Aviso no topo da aba se
sessões, projetos ou agentes falharam (`App.tsx:551`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C066 | Subnav (5 botões: Sessão, Workflow, Projeto, Saúde, Manutenção) | Troca a seção; `aria-current="page"` | `OperationView.tsx:64-76` |

Padrões da aba: leitura com `carregando`/`erro com Tentar de novo`/`ok`, e releitura que não apaga o
dado anterior (`ops/useCarga.ts:18-60`, `ops/Partes.tsx:39-73`); resultado de ação ao lado do botão
(`role="status"` ou `role="alert"`). Na Operação o **sucesso** aparece só ao lado do botão (sem
toast); só o **erro** também gera toast (`ops/useAcao.ts:32-36`, `actions.ts:136-143`,
`ops/Partes.tsx:76-98`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C067 | "Tentar de novo" de cada leitura (`EstadoDaCarga`) | Relê o recurso; texto `Não foi possível carregar <o quê>: <erro>` | `ops/Partes.tsx:60-71` |

### 9.1 Sessão

Começa na sessão selecionada da Timeline; escolher aqui também seleciona lá
(`OperationView.tsx:49-52`, `:83-86`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C068 | Seleção "Sessão" | Todas as sessões, mais recente primeiro, `agente · estado · título(60)` | `ops/SessaoOps.tsx:27-30`, `:42-66` |
| C069 | "Abrir na Timeline" | Seleciona e vai para a Timeline | `SessaoOps.tsx:67-71` |
| C070 | "Recarregar" (Tarefas) | Relê `GET …/tasks` | `SessaoOps.tsx:109-113` |
| C071 | "Carregar diff" / "Recarregar" | Diff só sob pedido: `GET …/diff` | `SessaoOps.tsx:176-199` |
| C072 | Arquivo do diff (divulgação) | Abre/fecha o patch do arquivo; abertos por padrão com ≤ 3 arquivos | `SessaoOps.tsx:226-242` |
| C073 | "Recarregar" (Artefatos) | Relê `GET …/artifacts` | `SessaoOps.tsx:275-279` |
| C074 | "Copiar caminho" (por artefato) | Copia o caminho; vira `Copiado` | `SessaoOps.tsx:264-269`, `:299-307` |
| C075 | Campo "Teto em US$" | Texto decimal (aceita vírgula); dica `Não pode ficar abaixo do já gasto.` | `SessaoOps.tsx:361-376`, `:410` |
| C076 | Campo "Teto em tokens" | Inteiro; dica `Número inteiro.` | `SessaoOps.tsx:411` |
| C077 | Campo "Teto de tempo (min)" | Minutos; dica `Tempo de execução somado.` | `SessaoOps.tsx:412` |
| C078 | "Salvar teto" (Enter no formulário) | Valida e envia `PUT /budget/:rootId {limits}` só com o que mudou; ok `Teto salvo: US$ x.xx.` | `SessaoOps.tsx:340-359`, `:403-416` |
| C079 | "Descartar" | Volta aos valores do daemon; só aparece com edição | `SessaoOps.tsx:417-427` |

- **Tarefas** (`SessaoOps.tsx:101-174`): estado em português (`na fila`, `trabalhando`, `aguardando
  você`, `precisa de login`, `concluída`, `falhou`, `cancelada`, `recusada` — `logic/operacao.ts:189-198`),
  id, `N tentativa(s) · agente`, objetivo, motivo de falha (`logic/operacao.ts:201-210`), resumo +
  US$ · tokens · duração, checagens de validação `✓/✗ nome — detalhe`. Vazio: `Esta sessão não tem
  tarefa (sessões adotadas não recebem tarefa do Hub).` Relê quando `updatedAt` muda (`:87`, `:102`).
- **Diff** (`SessaoOps.tsx:176-249`, `logic/operacao.ts:46-89`): por arquivo, com `+N −N`,
  `binário`, linhas classificadas `add`/`del`/`ctx`/`hunk`/`meta`; total de arquivos e o caminho;
  sem diff mostra a `message` do daemon ou `Sem diff.`
- **Artefatos** (`SessaoOps.tsx:251-314`): tipo (`diff`, `arquivo`, `relatório`, `log`,
  `transcrição`) e caminho. Vazio: `Nenhum artefato registrado para esta sessão.`
- **Orçamento do fluxo** (`SessaoOps.tsx:316-440`): da **raiz**; descrição diferente para
  sub-sessão (`Esta é uma sub-sessão: o teto é o da raiz <id>…`); resumo `Gasto … de … · tokens ·
  tempo · reservado a delegações · esgotado`.
- Sessão adotada: `Sessão adotada de um agente externo — desanexe em Projeto › Agentes externos.`
  (`SessaoOps.tsx:82-86`). Sem sessão: `Nenhuma sessão no Hub ainda — crie uma em "Nova Sessão".` /
  `Escolha uma sessão para ver tarefas, diff, artefatos e orçamento.` (`:74-79`).

**Validação do teto** (`logic/operacao.ts:127-173`, vazio = não mexer):
- US$: número > 0 (`Custo: informe um valor em dólares maior que zero.`); não abaixo do gasto
  (`Custo: o fluxo já gastou US$ x — o teto não pode ficar abaixo disso.`).
- Tokens: inteiro > 0 (`Tokens: informe um número inteiro maior que zero.`); não abaixo do usado.
- Minutos: > 0 (`Tempo: informe minutos maiores que zero.`), ≥ 1 s (`Tempo: o mínimo é 1 segundo.`),
  não abaixo do usado; enviado em segundos (`round(min×60)`).
- Nada mudou: `Nada mudou em relação ao teto atual.`

### 9.2 Workflow

Editor de YAML, validação, disparo e acompanhamento (`components/ops/WorkflowOps.tsx:41-333`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C080 | Área "YAML do workflow" | Texto livre; placeholder é o exemplo `plano-e-execucao` | `WorkflowOps.tsx:21-31`, `:142-152` |
| C081 | Seleção "Projeto" | Projeto onde os passos rodam (padrão: o primeiro) | `WorkflowOps.tsx:43`, `:154-168` |
| C082 | Campo "Orçamento total (US$)" | Opcional; vazio = `sem teto global` | `WorkflowOps.tsx:169-178` |
| C083 | "Abrir arquivo…" | Seletor de arquivo `.yaml/.yml/texto`; recusa > 200 kB: `O arquivo tem N kB; o limite é 200 kB.`; falha de leitura: `Não foi possível ler o arquivo.` | `WorkflowOps.tsx:34`, `:72-87`, `:181-193` |
| C084 | "Usar exemplo" | Preenche com o exemplo; só com o campo vazio | `WorkflowOps.tsx:194-198` |
| C085 | "Validar" | `POST /workflows/validate {yaml}`; ok `Válido: N passos em M lote(s).` ou `O workflow tem erros — veja abaixo.`; lista de erros ou `Lote i (em paralelo): a, b` | `WorkflowOps.tsx:89-104`, `:199-201`, `:223-239` |
| C086 | "Executar" | `POST /workflows/runs {yaml, projectId, budgetUsd?}`; ok `Workflow "<nome>" disparado no Hub.`; desabilitado com YAML vazio, sem projeto, ocupado ou com a validação **do texto atual** reprovada (dica `Corrija os erros de validação antes`) | `WorkflowOps.tsx:106-133`, `:202-215` |
| C087 | "Atualizar" (Execuções) | Relê `GET /workflows/runs` | `WorkflowOps.tsx:246-254` |
| C088 | Seleção "Execução" | `nome · estado · há X`; padrão: a disparada agora ou a primeira | `WorkflowOps.tsx:60`, `:266-275` |
| C089 | "Ver sessão" (por passo) | Abre a sessão do passo na Timeline | `WorkflowOps.tsx:320-324` |

Validação local antes de executar: orçamento vazio ou > 0 (`Orçamento do workflow: informe dólares
maiores que zero, ou deixe vazio.`), projeto obrigatório (`Escolha o projeto onde os passos vão
rodar.`) (`logic/operacao.ts:249-260`, `WorkflowOps.tsx:107-115`). **Acompanhamento:** com alguma
execução `running`, relê a lista a cada 2 s (`WorkflowOps.tsx:63-68`). Detalhe
(`WorkflowOps.tsx:286-333`): estado (`em andamento`, `concluído`, `com falhas`, `interrompido`),
resumo `k/n concluídos · …`, US$ gasto `de` orçamento, projeto, `lote i/n`, erro; por passo: estado
(`aguardando`, `rodando`, `concluído`, `falhou`, `pulado`, `aguardando você`, `tempo esgotado`), id,
agente, dependências, US$, detalhe e resumo (`logic/operacao.ts:214-241`). Vazio: `Nenhuma execução
registrada.` Nota: o registro vive na memória do daemon (`WorkflowOps.tsx:245`).

### 9.3 Projeto

Pastas e adoção de agentes externos (`components/ops/ProjetoOps.tsx:22-362`). Sem projetos:
`Nenhum projeto registrado ainda — use "+ Nova Pasta" na Timeline.` (`:34-38`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C090 | Seleção "Projeto" | `nome — caminho` | `ProjetoOps.tsx:43-54` |
| C091 | "Remover" (pasta não principal) | Abre confirmação inline | `ProjetoOps.tsx:139-149` |
| C092 | "Remover pasta" (confirmação) | `DELETE /projects/:id/folders/:folderId`; ok `Pasta removida do projeto (nada foi apagado do disco).`; foco inicial | `ProjetoOps.tsx:102-113`, `:159-167` |
| C093 | "Manter" (pasta) | Fecha a confirmação | `ProjetoOps.tsx:168-170` |
| C094 | Campo "Caminho absoluto da pasta" | Placeholder `C:\projetos\outra-pasta` | `ProjetoOps.tsx:185-193` |
| C095 | Campo "Rótulo (opcional)" | | `ProjetoOps.tsx:194-197` |
| C096 | "Adicionar pasta" (Enter no formulário) | `POST /projects/:id/folders {path, label?}`; ok `Pasta adicionada: <caminho>`; exige caminho | `ProjetoOps.tsx:85-100`, `:198-206` |
| C097 | Seleção "Agente" (adoção) | Todos os agentes, `Nome (id)` | `ProjetoOps.tsx:274-287` |
| C098 | Campo "Título (opcional)" | | `ProjetoOps.tsx:288-291` |
| C099 | "Adotar sessão" (Enter no formulário) | `POST /sessions/adopt {agentId, projectId, title?}`; ok `Sessão <id> registrada para <agente>.` | `ProjetoOps.tsx:241-259`, `:292-296` |
| C100 | "Ver sessão" (adotada) | Abre na Timeline | `ProjetoOps.tsx:316-318` |
| C101 | "Desanexar" | Só adotada e viva; abre confirmação | `ProjetoOps.tsx:319-328`, `logic/operacao.ts:178-180` |
| C102 | "Desanexar" (confirmação) | `POST /sessions/:id/detach`; ok `Sessão desanexada.` | `ProjetoOps.tsx:334-349` |
| C103 | "Manter" (adoção) | Fecha a confirmação | `ProjetoOps.tsx:350-352` |

Textos de confirmação: `Tirar esta pasta do projeto? Os arquivos no disco não são tocados.`
(`ProjetoOps.tsx:157`); `Encerrar esta sessão no Hub? As sub-sessões delegadas continuam.` (`:332`).
Pastas: selo `principal`, caminho, rótulo (`:129-177`). Adoção: daemon sem o campo `adopted` →
`Este daemon não informa quais sessões são adotadas; atualize-o para desanexar por aqui.`; vazio
`Nenhuma sessão adotada neste projeto.` (`:300-307`).

### 9.4 Saúde

Estado do daemon e diagnóstico dos agentes (`components/ops/SaudeOps.tsx:23-134`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C104 | "Atualizar" (Daemon) | Relê `GET /health` | `SaudeOps.tsx:48-56` |
| C105 | "Re-sondar agentes" | `POST /agents/probe`; ok `Sondagem refeita: N de M agentes encontrados.`; recarrega o índice | `SaudeOps.tsx:28-41`, `:96-98` |

Daemon (`SaudeOps.tsx:65-88`): Estado (`respondendo`/`com problema`), Versão, Sessões vivas,
Conexões ao vivo (SSE), Relógio do daemon. Agentes: nível `ok`/`atenção`/`indisponível`, nome, id,
estado (`ainda não sondado`, `não encontrado`, `instalado <versão>`), `sondado há X`, notas: caminho
do binário, manifesto conferido/em parte/não conferido, versão instalada difere da conferida,
aceita ou não escolher modelo, `login: <dica>` (`logic/operacao.ts:280-325`). Vazio: `O daemon não
informou nenhum agente.`

### 9.5 Manutenção

Recolher worktrees expirados (`components/ops/ManutencaoOps.tsx:14-90`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C106 | "Recolher worktrees…" | Abre confirmação inline | `ManutencaoOps.tsx:39-47` |
| C107 | "Recolher agora" | `POST /maintenance/sweep`; ok `N sessão(ões) encerrada(s) examinada(s) · N worktree(s) recolhido(s) · N ainda no prazo`, com `· N falharam` só quando há falhas (`ManutencaoOps.tsx:27`); lista removidos e falhas `caminho: motivo` | `ManutencaoOps.tsx:19-30`, `:59-61`, `:69-86` |
| C108 | "Cancelar" | Fecha a confirmação | `ManutencaoOps.tsx:62-64` |

Texto de confirmação: `Apagar do disco os worktrees expirados? Quem ainda estiver dentro da janela de
retenção não é tocado.` (`ManutencaoOps.tsx:54-57`).

## 10. Aba Segurança

Cinco seções e um seletor de projeto (`components/SecurityView.tsx:26-172`). Toda escrita exige o
token de operador e fica na auditoria (`:34-40`). Aviso no topo se projetos, agentes ou sessões
falharam (`App.tsx:506`).

**Projeto da aba:** o filtro compartilhado, se existir; em "todos", o primeiro projeto; sem projetos,
só a camada global (`logic/security.ts:338-341`). Se o filtro muda com a aba aberta, a aba segue —
com política não salva pergunta `Há alterações não salvas na política. Descartar?`
(`SecurityView.tsx:52-66`, `logic/security.ts:348-357`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C109 | Seleção "Projeto" | `nenhum (só global)` + projetos; escolher um projeto também muda o filtro compartilhado (nenhum, não); com política suja, pergunta antes | `SecurityView.tsx:84-91`, `:105-117` |
| C110 | Navegação (5 botões: Política, Confiança do projeto, Gate e MCP, Aprovações, Auditoria) | Troca a seção; com política suja, pergunta antes | `SecurityView.tsx:79-82`, `:121-138` |

### 10.1 Política

Edita a **camada** (JSON) global ou do projeto, com revisão obrigatória antes de gravar
(`components/PolicyEditor.tsx:23-314`). Carrega `GET /policy[?projectId=]` (`:55-79`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C111 | "Global" | Camada global; com texto sujo, pergunta `Há alterações não revisadas nesta camada. Descartar e trocar?` | `PolicyEditor.tsx:84-89`, `:149-155` |
| C112 | "Projeto: <nome>" | Camada do projeto; desabilitado sem projeto (`Escolha um projeto no topo`) | `PolicyEditor.tsx:156-164` |
| C113 | "tentar de novo" (leitura) | Relê a política; texto `Não foi possível ler a política: <erro>` (`PolicyEditor.tsx:169`) | `PolicyEditor.tsx:167-174` |
| C114 | Área "Camada … (JSON)" | Texto; desabilitado até carregar; valida forma local: `JSON inválido: …` ou `a camada precisa ser um objeto JSON ({ ... }) na raiz`; vazio = `{}` | `PolicyEditor.tsx:193-226`, `logic/security.ts:28-41` |
| C115 | "dispensar" (erro da ação) | Limpa o erro | `PolicyEditor.tsx:228-235` |
| C116 | "Descartar" | Volta ao texto carregado; só com edição | `PolicyEditor.tsx:258-266` |
| C117 | "Revisar alterações" | Prévia `PUT …?dryRun=1`; mostra o que **afrouxa** (global), o que fica **sem efeito** (clamp do projeto) e campos de execução **ignorados**; ou `Nada nesta camada afrouxa a política atual nem fica sem efeito.` | `PolicyEditor.tsx:91-103`, `:237-244`, `logic/security.ts:57-70` |
| C118 | "Gravar…" | Só para o texto exatamente revisado e com edição (dica `Revise antes de gravar`); vermelho se afrouxa; abre confirmação | `PolicyEditor.tsx:273-280` |
| C119 | "Política efetiva agora" (divulgação) | Mostra a política efetiva em JSON | `PolicyEditor.tsx:283-290` |
| C120 | Confirmação: "Cancelar" / "Gravar" ou "Afrouxar e gravar" | Grava `PUT /policy` ou `PUT /projects/:id/policy`; ok `política gravada`; global afrouxada gera aviso `Política global gravada — e AFROUXADA` com os campos; mostra o backup | `PolicyEditor.tsx:105-133`, `:292-311` |

Textos da confirmação: `Gravar a política global?` / `Passa a valer na hora, para todos os projetos
e sessões.`; `Gravar a política do projeto?` / `Grava no config.yaml de "<nome>" — um arquivo
versionado do repositório.` (`PolicyEditor.tsx:294-301`). Na camada de projeto aparecem o erro de
YAML inválido, `Projeto não confiável: campos que executam processo … são ignorados.` e os avisos da
camada gravada hoje (`:176-191`). Cabeçalhos dos avisos: `…: isto AFROUXA a política`,
`…: sem efeito aqui (clamp — a camada do projeto só aperta)`, `…: ignorado — executa processo e o
projeto não é confiável` (`:316-364`). Ajuda mostra o arquivo de destino e um exemplo (`:208-220`).

### 10.2 Confiança do projeto

Estado do `.agents-hub/config.yaml` do repositório, lido de `GET /projects/:id/context` (campo
`repo`) (`components/ProjectTrustPanel.tsx:24-168`). Sem projeto: `Escolha um projeto no topo para
ver o que o repositório declara.` (`:52-61`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C121 | "tentar de novo" | Relê o estado | `ProjectTrustPanel.tsx:86-93` |
| C122 | "dispensar" | Limpa o erro da ação | `ProjectTrustPanel.tsx:111-118` |
| C123 | "Retirar confiança…" | Só se não for `untrusted`; abre confirmação | `ProjectTrustPanel.tsx:121-129` |
| C124 | "Confiar neste conteúdo…" / "Confiar no conteúdo novo…" | Só se não for `trusted` e houver algo sensível; abre confirmação | `ProjectTrustPanel.tsx:130-138` |
| C125 | Confirmação "Confiar" (perigo) / "Retirar confiança" + "Cancelar" | `POST /projects/:id/trust {trusted}`; ok `projeto marcado como confiável` / `confiança retirada`; recarrega o índice | `ProjectTrustPanel.tsx:65-76`, `:143-165` |

Estado (`logic/security.ts:234-275`): `confiável`, `confiança suspensa` (o arquivo mudou; campos
ignorados até reconfirmar) ou `não confiável`, com explicação. Campos sensíveis agrupados: `Executa
processo na sua máquina` (`validation.*`), `Muda para onde vai a credencial do CLI (BASE_URL)`,
`Variáveis de ambiente do agente`, `Instruções ao agente (prompts, memória)`
(`ProjectTrustPanel.tsx:170-198`). Textos: `Confiar em "<nome>"?` / `Tudo abaixo passa a valer nas
próximas sessões deste projeto. Se o arquivo mudar, a confiança é suspensa sozinha.`; `Retirar a
confiança em "<nome>"?` / `Comando de validação, env, BASE_URL, prompts e memória vindos do
repositório deixam de valer. O que você configurou pelo Hub continua.` (`:145-159`).

### 10.3 Gate e MCP

Por agente, o estado do gate pré-execução e do registro MCP, com instalação por prévia + confirmação
(`components/IntegrationsPanel.tsx:30-248`). Carrega `GET /integrations[?projectId=]` (`:38-56`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C126 | "tentar de novo" | Relê as integrações | `IntegrationsPanel.tsx:107-114` |
| C127 | "dispensar" | Limpa o erro da ação | `IntegrationsPanel.tsx:115-122` |
| C128 | "Instalar…" / "Atualizar…" (gate) | Prévia `POST /integrations/:agente/hook {dryRun:true}`; só se instalável pelo painel, não instalado ou com timeout antigo, sem erro | `IntegrationsPanel.tsx:60-65`, `:130-133`, `:157-165` |
| C129 | "Registrar…" / "Atualizar…" (MCP) | Prévia do MCP; só se há MCP, não precisa de projeto, sem erro, não registrado ou desatualizado | `IntegrationsPanel.tsx:134-138`, `:188-196` |
| C130 | Confirmação "Gravar no arquivo" (perigo) + "Cancelar" | `POST …{dryRun:false, base}` (o daemon recusa se o arquivo mudou desde a prévia); ok `Gate/MCP gravado em <agente>` + `backup: …`; desabilitado se a prévia é `nada` | `IntegrationsPanel.tsx:67-85`, `:210-245` |

Estados do gate: `config ilegível`, `só vigilância`, `gate ativo nas sessões do Hub`, `gate
desligado`, `timeout antigo`, `gate ativo`; do MCP: `config ilegível`, `escolha o projeto`, `não
registrado`, `desatualizado`, `registrado`, e selo `formato não confirmado` (`logic/security.ts:284-303`,
`IntegrationsPanel.tsx:184-186`). Mostra o arquivo, a nota e, se não instalável pelo painel, o
comando de terminal (`:167-177`). Build incompleto: aviso com os pontos de entrada que faltam
(`:99-105`). Prévia: `Já está como o Hub gravaria. Nada a fazer.` ou `Cria/Altera <arquivo>. O
original fica num backup versionado ao lado.`, avisos e o diff linha a linha `+`/`-`/contexto/salto
(`:213-243`).

### 10.4 Aprovações (histórico)

Aprovações pedidas e resolvidas, a partir da auditoria (`components/ApprovalHistory.tsx:25-151`).
Duas consultas `GET /audit?kind=approval.requested|approval.resolved&limit=1000[&since][&projectId]`
juntadas por `approvalId`, mais recente primeiro (`:31-56`, `logic/security.ts:171-204`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C131 | Seleção "Período" | `última hora`, `últimas 24 h`, `últimos 7 dias` (padrão), `últimos 30 dias`, `todo o período`; rebusca | `ApprovalHistory.tsx:26`, `:68-77`, `logic/security.ts:97-103` |
| C132 | "Atualizar" | Rebusca | `ApprovalHistory.tsx:82-84` |
| C133 | "tentar de novo" | Rebusca depois de falha | `ApprovalHistory.tsx:88-95` |
| C134 | Id da sessão (link) | Abre a sessão na Timeline, se ela existe no índice (senão só texto) | `ApprovalHistory.tsx:132-143`, `App.tsx:514-516` |

Item: decisão (`aprovada`, `negada`, `expirada`, ou `pendente`), risco, `há X`, ação, `decidida por
<quem>` ou `sem decisão registrada`, `pedida por gate pré-execução|política` (`:102-145`). Contagem
`N aprovação(ões)`; vazio `Nenhuma aprovação neste período.` (`:79-81`, `:96-98`).

### 10.5 Auditoria

Trilha filtrável de `GET /audit` (`components/AuditTrail.tsx:30-211`). Rebusca a cada mudança de
filtro, exceto sessão digitada inválida (`:56-60`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C135 | Seleção "Tipo" | `todos` + 11 tipos (`decisão do gate`, `aprovação pedida`, …, `daemon encerrado`) | `AuditTrail.tsx:89-98`, `logic/security.ts:78-90` |
| C136 | Seleção "Período" | Mesmas opções de C131; padrão `últimas 24 h` | `AuditTrail.tsx:99-108`, `logic/security.ts:113-119` |
| C137 | Seleção "Projeto" | `todos` + projetos; começa no projeto da aba | `AuditTrail.tsx:36-38`, `:109-119` |
| C138 | Campo "Sessão" (com sugestões das 50 primeiras sessões) | Filtro por `ses_…`; inválido mostra `Id de sessão tem a forma ses_… (letras e números).` | `AuditTrail.tsx:120-141`, `logic/security.ts:136-139` |
| C139 | "Atualizar" | Rebusca; desabilitado com sessão inválida | `AuditTrail.tsx:147-149` |
| C140 | "Exportar JSON" | Baixa `auditoria-<data>.json` com as entradas carregadas | `AuditTrail.tsx:65-74`, `:150-152` |
| C141 | "tentar de novo" | Rebusca depois de falha | `AuditTrail.tsx:155-166` |
| C142 | "detalhes" (divulgação por registro) | Mostra `detail` em JSON | `AuditTrail.tsx:199-204` |

Consulta: `limit=200`, campos vazios não vão (`logic/security.ts:126-134`). Registro: tipo, decisão
com tom (verde/vermelho/âmbar — `logic/security.ts:142-148`), risco, `há X`, ação, `por <actor>`,
sessão, projeto, motivo (`AuditTrail.tsx:174-205`). Contagem `N registro(s)`; vazio `Nada registrado
com esses filtros.` (`:144-146`, `:168-170`).

## 11. Aba Configurações

Configuração **por projeto**, gravada no Hub (fora do repositório) via `GET/PUT
/projects/:id/context` (`components/SettingsView.tsx:19-34`, `:104-121`, `:150-167`). Aviso no topo
se projetos ou agentes falharam (`App.tsx:495`).

**Estado do formulário** (`logic/settings-form.ts:59-84`): trocar de projeto zera na hora; resposta
de outro projeto é ignorada; falha de carga deixa vazio e **travado**; editar e salvar só com o
contexto do projeto carregado. Salvar recarrega do que o daemon **devolveu** (`SettingsView.tsx:160-163`).
Com edição suja, fechar a janela pergunta (`beforeunload`, `:133-140`) e trocar de projeto pergunta
`Há alterações não salvas neste projeto. Descartar e trocar?` (`:142-148`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C143 | Seleção "Projeto" | Troca o projeto (pergunta se sujo); desabilitada sem projetos | `SettingsView.tsx:237-251` |
| C144 | "Salvar" | `PUT /projects/:id/context`; ok `configurações salvas no projeto`. Rótulo por estado: `salvando…`, `Não carregado`, `carregando…`, `Salvar`, `Salvo` | `SettingsView.tsx:150-167`, `:252-266` |
| C145 | "dispensar" | Limpa o erro da ação | `SettingsView.tsx:270-277` |
| C146 | "tentar de novo" (carga) | Relê o contexto; texto `Não foi possível carregar a configuração de "<nome>": <erro>. Nada foi alterado no projeto; a edição fica travada até carregar.` | `SettingsView.tsx:279-287` |
| C147 | "Registrar projeto" (Primeiros passos) | Abre o modal; aparece sem projeto e com a lista carregada | `SettingsView.tsx:289-303` |
| C148 | Navegação (5 botões: Prompts por agente, Memória do projeto, Modelos locais, Isolamento, Agentes detectados) | Troca a subaba; sem projetos começa em Agentes detectados, senão em Prompts | `SettingsView.tsx:80`, `:306-342`, `:631-653` |
| C149 | Chips de agente (`radiogroup`, um por agente) | Escolhe o agente editado (Prompts e Modelos); setas trocam; só o marcado no Tab | `SettingsView.tsx:663-711` |
| C150 | Área "Instruções para <agente>" | Edita `prompts.<agente>` | `SettingsView.tsx:359-375` |
| C151 | Área "Regras da casa" | Edita `memory` | `SettingsView.tsx:385-407` |
| C152 | Campo "Endereço da API `<VAR>`" | Edita a variável de base URL que o agente lê; aviso de envio da credencial | `SettingsView.tsx:433-469` |
| C153 | Sugestões "Ollama", "LM Studio", "vLLM" | Preenchem `http://localhost:11434/v1`, `:1234/v1`, `:8000/v1`; só para variável `OPENAI_*` | `SettingsView.tsx:56-60`, `:450-463` |
| C154 | Campo "Chave `<VAR>`" (senha) | Edita a chave; aviso de gravação em texto puro | `SettingsView.tsx:471-503` |
| C155 | Mostrar/ocultar chave (👁️/🙈) | Alterna o campo entre senha e texto | `SettingsView.tsx:485-493` |
| C156 | Campo "Modelo `MODEL`" | Só se o agente aceita modelo por invocação; vazio = padrão do CLI. A ajuda diz que não pode começar com `-` (`SettingsView.tsx:525`), mas o painel não valida isso (`logic/settings-form.ts:126-149`) | `SettingsView.tsx:508-529`, `logic/settings-form.ts:126-149` |
| C157 | "remover" (variável extra) | Remove a variável do env do agente | `SettingsView.tsx:544-566` |
| C158 | Campo "NOME_DA_VARIAVEL" | Força maiúsculas; avisa prefixo não permitido e `*_BASE_URL` | `SettingsView.tsx:569-575`, `:591-604` |
| C159 | Campo "valor" | | `SettingsView.tsx:576-582` |
| C160 | "adicionar" | Acrescenta a variável; exige nome e valor | `SettingsView.tsx:217-223`, `:583-589` |

Campos editáveis ficam desabilitados fora do estado "pronto" (`SettingsView.tsx:99`). Valor vazio num
campo de env **remove** a variável (`:177-184`). Variáveis extras com nome `*_KEY/_TOKEN/_SECRET/
_PASSWORD` aparecem mascaradas `••••<4 finais>` (`logic/settings-form.ts:174-181`); extra não
reconhecida para o agente gera `⚠️ nada indica que "<agente>" leia esta variável — pode não ter
efeito` (`SettingsView.tsx:550-555`, `logic/settings-form.ts:188-194`). Lista de prefixos aceitos vem
de `prefixosDeEnvPermitidos()` do core (`SettingsView.tsx:68`, `:533-542`). Agente sem variável de
provedor: aviso de que não há o que ajustar (`:425-431`). **Isolamento** é só explicativo: tabela dos
modos `supervised`/`semi`/`autonomous` e `N de M agentes têm essa tradução declarada`
(`SettingsView.tsx:725-780`).

### 11.1 Agentes detectados

O que cada CLI tem na máquina, só leitura, e importação em dois tempos
(`components/DiscoveryPanel.tsx:51-550`). Carrega `GET /discovery` (`:63-79`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C161 | "Atualizar todos" | `GET /discovery/:id?refresh=1` de cada agente | `DiscoveryPanel.tsx:95-109`, `:121-128` |
| C162 | "Registrar projeto" (link, sem projeto) | Abre o modal | `DiscoveryPanel.tsx:131-144` |
| C163 | "tentar de novo" | Relê a descoberta | `DiscoveryPanel.tsx:146-153` |
| C164 | "Atualizar" (por agente) | `GET /discovery/:id?refresh=1` | `DiscoveryPanel.tsx:81-93`, `:220-222` |
| C165 | "Importar para o projeto" (por agente) | Abre/fecha o fluxo de importação; desabilitado se não instalado (`Agente não instalado: nada a importar`) ou sem projeto (`Crie um projeto primeiro`) | `DiscoveryPanel.tsx:198`, `:223-236` |
| C166 | Caixas "O que importar" (Instruções, Ambiente, Servidores MCP) | Marca os tipos; padrão só Instruções; qualquer mudança invalida a prévia | `DiscoveryPanel.tsx:325`, `:337-348`, `:392-403` |
| C167 | Caixas "Registrar os servidores MCP em" (uma por outro agente) | Destinos do MCP; só com MCP marcado; exige ≥ 1 (`Escolha ao menos um agente de destino para o MCP.`) | `DiscoveryPanel.tsx:349-354`, `:405-438` |
| C168 | Caixa "Levar também as variáveis de ambiente dos servidores" | `includeEnv` | `DiscoveryPanel.tsx:419-434` |
| C169 | Caixa "Sobrescrever o que já existe no destino" | `overwrite` | `DiscoveryPanel.tsx:441-454` |
| C170 | "dispensar" | Limpa o erro da ação | `DiscoveryPanel.tsx:456-463` |
| C171 | "Pré-visualizar" | `POST /projects/:id/import {…, dryRun:true}` | `DiscoveryPanel.tsx:364-371`, `:466-471` |
| C172 | "Aplicar…" | Abre confirmação; desabilitado se a prévia não tem itens | `DiscoveryPanel.tsx:472-481` |
| C173 | Confirmação "Cancelar" / "Confirmar e aplicar" | `POST …/import {…, dryRun:false}`; ok `importado de <agente> para <projeto>` | `DiscoveryPanel.tsx:373-382`, `:486-502` |

Cartão (`DiscoveryPanel.tsx:200-303`): agente, `instalado`/`não instalado`, versão, autenticação
(`autenticado`, `sem credencial`, `auth desconhecida`, evidência na dica), binário, modelo/provedor
e base URL, servidores MCP (nome, transporte, selo `hub`, **só os nomes** das variáveis, fonte),
arquivos de instrução com tamanho, avisos. Texto da confirmação: `Isto grava N alteração(ões) em
<projeto> e nos destinos listados acima. A prévia não escreveu nada; aplicar escreve.` (`:488-492`).
Resultado: `Prévia — nada foi gravado` ou `Aplicado`, itens com tipo, descrição, destino e
`aplicado`/`não aplicado`, e `Pulados` com motivo (`:507-545`). Estados: `Procurando agentes…`;
vazio `Nenhum agente detectado…` (`:155-162`).

## 12. Modais, confirmações e estados padrão

### 12.1 Nova Sessão / Delegar

Mesmo modal nos dois modos (`components/SessionModal.tsx:69-458`). Título `Iniciar Nova Sessão` ou
`Delegar a partir de <agente>`; descrição `Selecione o projeto, agente e defina os objetivos da
execução.` ou `Transfere uma sub-tarefa para outro agente especialista.` (`:212-219`). Foco inicial no Objetivo (`:193`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C174 | "+ Registrar nova pasta" | Abre Registrar projeto **por cima**; o que foi digitado fica; o projeto novo vira o escolhido | `SessionModal.tsx:234-236`, `App.tsx:836-839`, `:849` |
| C175 | Seleção "Projeto & Pasta" | `nome — caminho`; só em Nova Sessão; vazio `Nenhum projeto registrado`; falha `⚠️ Não foi possível buscar os projetos — tente de novo mais tarde.` | `SessionModal.tsx:230-256`, `:99-121` |
| C176 | Cartões de agente (um por agente, `aria-pressed`) | Escolhe o agente; instalados primeiro, depois por nome; ausente desabilitado com `não instalado` e o motivo na dica | `SessionModal.tsx:125-129`, `:283-313` |
| C177 | Modelos (4 chips: Nova Feature, Corrigir Bug, Refatoração, Criar Testes) | Preenchem objetivo e critérios | `SessionModal.tsx:26-47`, `:323-335` |
| C178 | Área "Objetivo da Tarefa" | Obrigatório, ≥ 8 caracteres aparados | `SessionModal.tsx:338-348`, `logic/session-form.ts:23`, `:73-75` |
| C179 | Área "Critérios de Aceite (Opcional)" | Um critério por linha (linhas vazias descartadas) | `SessionModal.tsx:350-359`, `:165-168` |
| C180 | Seleção "Supervisão" | `Semi-autônomo` (padrão), `Supervisionado`, `Autônomo`, com a ajuda da escolhida embaixo | `SessionModal.tsx:58-62`, `:90`, `:363-380` |
| C181 | Seleção "Isolamento" | `Git worktree` (padrão), `Pasta principal`, com ajuda | `SessionModal.tsx:64-67`, `:91`, `:382-399` |
| C182 | Campo "Teto Orçamentário (USD)" | Padrão `2.00` (Nova Sessão) ou `0.50` (Delegar); passo 0,50 | `SessionModal.tsx:89`, `:401-421` |
| C183 | "Cancelar" | Fecha; desabilitado enviando | `SessionModal.tsx:443-445` |
| C184 | "Iniciar Sessão" | Nova: `POST /sessions {projectId, brief}`, toast `Sessão iniciada com sucesso.`; Delegar: `POST /sessions/:id/delegate {brief}`, toast de delegação; seleciona a sessão nova, vai para a Timeline e recarrega o índice. `Iniciando…` | `SessionModal.tsx:149-190`, `:446-453`, `App.tsx:829-835` |

**Validação** (`logic/session-form.ts:52-84`); o botão Iniciar fica desabilitado enquanto houver
erro (`SessionModal.tsx:145`, `:450`):
- Agente: `Escolha um agente.`; ausente `<nome> não está instalado nesta máquina — escolha outro
  agente.` (exibido em linha, `:315-319`).
- Objetivo: `Descreva o objetivo (ao menos 8 caracteres).` (não exibido em linha — só desabilita).
- Projeto (só Nova Sessão): `Escolha ou registre um projeto.` (não exibido em linha).
- Teto: aceita vírgula decimal; faixa **0,10 a 50,00**: `Informe o teto, entre US$ 0.10 e US$
  50.00.`, `O teto precisa ser um número, …`, `O teto precisa ficar entre US$ 0.10 e US$ 50.00.`
  (exibido em linha, `aria-invalid`, `:411-420`).

Brief enviado: `agent`, `objective` aparado, `acceptanceCriteria[]`, `isolation`, `supervision`,
`budget.usd` (`SessionModal.tsx:162-172`). Agente padrão: o pré-escolhido, senão o primeiro instalado
(`:82-86`). Projeto padrão: o do filtro, se existir; senão o primeiro (`:106-113`). Aviso de
agentes ausentes `N não está/estão nesta máquina` (`:270-275`). Nota fixa: `As diretrizes deste
projeto entram automaticamente. Edite-as em Configurações.` (`:433-437`). Delegação retida pela
política: aviso `Delegação retida pela política` / `Aguardando sua decisão na fila de aprovações:
<ação>.`; senão `Delegação iniciada para <agente>.` (`lib/sessionControls.ts:117-133`). Com texto
digitado, clique no fundo **não** fecha (`SessionModal.tsx:192-194`, `useDialog.ts:126-140`).

### 12.2 Registrar Novo Projeto

Cria o projeto, vincula pastas extras e grava diretrizes, em etapas **retomáveis**
(`components/ProjectModal.tsx:28-246`, `logic/project-registration.ts:62-119`). Foco inicial no
caminho (`ProjectModal.tsx:175`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C185 | Campo "Caminho da Pasta Principal *" | Obrigatório; preenche o nome com o último segmento se o nome está vazio; só leitura depois de criado | `ProjectModal.tsx:155-185` |
| C186 | Campo "Nome de Exibição do Projeto" | Opcional (padrão: nome da pasta, senão `Projeto`); só leitura depois de criado | `ProjectModal.tsx:72`, `:187-197` |
| C187 | Área "Pastas Adicionais Vinculadas (Opcional)" | Uma por linha | `ProjectModal.tsx:199-208` |
| C188 | Área "Diretrizes & Regras do Projeto (Memória Local)" | Vira a memória do projeto | `ProjectModal.tsx:210-223` |
| C189 | "Cancelar" / "Fechar" | Fecha (rótulo `Fechar` depois de criado) | `ProjectModal.tsx:227-229` |
| C190 | "Criar & Vincular Projeto" / "Concluir" | `POST /projects {path,name}`, depois `POST …/folders` por pasta extra, depois `PUT …/context {memory}` só se as diretrizes aparadas não estiverem vazias e diferirem das já gravadas (`logic/project-registration.ts:89-90`); `Registrando…`; desabilitado sem caminho | `ProjectModal.tsx:62-115`, `:230-241` |

Validação local do caminho: vazio `Informe o caminho da pasta do projeto.`; relativo `Use o caminho
absoluto da pasta (ex.: C:\Projetos\MeuApp ou /home/voce/app) — caminho relativo seria resolvido
contra a pasta do daemon.` (absoluto = `X:\`, `X:/`, `\\` ou `/`) (`logic/project-path.ts:13-25`).
Recusa `INVALID_PATH` do daemon vira `O Hub recusou o caminho: <motivo>` junto do campo
(`logic/project-path.ts:34-41`). **Parcial:** o projeto criado não é recriado; pastas que já entraram
não são reenviadas; o aviso `Projeto criado, mas N pasta(s) não foram vinculadas: … ; as diretrizes
não foram gravadas: …. Corrija e clique em "Concluir" para tentar só o que falta.` aparece no modal e
num toast `Projeto criado com pendências`; a lista de projetos já mostra o novo
(`ProjectModal.tsx:97-114`, `logic/project-registration.ts:108-119`). Completo: toast `projeto
registrado`, fecha e seleciona o projeto no filtro (`ProjectModal.tsx:100-104`, `App.tsx:846-851`).
Com texto digitado, clique no fundo não fecha (`ProjectModal.tsx:117-119`).

### 12.3 Paleta de comandos (Ctrl/⌘+K)

Combobox com foco no campo; setas movem o item ativo; Enter executa e fecha
(`components/CommandPalette.tsx:45-271`).

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C191 | Campo "Buscar sessões, agentes ou ações…" | Filtra; filtro novo volta ao 1º item. ↑/↓ (circular), Ctrl+Home/Ctrl+End, Enter | `CommandPalette.tsx:135`, `:153-172`, `:207-221` |
| C192 | Item de resultado (`option`) | Clique executa; passar o mouse torna ativo | `CommandPalette.tsx:232-246` |

Grupos, na ordem (`CommandPalette.tsx:31-35`, `:66-132`): **Ações rápidas** — `Criar nova sessão`
(casa com "criar nova sessão"/"nova sessão") → abre Nova Sessão; **Iniciar com agente (N)** — só
agentes não marcados como ausentes, casa com id, nome ou vendor → Nova Sessão com o agente;
**Sessões (N)** — até 6, casa com id, título ou agente → seleciona e vai para a Timeline
(`App.tsx:865-871`). Vazio: `Nenhum resultado para “<texto>”` (`:250-254`). Rodapé: `↑ ↓ navegar`,
`Enter abrir`, `Esc fechar` (`:256-267`).

### 12.4 Diálogo de confirmação (Segurança)

Usado por Política, Confiança e Gate/MCP (`components/ConfirmDialog.tsx:32-75`): título, resumo,
conteúdo (lista do que muda ou diff), **foco inicial em "Cancelar"** para Enter por reflexo não
gravar, botão de confirmar vermelho quando `perigo`, `gravando…` enquanto ocupado.

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C193 | "Cancelar" | Fecha; desabilitado ocupado | `ConfirmDialog.tsx:59-61` |
| C194 | Botão de confirmar (rótulo variável) | Executa; desabilitado ocupado ou `confirmarDesabilitado` | `ConfirmDialog.tsx:62-69` |

Confirmações **em linha** (não modais, `role="alertdialog"`, foco no botão de ação): encerrar sessão
(C049), remover pasta (C092), desanexar (C102), recolher worktrees (C107). Aplicar importação (C173) também é em linha (`role="alertdialog"`), mas
**sem** foco inicial definido (`DiscoveryPanel.tsx:486-502`).
Confirmações do sistema (`window.confirm`): troca de aba, de seção/projeto na Segurança, de camada
na política e de projeto em Configurações (§1.1, §10, §10.1, §11).

### 12.5 Estados padrão de tela

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C195 | "Tentar de novo" de `EstadoDaTela` | `refresh()` do índice | `components/EstadoDaTela.tsx:50-52` |

`EstadoDaTela` (`EstadoDaTela.tsx:12-57`): `carregando` → `Carregando <o quê>…` (`role="status"`);
`erro` → `Não foi possível carregar <o quê>` + `O Hub não respondeu como devia — isto não é uma lista
vazia. <erro>` (`role="alert"`); versão compacta de uma linha; nada em `ok`/`vazio`. Regra geral do
painel: **falha nunca vira "vazio"**.

### 12.6 Rótulos de ocupado

Enquanto a ação roda, o botão troca o rótulo (e fica desabilitado):

| Rótulo | Botão | Fonte |
|---|---|---|
| `…` | Liberar/Negar, Interromper, Pausar, Encerrar | `Approvals.tsx:128-129`, `:154-155`, `SidePanel.tsx:318`, `:345`, `:391` |
| `Transferindo…` | Confirmar Handoff | `SidePanel.tsx:486` |
| `Iniciando…` | Iniciar Sessão | `SessionModal.tsx:452` |
| `Registrando…` | Criar & Vincular Projeto / Concluir | `ProjectModal.tsx:237` |
| `gravando…` | confirmar do `ConfirmDialog` | `ConfirmDialog.tsx:68` |
| `revisando…` | Revisar alterações | `PolicyEditor.tsx:271` |
| `salvando…` | Salvar (Configurações) | `SettingsView.tsx:258` |
| `atualizando…` | Atualizar todos / Atualizar (por agente) | `DiscoveryPanel.tsx:127`, `:221` |
| `gerando prévia…` | Pré-visualizar | `DiscoveryPanel.tsx:470` |
| `aplicando…` | Confirmar e aplicar | `DiscoveryPanel.tsx:498` |
| `Salvando…` | Salvar teto | `ops/SessaoOps.tsx:415` |
| `Validando…` | Validar | `ops/WorkflowOps.tsx:200` |
| `Disparando…` | Executar | `ops/WorkflowOps.tsx:214` |
| `Removendo…` | Remover pasta | `ops/ProjetoOps.tsx:166` |
| `Adicionando…` | Adicionar pasta | `ops/ProjetoOps.tsx:204` |
| `Registrando…` | Adotar sessão | `ops/ProjetoOps.tsx:294` |
| `Desanexando…` | Desanexar (confirmação) | `ops/ProjetoOps.tsx:348` |
| `Sondando…` | Re-sondar agentes | `ops/SaudeOps.tsx:97` |
| `Recolhendo…` | Recolher worktrees… | `ops/ManutencaoOps.tsx:46` |

### 12.7 Controles restantes

| # | Controle | O que faz | Fonte |
|---|---|---|---|
| C196 | Fundo escuro das gavetas | Clique fecha as gavetas (sem devolver foco) | `App.tsx:582-584` |
| C197 | Fundo escuro dos modais | Clique que **começou** no fundo fecha, exceto com formulário sujo | `useDialog.ts:126-140` |
| C198 | Fundo da paleta | Clique que começou no fundo fecha, **sem** checar texto digitado (a paleta não passa `sujo`) | `CommandPalette.tsx:62`, `:182` |

## 13. Tema, responsividade e toasts

### 13.1 Tema

Sem escolha salva, segue o sistema (claro/escuro) e acompanha mudanças do sistema com a janela
aberta; a escolha explícita é gravada (`agents-hub:tema` no `localStorage`) e vence o sistema
(`theme.ts:3-67`, `styles.css:90-98`, `:144`). Tokens (`styles.css:11-87` escuro; `:96-142` e
`:144-188` claro, idênticos):

| Token | Escuro | Claro |
|---|---|---|
| `--bg` | `#06080d` | `#eef1f6` |
| `--bg-panel` | `#0d121c` | `#ffffff` |
| `--bg-raised` | `#141b29` | `#f1f4f9` |
| `--bg-card` | `#111724` | `#fbfcfe` |
| `--bg-hover` | `#1c2538` | `#e4e9f1` |
| `--bg-active` | `#243149` | `#d8e1ee` |
| `--bg-code` | `#04060a` | `#eef2f7` |
| `--bg-glass` | `rgba(13,18,28,.85)` | `rgba(255,255,255,.88)` |
| `--border` / `-subtle` / `-strong` | branco 8 % / 4 % / 16 % | `#0f172a` 12 % / 6 % / 24 % |
| `--border-focus` | `rgba(56,189,248,.6)` | `rgba(3,105,161,.6)` |
| `--text` | `#f8fafc` | `#0f172a` |
| `--text-dim` | `#94a3b8` | `#3f4c5f` |
| `--text-faint` | `#8593a8` | `#536176` |
| `--text-invert` | `#06080d` | `#ffffff` |
| `--warn-text` | `#fbbf24` | `#92400e` |
| `--danger-text` | `#f87171` | `#b91c1c` |
| `--accent` / `-hover` | `#38bdf8` / `#7dd3fc` | `#0369a1` / `#075985` |
| `--ok` | `#10b981` | `#047857` |
| `--warn` | `#f59e0b` | `#92400e` |
| `--danger` | `#ef4444` | `#b91c1c` |
| `--busy` | `#a855f7` | `#7e22ce` |
| `--handoff` | `#818cf8` | `#4f46e5` |
| `--agent-1..8` | `#38bdf8 #a78bfa #34d399 #fbbf24 #f472b6 #fb923c #2dd4bf #a3e635` | `#0369a1 #6d28d9 #047857 #92400e #be185d #c2410c #0f766e #3f6212` |
| `--on-agent` | `#06080d` | `#ffffff` |

Os tokens `*-glow`, raios (6/9/14/18 px), sombras e fontes (pilha do sistema, sem fonte externa)
estão em `styles.css:56-87`. Contraste: `--text-faint` foi escolhido para ≥ 4,9:1 e as cores de agente
para 4,5:1 como texto e como fundo de avatar (`styles.css:33-42`). **Cor por agente** é estável:
hash `h = h*31 + código` do id, módulo 8 (`hub.ts:21-27`). Cores de estado dos pontos: `running` =
`--busy` pulsando, `completed` = `--ok`, `failed`/`killed` = `--danger`, `waiting_approval`/`paused`
= `--warn` (`styles.css:1323-1344`).

### 13.2 Responsividade

| Largura | Efeito | Fonte |
|---|---|---|
| ≤ 1200 px | abas só com ícone (rótulo continua acessível), some a versão; coluna direita vira **gaveta** (botão Painel); grade 280 px + flexível | `styles.css:744-763`, `:3112-3140`, `App.tsx:172` |
| ≤ 1000 px | busca vira ícone, some o texto da marca e o atalho | `styles.css:765-786` |
| ≤ 900 px | navegação lateral de Configurações/Segurança vira faixa que quebra linha; o subtítulo de cada botão some; cartão com menos margem | `styles.css:3788-3805` |
| ≤ 768 px | ações da topbar só com ícone; coluna de fluxos vira **gaveta** (botão ☰); 1 coluna; cartões da Operação com menos margem e título menor | `styles.css:788-807`, `:3142-3172`, `App.tsx:173`, `components/ops/ops.css:419-427` |
| ≤ 600 px | abas e tema vão para o menu ⋮; rótulo "ao vivo" some; cabeçalho da timeline, aprovações e compositor quebram linha; modais com menos margem; abas com menos margem; em Agentes detectados o rótulo fica acima do valor; botões de ação da Segurança esticam | `styles.css:809-830`, `:3174-3200`, `:2294-2298`, `:2833-2840`, `:3892-3900`, `security.css:326-333` |

Gavetas: só com a aba Timeline; uma de cada vez; a que abre recebe o foco no primeiro controle; a
fechada fica `inert`; Esc ou clique no fundo fecham (`App.tsx:166-209`). A vistoria 9.3 mediu 1440,
1100, 768 e 375 px sem sobreposição, corte ou rolagem horizontal
(`docs/vistoria-2026-09-25/STATUS.md:305-307`). Com "reduzir movimento" do sistema, animações e
transições são anuladas (`styles.css:214-223`), inclusive os indicadores de carregamento:
`live-panel.css:148-153` declara 2,4 s para eles, mas a regra `!important` vence. Conferidos todos os 16 `@media` dos 4
arquivos CSS: `styles.css` (13), `live-panel.css` (1), `security.css` (1), `ops/ops.css` (1) — o de
`prefers-color-scheme` está em §13.1.

### 13.3 Toasts

Fila global no canto inferior direito, `role="status" aria-live="polite"` (`components/Toasts.tsx:3-35`).
Três tipos: `ok` (4 s), `warn` (8 s), `error` (12 s); no máximo 3 na tela, sai o mais antigo
(`lib/toastPolicy.ts:10-28`, `actions.ts:30-40`). **Toda ação que falha** gera toast de erro, além do
erro no lugar da ação (`actions.ts:127-152`). Tradução do erro (`actions.ts:90-116`): 403 → `O Hub
recusou a ação (403)` + `— a origem da página não é a que o daemon aceita.`; erros de validação
listam `campo: mensagem` de `details.issues` (`actions.ts:66-80`); resposta não-JSON → `Resposta
inválida do Hub`; falha de conexão → `Não foi possível falar com o Hub` / `A conexão falhou.`

### 13.4 Formatação

`US$ x.xxxx` (`hub.ts:31-33`); curto: `US$ 0`, 4 casas abaixo de 0,01, senão 2 casas (`hub.ts:36-40`);
tokens `1.2k`/`3.4M` (`lib/tokens.ts:6-10`); duração `Ns`, `Nm Ns`, `Nh Nm` (`hub.ts:42-47`); relativo
`agora` (< 45 s), `há Nmin`, `há Nh`, `há Nd` (`hub.ts:54-60`).

## 14. Atalhos de teclado e acessibilidade exigida

| Tecla | Onde | Efeito | Fonte |
|---|---|---|---|
| Ctrl/⌘+K (sem Alt/Shift) | global | Abre/fecha a paleta; não abre por cima de outro diálogo | `App.tsx:219-225` |
| Esc | gaveta aberta, sem diálogo | Fecha as gavetas e devolve o foco ao botão que abriu | `App.tsx:226-229`, `:195-200` |
| Esc | diálogo | Fecha só o diálogo do topo da pilha | `useDialog.ts:80-87` |
| Tab / Shift+Tab | diálogo | Foco preso dentro dele | `useDialog.ts:88-104` |
| `/` | global | Foca o compositor, exceto com foco em campo, diálogo, gaveta aberta ou campo desabilitado | `Composer.tsx:39-64`, `lib/composerShortcut.ts:26-30` |
| Enter / Shift+Enter | compositor | Envia / quebra linha | `Composer.tsx:104-109` |
| ↑ ↓, Ctrl+Home/End, Enter | paleta | Navega e executa | `CommandPalette.tsx:153-172` |
| ↑ ↓ Home End, Esc, Tab | menu ⋮ | Navega; Esc fecha e devolve o foco; Tab fecha | `TopbarMenu.tsx:58-80` |
| ↑ ↓ | lista de fluxos | Move entre cabeçalhos e nós | `FlowList.tsx:62-69` |
| ↑ ↓ Home End → ← | árvore do DAG | Navega (→ 1º filho, ← pai) | `DagCanvasView.tsx:201-207`, `lib/flowTree.ts:87-116` |
| setas | chips de agente | Trocam o agente marcado | `SettingsView.tsx:673-684` |
| Enter / Espaço | cabeçalho do raciocínio | Expande/recolhe | `Timeline.tsx:279-284` |
| Enter | formulários da Operação | Submete (teto, pasta, adoção) | `SessaoOps.tsx:403-409`, `ProjetoOps.tsx:178-184`, `:267-273` |

Acessibilidade que o painel exige hoje (a UI nativa deve oferecer o equivalente):

- **Diálogo modal** (`useDialog.ts:3-116`): foco inicial (campo indicado, `[data-autofocus]` ou o
  primeiro focável), foco preso, Esc fecha, **fundo inerte** (os toasts ficam fora e continuam
  dispensáveis), foco devolvido a quem abriu, pilha de diálogos (só o topo reage). Todos os modais
  têm `role="dialog" aria-modal="true"` com título ligado (`aria-labelledby`). Descrição ligada
  (`aria-describedby`): Nova Sessão e Registrar projeto sempre; `ConfirmDialog` só quando há resumo
  (`ConfirmDialog.tsx:47`); a paleta não tem (`CommandPalette.tsx:183-189`).
- **Gavetas fechadas fora do Tab** (`inert`) e fora da árvore de acessibilidade (`App.tsx:592`, `:799`).
- **Foco visível**: contorno de 2 px em `--accent` (`styles.css:237-241`).
- **Anúncios**: fila de aprovações e toasts `polite`; erros `role="alert"`; carregamentos
  `role="status"`; timeline `role="log" aria-live="off"` com `aria-busy` ao carregar anteriores
  (`Timeline.tsx:199-205`).
- **Papéis**: segmentos com `aria-pressed`; abas com `aria-current="page"`; DAG como `tree`/`treeitem`
  com `aria-level`/`aria-selected`/`aria-expanded` e tabulação itinerante; chips como
  `radiogroup`/`radio`; paleta como `combobox` + `listbox` com `aria-activedescendant`; menu ⋮ como
  `menu`/`menuitemradio`; barra de orçamento `progressbar`; divulgações com `aria-expanded`.
- **Rótulos escondidos por largura continuam no nome acessível** (`App.tsx:274-279`).
- **Estado não depende só de cor**: nó da árvore tem o estado em texto para leitor de tela
  (`FlowTree.tsx:61`).

## 15. Pendências do worker K (Fase 9.3) como requisitos

Achados da vistoria do painel no navegador, atribuídos ao worker K (fase em
`docs/vistoria-2026-09-25/STATUS.md:304-310`; achados em `:308-310`). **Os defeitos K2–K4 continuam
no código da `main`** (conferido em `fe69182`; causas na tabela). Pela [ADR 07](../decisoes/07-reescrita-nativa.md) 7.10 viram requisitos
da UI em C:

| Id | Achado (STATUS.md:308-310) | Causa conferida no TS | Requisito para a UI nativa |
|---|---|---|---|
| K1 | `/favicon.ico` 404 = erro de console em toda carga nova | `packages/web/index.html:1-13` não declara ícone (só `meta`, `title` e o script) | **NÃO DETERMINADO** o equivalente nativo: janela sem navegador não pede favicon. Ícone de janela/bandeja/instalador não está especificado no plano — ver Lacunas |
| K2 | Gaveta aberta deixa o fundo focável (11 controles em 1100 px, 4 em 768/375) | Com gaveta aberta só a gaveta fechada fica `inert`; a coluna central e a topbar continuam no Tab (`App.tsx:582-593`, `:687`, `:794-800`) | Com uma gaveta aberta, o resto da janela sai da ordem de foco (como o fundo de um modal) |
| K3 | Contador "Todos" mostra 0 até ser clicado (8 sessões) | `Todos` usa `filteredFlows.length`, que já passou pelo filtro `active` quando "Ativos" está marcado (`App.tsx:244-247`, `:637`) | O contador de "Todos" conta todos os fluxos do projeto/busca, independente do segmento marcado |
| K4 | Markdown do agente aparece cru na timeline | O texto vai cru (`Timeline.tsx:297`, `:322`, `:337`, `:354`, `:378`) | Renderizar markdown nas mensagens do agente. Quais elementos e onde (só `message`? `reasoning`?) é **NÃO DETERMINADO** — o STATUS não especifica |

## 16. Lacunas para a UI em C (não decididas)

Itens que o painel resolve com recursos do navegador e que a janela nativa terá de resolver de
outro jeito. Nenhum está especificado no plano; ficam registrados, não resolvidos.

- **Token de operador.** O painel recebe o token por cookie `HttpOnly` e o daemon registra a ação
  como `web` (`packages/daemon/src/operator-auth.ts:177-178`). Por cabeçalho, o autor vira
  `cli:<usuário>` a menos que venha `X-Hub-Client: web` (`operator-auth.ts:172-175`). Como a UI
  nativa se identifica (e o que aparece em "decidida por" na auditoria) é **NÃO DETERMINADO**.
- **Confirmações `window.confirm` e `beforeunload`** (§12.4, §11): precisam de equivalente nativo;
  com o ciclo de vida da ADR 7.5 (fechar a janela não encerra o serviço), o comportamento de
  "fechar com edição não salva" é **NÃO DETERMINADO**.
- **Persistência da escolha de tema** (`localStorage`, `theme.ts:13-31`): local de gravação no app
  nativo **NÃO DETERMINADO**.
- **Notificação do SO** (§3.7): a condição "janela em segundo plano" vira, no app nativo com
  bandeja, algo a definir (**NÃO DETERMINADO**).
- **Seletor de arquivo, área de transferência e download** (C083, C074, C140): exigem diálogos
  nativos.
- **Detalhes do `EventEnvelope`, `SessionSummary` etc.** não estão aqui: os tipos estão em
  `packages/core` e `packages/client/src/types.ts` e ficam para a spec da API.

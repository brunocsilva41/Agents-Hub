# 04 - Vistoria ao vivo do painel web (porta 48201, daemon isolado, 3 agentes falsos)

Método: daemon isolado (home temporária, manifests falsos raiz/filho/neto), dados criados via HTTP (fluxos raiz>filho>neto, sessão supervisionada com aprovação pendente), painel aberto no navegador embutido em 1440, 1200, 1100, 1000, 768 e 375 px. Screenshots do painel embutido saem em 800x500 (escala); medições foram feitas por JS (getBoundingClientRect / elementFromPoint), console e rede. Não existe tema claro no painel (só escuro; `color-scheme` claro emulado não altera nada). Console: só 2 erros de rede, ambos esperados (409 CONCURRENCY_EXCEEDED e 400 ILLEGAL_STATE provocados por mim).

Contagem: ALTO 2, MÉDIO 6, BAIXO 6.

---

### [ALTO] Mobile 375 px: topbar estoura e todas as abas, busca, "Nova Sessão" e "Painel" ficam inalcançáveis
**Evidência** `packages/web/src/styles.css:2640-2690`: só há dois `@media` (1200 e 768) e nenhuma regra para a topbar. Viewport 375x812:
`.nav-tab` lefts = Timeline 263, Grafo DAG 363, Swarm 471, Telemetria 578, Configurações 686 (medido em unidades CSS, em viewport de 375); `.spotlight-btn` 851-881, `.status.pill` 879-960, `.panel-toggle` 970-1035, `.btn-hero-new` 1045-1173. `.topbar` `scrollWidth` 1173 contra `clientWidth` 375; `html/body/#root>*` têm `overflow-x: hidden`, então não há rolagem horizontal. Screenshot: só aparecem o hambúrguer, o logo e "Timeline"; "Grafo DAG" fica cortado.
Passos: redimensionar para 375x812, abrir http://127.0.0.1:48201/ -> só a aba Timeline é clicável.
**Impacto** No celular não dá para trocar de tela (DAG, Swarm, Telemetria, Configurações), abrir a paleta, criar sessão pelo botão principal nem abrir o painel direito (orçamento, Interromper/Pausar/Encerrar/Transferir). O botão "Painel" (`.panel-toggle`) existe mas está fora da tela; sem ele os controles da sessão são inacessíveis.
**Correção sugerida** Em `@media (max-width: 768px)`: `.topbar { flex-wrap: wrap; gap: 8px }`, `.nav-tabs { overflow-x: auto; order: 3; width: 100%; flex: 1 0 100% }`, esconder o texto de `.spotlight-btn` (ficar só ícone) e `.btn-hero-new` só com "+". Alternativa: tab bar inferior.
**Esforço** M

### [ALTO] Tablet 768-~1116 px: topbar também estoura; "Nova Sessão", indicador ao vivo e busca cortados; busca vira coluna de texto sobreposta
**Evidência** Viewport 768: `.topbar` scrollWidth 1173 / clientWidth 768; `.btn-hero-new` 1045-1173, `elementFromPoint` sobre ele devolve vazio. Viewport 1000: scrollWidth 1116, botão termina em 1116. Viewport 1100: scrollWidth 1116 > 1100. Em 1200 está ok (1180). No screenshot de 1100 px, o texto do `.spotlight-btn` ("Buscar sessões, agentes, comandos...") quebra em várias linhas dentro de uma caixa estreita e se sobrepõe ao pill "1 Ao Vivo" e ao botão "Painel". No screenshot de 768 "Configurações" aparece cortada ("Configu").
Passos: redimensionar para 1000x800 ou 768x1024, olhar a topbar.
**Impacto** O CTA principal e o contador ao vivo somem em tablets e janelas estreitas de desktop; sobreposição visível na busca.
**Correção sugerida** `min-width: 0; flex-shrink` nos itens, `.spotlight-btn { min-width: 0; flex: 1 1 120px } .spotlight-btn span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }`, encolher as abas para só ícone abaixo de 1200 e permitir `flex-wrap`.
**Esforço** M

### [MÉDIO] Atalho anunciado Ctrl/⌘+K não abre a paleta de comandos (só fecha); "N" e setas/Enter também não funcionam
**Evidência** `packages/web/src/components/CommandPalette.tsx:34-40`: o handler de `keydown` só faz `if (isOpen) onClose()` para Ctrl+K; nenhum código abre a paleta (`grep keydown` só acha esse arquivo e `Composer.tsx` para "/"). O botão mostra `<kbd>⌘K</kbd>` (`.spotlight-btn`) e na paleta a linha "Criar Nova Sessão" mostra a dica "N" sem handler algum. Reproduzido: `Ctrl+K` real e `dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true}))` -> `.cmd-input` não aparece. Com a paleta aberta pelo botão, digitar "precisa", `ArrowDown`, `Enter`: nada acontece (só clique com mouse seleciona). "Criar Nova Sessão" permanece na lista mesmo com filtro sem relação.
**Impacto** Atalho documentado na UI é falso; paleta inutilizável pelo teclado; no Windows aparece "⌘K".
**Correção sugerida** No pai (`App.tsx`) ouvir Ctrl/Meta+K e alternar `isOpen`; na paleta manter índice ativo com ArrowUp/Down e Enter chamando o item; mostrar "Ctrl K" conforme plataforma; remover a dica "N" ou implementá-la.
**Esforço** P

### [MÉDIO] Retomar sessão pausada enviando mensagem deixa a UI em "PAUSADA" para sempre (daemon fica "running")
**Evidência** Passos: sessão raiz autônoma -> "Pausar" (UI: PAUSADA, todos os botões do painel ficam desabilitados) -> digitar "retomar aqui" no compositor + Enter. Rede: `POST /sessions/ses_54ef.../send -> 200`. Depois de mais de 1 min a UI continua "PAUSADA"; `GET /sessions/ses_54ef...` devolve `state: running, live: true`. `GET .../events` continua com 3 eventos (nenhum de retomada). Código: `packages/daemon/src/session-manager.ts` `#launch` (~1520) faz `store.sessions.update(session.id, { state: 'running' })` sem evento estrutural; o painel só recarrega em `STRUCTURAL` (`packages/web/src/useHubState.ts:14-25`). A mensagem do usuário também não aparece na timeline.
**Impacto** Estado exibido errado (pausada enquanto roda); com estado "paused" `SidePanel.tsx:89` (`active = running || waiting_approval`) mantém Interromper/Pausar/Transferir/Encerrar desabilitados, então uma sessão que o painel acha pausada, mas está viva, não pode ser encerrada pela UI.
**Correção sugerida** Emitir `session.started`/`session.resumed` (e registrar a mensagem do usuário como evento) em `#launch`; e no `SidePanel` tratar `paused` como ativo para Encerrar e oferecer "Retomar".
**Esforço** M

### [MÉDIO] Sessão pausada não tem "Retomar" nem "Encerrar" no painel
**Evidência** Após "Pausar": `Interromper[dis] Pausar[dis] Transferir[dis] Encerrar[dis]` (`SidePanel.tsx:238-290` todos com `disabled={!active ...}`, `active` linha 89 exclui `paused`), mas `hub.ts:108` (`isLiveState`) conta `paused` como viva (ocupa vaga de concorrência). O compositor fica habilitado (única forma de retomar, sem aviso).
**Impacto** Sessão pausada ocupa slot de concorrência e não pode ser cancelada pela UI.
**Correção sugerida** Habilitar Encerrar para `paused`; botão "Retomar" explícito.
**Esforço** P

### [MÉDIO] Registrar projeto com caminho inexistente é aceito
**Evidência** UI: "+ Nova Pasta" -> caminho `C:\nao\existe\aqui` -> "Criar & Vincular Projeto" -> toast "projeto registrado". `GET /projects` lista `aqui C:\nao\existe\aqui`; `ls C:/nao` não existe. `packages/daemon/src/server.ts:352-355` chama `registerProject` direto (`POST /projects` -> 201). O painel ainda troca automaticamente o filtro de projeto para o novo (lista da esquerda fica "Ativos 0 / Todos 0" enquanto a timeline mostra sessão de outro projeto).
**Impacto** Projetos fantasma; erro só aparece depois, ao iniciar sessão.
**Correção sugerida** Validar existência/diretório no daemon (`ILLEGAL_STATE`/400) e mostrar o erro no modal; não trocar o filtro para um projeto vazio.
**Esforço** P

### [MÉDIO] Nenhum modal tem armadilha de foco nem fecha com Esc (só a paleta fecha com Esc); foco não vai para dentro do modal
**Evidência** `grep Tab|focus` em `SessionModal.tsx`/`ProjectModal.tsx`: nada. Paleta aberta + 6x Tab: `document.activeElement` = botão "Grafo DAG" da topbar (fora do `role=dialog`). Modal "Delegar a partir de filho" aberto: `activeElement` = BODY (sem foco inicial) e `Escape` não fecha (`[role=dialog]` continua). Modal "Registrar Novo Projeto": Esc também não fecha. Fechar só por clique no backdrop (descarta o formulário digitado num clique errado). `role=dialog aria-modal=true` sem `aria-label`.
**Impacto** Acessibilidade e usabilidade por teclado; perda de dados ao clicar fora.
**Correção sugerida** Componente único de modal com foco inicial, trap de Tab, Esc, `aria-labelledby`, e `inert` no resto; confirmação ao fechar formulário sujo.
**Esforço** M

### [MÉDIO] Variáveis CSS `--agent-1..8` nunca são definidas: cor por agente inexistente (barras de telemetria invisíveis, avatares sem cor)
**Evidência** `packages/web/src/hub.ts:10-27` `agentColor()` devolve `var(--agent-N)`; `grep "\-\-agent-1" src` só acha hub.ts. No navegador: `getComputedStyle(document.documentElement).getPropertyValue('--agent-1')` = "" e nenhuma regra `--agent-1:` nos stylesheets. Telemetria: `.pct-bar` (102x6, 153x6) com `background: rgba(0,0,0,0)` embora `style="width: 28.6%; background: var(--agent-3);"`. Avatares "FI/NE/RA" também sem cor (usam `agentColor`, `App.tsx:365,371`, `AgentSwarmView.tsx`, `SettingsView.tsx:567`).
**Impacto** Barra de participação da telemetria invisível; identidade visual por agente perdida em vários lugares.
**Correção sugerida** Definir `--agent-1..8` em `:root` no `styles.css`.
**Esforço** P

### [MÉDIO] Fan-out de requisições: cada evento estrutural refaz 4 GETs duas vezes e 1 grafo por fluxo existente
**Evidência** 253 requisições em ~15 min com ~12 sessões (`read_network_requests`). Padrão repetido: `/sessions,/agents,/approvals,/projects` em duplicidade consecutiva (`useHubState.ts:112-124` chama `refresh()` no timer e de novo no efeito de `revision`), seguido de `GET /graph/<rootId>` para TODOS os fluxos (incl. encerrados) + `/budget/<id>`. Cresce linearmente com o histórico.
**Impacto** Carga no daemon e latência crescem com o número de fluxos; `/agents` (com probe) é rebuscado a cada evento.
**Correção sugerida** Deduplicar o refresh (uma só chamada), buscar `/agents` só no início, e grafo/budget só do fluxo selecionado ou com endpoint agregado.
**Esforço** M

### [BAIXO] Configuração salva pelo painel sem `policy:` gera aviso falso de "configuração inválida" em toda sessão
**Evidência** Salvei "Prompts por agente" na UI -> arquivo `prompts:\n  filho: seja conciso`. Toda sessão nova do projeto recebe `log warn`: "configuração do projeto (.agents-hub/config.yaml) inválida ... Unrecognized key(s) in object: 'prompts' — caindo na política global". `packages/daemon/src/project-config.ts:126-137` faz `candidato = parsed['policy'] ?? parsed` e valida com `PartialPolicyDocumentSchema.strict()`. Com `policy: {maxDepth: 2}` + `prompts:` no mesmo arquivo: sem aviso (testado).
**Impacto** Ruído (falso positivo) e, se alguém escrever política no topo junto com prompts/memória, perde a política de projeto silenciosamente para a global.
**Correção sugerida** Extrair `prompts/memory/env` antes de validar a política (ou só validar `parsed.policy` quando existir e ignorar chaves conhecidas de outros escritores).
**Esforço** P

### [BAIXO] "Interromper" em agente one-shot marca a sessão como FALHOU (sem continuação)
**Evidência** Sessão raiz "interromper" -> botão Interromper -> toast "Turno interrompido." -> estado FALHOU, compositor "Sessão falhou — abra uma nova". Eventos: `error canceled exitCode 1`, `tarefa encerrada sem sucesso`.
**Impacto** "Interromper" (interromper o turno) na prática destrói a sessão; rótulo promete mais que entrega. (Pausar em sessão saudável funciona e vira PAUSADA.)
**Correção sugerida** Tratar cancelamento pelo usuário como `idle`/`interrupted` e não falha; ou renomear para "Parar".
**Esforço** M

### [BAIXO] "Encerrar" é destrutivo, de um clique, sem confirmação
**Evidência** `Encerrar` ao lado de `Pausar` (mesma linha): um clique -> "Sessão encerrada." (`confirm` não foi chamado; sem `alertdialog`).
**Correção sugerida** Confirmação inline/undo.
**Esforço** P

### [BAIXO] Toasts de erro nunca somem e se empilham cobrindo o painel direito e o botão Enviar
**Evidência** `actions.ts:34`: só `kind==='ok'` auto-dispensa (4 s); erros ficam até clicar em ✕ (`Toasts.tsx`), sem limite. Screenshot 1440: dois toasts de erro cobrem "Memória & Contexto" e parte do botão "Enviar". O erro aparece também no topo do modal (duplicado), sem estilo de erro (texto branco), e empurra o formulário para baixo. Títulos mostram códigos crus (`CONCURRENCY_EXCEEDED`, `ILLEGAL_STATE`).
**Correção sugerida** Auto-dismiss de erro em ~10 s, máximo de 3 visíveis, estilo de erro no modal.
**Esforço** P

### [BAIXO] Modal "Nova Sessão": rodapé sem sticky e selects truncados
**Evidência** Com erro exibido o modal (`[67, 832]`, altura 765 de 900) tem `scrollHeight 804 > 763`; botões Cancelar/Iniciar em y 814-849, passando a borda inferior do modal (precisa rolar dentro do modal). Selects de 199 px cortam o rótulo ("Semi-Autônomo (Pausa..." / "Git Worktree (Segur..."). Em 375 px o modal cabe, mas o rodapé também exige rolagem.
**Correção sugerida** Rodapé `position: sticky; bottom: 0`; selects `width: 100%`/`text-overflow`.
**Esforço** P

### [BAIXO] Mobile: gaveta de fluxos fica sob o compositor; compositor sobrepõe dica; cabeçalho da timeline cortado; sem backdrop
**Evidência** 375 px: `.col-left` `z-index: 8`, compositor `z-index: 10`; com a gaveta aberta `elementFromPoint(150,760)` = `TEXTAREA.composer-input` (compositor cobre o fim da gaveta e rouba cliques). O rótulo "/ para focar" fica em cima do placeholder do textarea (texto ilegível/cortado). Cabeçalho da timeline: `.head-actions`/"Detalhado" com right=399 > 375 (cortado), e o título da sessão some. Não há backdrop na gaveta (fecha só ao escolher sessão ou no hambúrguer); as gavetas fora da tela continuam focáveis (`visibility: visible`, sem `inert`). Banner de aprovações ocupa 200 px de 812 (max-height com scroll interno): com 2 aprovações só a primeira é legível, texto do objetivo truncado ("aprovar no mobile com u..."), botões Liberar/Negar em coluna estreita.
**Correção sugerida** z-index do compositor menor que o da gaveta; esconder "/ para focar" no mobile; `flex-wrap` no head; backdrop + `inert`/`visibility:hidden` na gaveta fechada; banner colapsável.
**Esforço** M

### [BAIXO] Rótulos e consistência
**Evidência** Paleta mostra badges de estado em inglês cru (`WAITING_APPROVAL`, `RUNNING`, `COMPLETED`) enquanto o resto é pt-BR ("AGUARDANDO VOCÊ", "RODANDO"); agentes instalados (probe `installed: true`) aparecem como "Desconectado"/"desconhecido"; telemetria "1 sessões concluídas" (plural); 7 botões de ícone sem nome acessível (`.drawer-toggle` sem `aria-label`, topbar). Sem tema claro (meta `color-scheme: dark light` mas só CSS escuro, controles nativos podem renderizar claros em SO claro).
**Esforço** P

---

## Verificado OK
- Carga inicial sem erros de console; SSE conecta; novas sessões via HTTP aparecem na hora (~ms) quando a aba está em foco.
- Fluxo de aprovação: Liberar (sessão sai de "AGUARDANDO VOCÊ", executa e conclui) e Negar funcionam; banner some.
- Abas Timeline, Grafo DAG, Swarm, Telemetria e Configurações renderizam sem overflow em 1440 e 1200; DAG/telemetria mostram fluxos e custos coerentes (28,6% / 42,9% conferem com 2/7 e 3/7).
- Configurações: salvar "Prompts por agente" grava `.agents-hub/config.yaml` e mostra toast; seções Memória, Modelos locais, Isolamento e Agentes detectados abrem.
- Delegar sub-tarefa, Transferir (handoff) e Pausar em sessão saudável funcionam; erro de worktree em pasta sem git e de limite de concorrência são mostrados com mensagem clara.
- Modais Nova Sessão/Projeto/Delegar fecham por Cancelar e backdrop; a paleta fecha com Esc e abre por clique; seleção por clique navega à sessão.
- Nenhum overflow horizontal de documento (`scrollWidth == viewport`) em nenhum viewport testado (o overflow é interno da topbar, escondido por `overflow-x: hidden`).
- Ambiente: daemon isolado encerrado por `/shutdown`; viewport restaurado para desktop.

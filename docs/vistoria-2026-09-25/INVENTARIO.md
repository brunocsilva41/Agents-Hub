# Inventário dos achados — vistoria 2026-09-25

Fonte: os 14 relatórios `01-*.md` a `14-*.md` desta pasta (STATUS.md fora). Um achado = um título com
severidade explícita (`### [ALTO]`, `### [MEDIO]`, `### [CRITICO]`, com ou sem acento, com ou sem número).
Mapeamento de itens contra `docs/12-goal-mvp-completo.md`. `—` = nenhum item do GOAL cobre.

## Contagem

| Sev | Encontrado | Esperado (doc 12) | Diferença |
|---|---:|---:|---:|
| CRÍTICO | **3** | 2 | +1 |
| ALTO | **52** | 52 | 0 |
| MÉDIO | **104** | 71 | +33 |
| BAIXO | **66** | 66 | 0 |
| Total | **225** | 191 | +34 |

Por relatório (CRIT/ALTO/MED/BAIXO): 01 0/4/6/1 · 02 0/4/6/5 · 03 0/4/16/8 · 04 0/2/7/7 · 05 0/5/3/3 ·
06 1/6/4/4 · 07 0/2/12/11 · 08 0/5/9/3 · 09 0/3/8/8 · 10 2/4/7/4 · 11 0/3/4/2 · 12 0/0/5/4 · 13 0/7/9/3 · 14 0/3/8/3.

### Por que diverge

Os totais do doc 12 parecem ter saído de uma busca pelas grafias **acentuadas** (`[CRÍTICO]`, `[MÉDIO]`).
Os relatórios que escrevem sem acento ficaram de fora:

- **CRÍTICO +1**: o 06 usa `### [CRITICO]` (reaper apaga `node_modules`). Só os 2 `[CRÍTICO]` do 10 entraram
  nos 2 esperados. Na prática o próprio GOAL marca 0.1 (06) e 0.2 (10) como críticos, mas **não** marca 0.3,
  que é o segundo `[CRÍTICO]` do 10 (injeção de comando em `.cmd`). Os críticos reais são 3.
- **MÉDIO +33**: os relatórios 06 (4), 08 (9), 09 (8), 11 (4) e 14 (8) usam `[MEDIO]`, e isso soma 33.
  Contando só `[MÉDIO]` com acento: 6+6+16+7+3+12+7+5+9 = 71, que é o valor esperado.

Divergências entre o resumo que o próprio relatório declara e o que ele lista:

- **03** declara `MÉDIO 15`, mas lista **16**. O 16º ("Cobertura do painel vs. sistema", R03-20) é um título
  que só aponta para a seção F. ALTO 4 e BAIXO 8 conferem.
- **04** declara `ALTO 2, MÉDIO 6, BAIXO 6`, mas lista **2/7/7**.
- **06** (1/6/4/4) e **09** (3/8/8) conferem com o que declaram. Os demais não trazem resumo de contagem.

Como a contagem foi feita:

- O 01 tem um único `[BAIXO] Outras divergências pontuais`, com 7 subitens numerados. Contei como 1 achado
  (R01-11). Com os subitens separados, BAIXO passaria a 72.
- Listas e tabelas **sem severidade** não entraram na contagem, porque são inventário ou sugestão e não
  achados classificados:
  - 01, Partes B–E (funcionalidades ausentes, contradições, inventário do roadmap);
  - 03, seção F (16 superfícies sem painel, resumidas no R03-20);
  - 05, "Lacunas de UX" (7 itens, cobertos por 1.10);
  - 10, tabela "cidadão pleno";
  - 14, lista "MVP 100% completo".
- Vários defeitos aparecem em mais de um relatório e foram contados em cada um, como pedido. Exemplos:
  - classificador por prefixo: 01, 02, 05, 09 e 13;
  - timeout do hook: 01, 05, 07 e 08;
  - `hooks install` apaga o `settings.json`: 07 e 08.

---

## R01 — 01-docs-vs-codigo.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R01-01 | ALTO | Gate bloqueia quase todo comando fora da allow list; README diz o contrário | 1.7 | [x] |
| R01-02 | ALTO | Hook instalado desiste em 10 s e daemon espera 60 s: gate pode falhar aberto | 1.3 | [x] |
| R01-03 | ALTO | Fluxo bloqueante do gate sem teste e com 3 defeitos (timeout mata, msg errada, approve) | 1.5 | [x] |
| R01-04 | ALTO | Política por prefixo: cat/ls/node/python liberam tudo; .ssh/.env não param | 1.1 | [x] |
| R01-05 | MED | Autostart do daemon sem `--experimental-sqlite` (Node 22.5–22.12) | 5.1 | [x] |
| R01-06 | MED | Doc 07 "fonte de verdade" defasado em pontos centrais | 8.1 | [x] |
| R01-07 | MED | Contagens de tools MCP e de testes divergem entre README, docs e código | 8.1 | [x] |
| R01-08 | MED | docs/01 descreve arquitetura não implementada (Orchestrator, TUI, A2A...) | 8.1 | [x] |
| R01-09 | MED | docs/04 e docs/03 com afirmações defasadas (gate, caminhos MCP) | 8.1 | [x] |
| R01-10 | MED | Roadmap marca `[x]` itens que violam o critério de pronto do CONTRIBUTING | 8.1 | [x] |
| R01-11 | BAIXO | Outras divergências pontuais (7 subitens: README, fallback, pré-requisitos, doc 08) | 8.1 | [x] |

## R02 — 02-adrs-seguranca-docs.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R02-01 | ALTO | Política de comandos por prefixo: `git status && git push` vira exec/allow | 1.1 | [x] |
| R02-02 | ALTO | Proteção de .ssh/.env/credenciais só na escrita; leitura e `cat` passam | 1.2 | [x] |
| R02-03 | ALTO | Gate falha aberto por desenho e SECURITY.md não diz | 1.4 | [x] |
| R02-04 | ALTO | Config de projeto "só aperta" é falsa: orçamento, timeouts, retries, validation.command | 0.7 | [x] |
| R02-05 | MED | `/discovery` não mascara `args` nem query strings fora da lista | 1.8 | [x] |
| R02-06 | MED | SECURITY.md omite vetores reais (BASE_URL, prompts/memory, env de projeto) | 1.9 | [x] |
| R02-07 | MED | Retenção documentada ("para sempre", bruto preservado) não bate com o código | 8.1 | [x] |
| R02-08 | MED | ADRs 01/03/06 divergem do código (fallback, 9 agentes, TUI, nomes) | 8.1 | [x] |
| R02-09 | MED | CONTRIBUTING desatualizado (273 testes) e CI sem `permissions:` | 8.1, 7.2 | [x] CONTRIBUTING (75afd04) + CI permissions; resíduos (run-tests.mjs sem contagem fixa, cancel-in-progress só fora da main) na sessão 2 (merge s2-waits-resto) |
| R02-10 | MED | docs/09: MCP e CLI leem `process.env` cru, `NaN` volta | 5.4 | [x] (resíduo AGENTS_HUB_MCP_HEARTBEAT_MS fechado no merge ddf6f54: readHubEnv + hub-env.test/main-heartbeat.test) |
| R02-11 | BAIXO | JSON malformado devolve 500 INTERNAL com mensagem do parser | 1.8 | [x] |
| R02-12 | BAIXO | POST sem corpo e sem Content-Type recusado com 415 | — | [x] POST vazio aceito |
| R02-13 | BAIXO | docs/10 e precos-modelos dizem que só o Claude reporta USD (OpenCode também) | 8.1 | [x] |
| R02-14 | BAIXO | Exemplo YAML promete paralelismo que não tem | — | [x] exemplo diz "sequencial" (75afd04) |
| R02-15 | BAIXO | Exports de sessão `.txt` soltos na raiz, fora do .gitignore | 8.3 | [x] /*.txt no .gitignore (1a3ce75) |

## R03 — 03-web-estatico.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R03-01 | ALTO | Timeline mostra os 500 PRIMEIROS eventos e perde histórico se SSE chega antes | 6.3 | [x] |
| R03-02 | ALTO | Ctrl/⌘+K nunca abre a paleta; `<kbd>N</kbd>` sem handler; sem setas/Enter | 6.2 | [x] |
| R03-03 | ALTO | Configurações: falha ao carregar projeto mantém config do anterior e permite gravá-la | 6.6 | [x] |
| R03-04 | ALTO | Topbar sem regra responsiva: abaixo de ~1100 px ações inalcançáveis | 6.1 | [x] |
| R03-05 | MED | Pausar torna a sessão impossível de encerrar/interromper/transferir | 6.4 | [x] |
| R03-06 | MED | "ver a sessão" (Aprovações) não troca para a aba Timeline | 6.9 | [x] e2e clica em "ver a sessão" e confere a aba Timeline (2f56d00) |
| R03-07 | MED | Toasts de sucesso enganosos (interromper sem turno, delegação retida) | 6.9 | [x] |
| R03-08 | MED | Mensagem enviada pelo usuário nunca aparece na timeline | 6.3 | [x] |
| R03-09 | MED | Auto-scroll da timeline para depois de 400 eventos | 6.3 | [x] |
| R03-10 | MED | Falha ao buscar eventos nunca é repetida (mensagem promete retry) | 6.3 | [x] |
| R03-11 | MED | "Nova Sessão" pré-seleciona o 1º projeto; perde dados; agente não instalado | 6.9 | [x] formulário preservado ao registrar pasta; agente não instalado e teto validados (48dd69e + e2e reaberturas.spec.ts) |
| R03-12 | MED | ProjectModal: falha parcial não atualiza lista e "tentar de novo" repete trabalho | — | [x] ProjectModal idempotente (f99810f) |
| R03-13 | MED | Modais sem Esc, sem foco preso, sem nome; clique no fundo descarta formulário | 6.7 | [x] |
| R03-14 | MED | Gavetas podem abrir juntas e se sobrepor, focáveis fechadas, cobrem aprovações | 6.7 | [x] |
| R03-15 | MED | Overflow/quebra de layout em <900 px e <600 px (só 2 breakpoints) | 6.1 | [x] swarm/métricas/disc-dl cabem em 375px, medidos no e2e com cartões reais (4fa4fe9) |
| R03-16 | MED | Estados vazios/erro ausentes ou enganosos | — | [x] estados em todas as telas + e2e (f99810f) |
| R03-17 | MED | Aba "Grafo DAG" sem arestas, sem teclado e ignora filtro de projeto | 6.9 | [x] |
| R03-18 | MED | Vite dev: `/discovery` fora do proxy; aba "Agentes detectados" quebra | 6.11 | [x] |
| R03-19 | MED | Configurações: edições somem sem aviso; "Modelos locais" com controles fantasma | 6.5 | [x] |
| R03-20 | MED | Cobertura do painel vs. sistema: faltam superfícies (seção F, 16 itens) | 6.12 | [x] |
| R03-21 | BAIXO | Abas com ARIA inválido e controles sem nome acessível | — | [x] cabeçalho de memória é botão com aria-expanded; chips viram radiogroup (ee0a6fa) |
| R03-22 | BAIXO | Contraste de `--text-faint` e ausência de `prefers-reduced-motion` | 6.8 | [x] |
| R03-23 | BAIXO | Fontes via Google Fonts (`@import`) em painel local | 6.8 | [x] |
| R03-24 | BAIXO | Fluxo selecionado na lista não pode ser recolhido | — | [x] fluxo recolhível |
| R03-25 | BAIXO | Botões com `margin-left:4px` global e `transform` no hover | — | [x] sem transform no hover |
| R03-26 | BAIXO | Toasts: fila sem teto e sem "dispensar todos" | 6.9 | [x] |
| R03-27 | BAIXO | Telemetria rasa e inconsistente com o resto | — | [x] telemetria consistente + custo por agente |
| R03-28 | BAIXO | Código morto/duplicado e atalho "/" global dispara com modal aberto | — | [x] atalho / respeita modal; código morto removido |

## R04 — 04-web-ao-vivo.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R04-01 | ALTO | Mobile 375 px: topbar estoura; abas, busca, "Nova Sessão" e "Painel" inalcançáveis | 6.1 | [x] |
| R04-02 | ALTO | Tablet 768–~1116 px: topbar estoura; busca sobrepõe o pill "Ao Vivo" | 6.1 | [x] |
| R04-03 | MED | Ctrl/⌘+K não abre a paleta; "N" e setas/Enter não funcionam | 6.2 | [x] |
| R04-04 | MED | Retomar pausada por mensagem deixa a UI "PAUSADA" para sempre | 6.4 | [x] |
| R04-05 | MED | Sessão pausada não tem "Retomar" nem "Encerrar" no painel | 6.4 | [x] |
| R04-06 | MED | Registrar projeto com caminho inexistente é aceito | 6.6 | [x] |
| R04-07 | MED | Nenhum modal tem armadilha de foco nem fecha com Esc | 6.7 | [x] |
| R04-08 | MED | Variáveis `--agent-1..8` nunca definidas (telemetria invisível, avatares sem cor) | 6.8 | [x] |
| R04-09 | MED | Fan-out: cada evento refaz 4 GETs duas vezes + `/graph` por fluxo | 6.10 | [x] |
| R04-10 | BAIXO | Config salva sem `policy:` gera aviso falso de "configuração inválida" | 6.6 | [x] |
| R04-11 | BAIXO | "Interromper" em agente one-shot marca a sessão como FALHOU | 6.4 | [x] |
| R04-12 | BAIXO | "Encerrar" destrutivo, de um clique, sem confirmação | 6.4 | [x] e2e da confirmação do Encerrar (2f56d00) |
| R04-13 | BAIXO | Toasts de erro nunca somem e se empilham cobrindo painel e "Enviar" | 6.9 | [x] |
| R04-14 | BAIXO | Modal "Nova Sessão": rodapé sem sticky e selects truncados | 6.7 | [x] rótulos curtos + ajuda da opção; selectsTruncados() no e2e (3cdff02) |
| R04-15 | BAIXO | Mobile: gaveta sob o compositor, dica sobreposta, cabeçalho cortado, sem backdrop | 6.7 | [x] |
| R04-16 | BAIXO | Rótulos em inglês cru, "Desconectado" errado, plural, sem tema claro | 6.2, 6.8 | [x] |

## R05 — 05-permissoes-seguranca.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R05-01 | ALTO | `validation.command` do config.yaml do repo executa com shell, fora do gate | 0.7 | [x] |
| R05-02 | ALTO | Env do config.yaml do repo redireciona tráfego/credenciais (`*_BASE_URL`) | 1.9 | [x] |
| R05-03 | ALTO | Qualquer processo local, inclusive o agente, aprova as próprias aprovações | 1.6 | [x] gate trata loopback ao daemon e CLI de operador como leitura do token; teste negativo gate-daemon-loopback.test.ts (merge de mvp-seguranca) |
| R05-04 | ALTO | Timeout do hook menor que a espera do gate: aprovação vira falha aberta | 1.3 | [x] |
| R05-05 | ALTO | Política por prefixo: comando composto passa como allow list e vira exec livre | 1.1 | [x] mcp__* com caminho de segredo no input vira leitura no gate; pretool-gate-mcp.test.ts |
| R05-06 | MED | CSRF residual: `Origin: null` aceito e POST sem corpo dispensa content-type | 1.8 | [x] |
| R05-07 | MED | `GET /discovery` e importação vazam segredos em `args` de MCP | 1.8 | [x] importação pula servidor MCP com segredo em args/URL (skipped com motivo); absorption.test.ts |
| R05-08 | MED | Rota com `%` malformado deixa a conexão pendurada | 1.8 | [x] |
| R05-09 | BAIXO | JSON malformado devolve 500 INTERNAL, e corpo > 5 MB também | 1.8 | [x] |
| R05-10 | BAIXO | Projetos/pastas aceitam qualquer caminho (sem existência nem raízes proibidas) | 1.8 | [x] raiz de unidade/home/pastas de sistema/UNC admin recusadas, inclusive via junction/8.3; project-path-raizes.test.ts |
| R05-11 | BAIXO | Estático serve `index.html::$DATA` e `/health` expõe `home` | 1.8 | [x] |

## R06 — 06-daemon-nucleo.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R06-01 | CRIT | Reaper apaga o `node_modules` REAL do projeto (worktree remove atravessa junction) | 0.1 | [x] |
| R06-02 | ALTO | Cancelar sessão viva termina `failed` (ou `killed`, aleatório); task nunca `canceled` | 2.1 | [x] |
| R06-03 | ALTO | Cancel durante validação/backoff: terminal ressuscita ou task presa em `working` | 2.1 | [x] |
| R06-04 | ALTO | `interrupt` e `pause` no Windows encerram a sessão como `failed` | 2.2 | [x] |
| R06-05 | ALTO | Falha ao subir agente deixa sessão `running`, worktree vazado e reserva presa | 2.3 | [x] |
| R06-06 | ALTO | Timeout do gate mata a sessão inteira e a explicação correta não chega | 1.5 | [x] |
| R06-07 | ALTO | `send` em sessão `waiting_approval` relança o agente por cima da aprovação | 2.4 | [x] |
| R06-08 | MED | Rajada de saída bloqueia o event loop; sem teto de eventos/bytes por sessão | 2.5 | [x] |
| R06-09 | MED | Reaper: worktrees sujos/meio-apagados nunca recolhidos; sweep sem trava | 2.6 | [x] |
| R06-10 | MED | Reconciliação no restart fecha sessões sem evento nem tentativa fechada | 2.8 | [x] |
| R06-11 | MED | `handoff` conta a mesma sessão duas vezes no teto de concorrência | 2.7 | [x] |
| R06-12 | BAIXO | Cancel em cascata ignora filhos `paused`/`idle` | — | [x] cascata alcança paused/idle (468ce58) |
| R06-13 | BAIXO | Kill de árvore em POSIX mata só o filho direto | — | [x] grupo de processos POSIX |
| R06-14 | BAIXO | Artefato de diff só é capturado no caminho de sucesso | — | [x] diff em falha/cancel |
| R06-15 | BAIXO | Escrita fora do worktree não é detectada (docs/04 diz `escalate`) | 8.1 | [x] |

## R07 — 07-cli.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R07-01 | ALTO | `hooks install claude --write` apaga settings.json que não parseia; `.bak` sobrescrito | 0.4 | [x] |
| R07-02 | ALTO | Timeout do hook (10 s) menor que a espera do daemon (60 s): gate falha aberto | 1.3 | [x] |
| R07-03 | MED | `hub start` (e project/import/workflow) em subpasta de projeto → PROJECT_FOLDER_CONFLICT | 5.3 | [x] |
| R07-04 | MED | Referência de projeto desconhecida vira "registrar diretório com esse nome" | 5.5 | [x] |
| R07-05 | MED | Sem normalização de caminho: 8.3/caixa viram 2 projetos ou erro enganoso | 5.5 | [x] |
| R07-06 | MED | `project env/prompt` num config.yaml com política plana descarta a política | 5.5 | [x] |
| R07-07 | MED | Erros de config viram stack trace bruto em qualquer comando (até help/hook) | 5.4 | [x] |
| R07-08 | MED | `AGENTS_HUB_PORT` lida só por `hub daemon`; demais comandos falam com 4747 | 5.4 | [x] |
| R07-09 | MED | `watch --root` de fluxo terminado pendura; `send` após pause não mostra resposta | 5.2 | [x] |
| R07-10 | MED | `hub start` sai com exit 0 quando a sessão falha; fallback roda sem aviso | 5.3 | [x] |
| R07-11 | MED | Flags inválidas aceitas em silêncio (`--mode`, `--isolation`, `--set`, `--agent`) | 5.3 | [x] |
| R07-12 | MED | `mcp install --write` sobrescreve o `.bak` a cada execução | 0.5 | [x] |
| R07-13 | MED | `hooks install codex --write` congela toda a config padrão no config.json | 5.5 | [x] |
| R07-14 | MED | Ids sem `encodeURIComponent` no client; budget/graph de id errado dão zeros/crash | 0.6 | [x] |
| R07-15 | BAIXO | Negação/timeout no gate: agente recebe "a política proíbe esta ação" | 1.5 | [x] |
| R07-16 | BAIXO | `hub interrupt`/`cancel`/`send` sempre dizem sucesso; no Windows interrupt mata | 2.2 | [x] |
| R07-17 | BAIXO | Eventos `error` aparecem como `✗` vazio | — | [x] teste do fallback reason/exitCode (0fcb39a, merge cli-pendencias) |
| R07-18 | BAIXO | Horários exibidos em UTC sem rótulo | — | [x] hora local com fuso (f33a35f) |
| R07-19 | BAIXO | Cada invocação carrega daemon/SQLite: ~0,6 s e ExperimentalWarning | 5.6 | [x] |
| R07-20 | BAIXO | Help x implementação (sem `--help` por comando, `--version`, `--json`, `--`) | 5.6 | [x] |
| R07-21 | BAIXO | Mensagens e códigos de erro inconsistentes entre comandos | — | [x] erro-cli.ts único (f33a35f) |
| R07-22 | BAIXO | `hub project env` mostra e ecoa valores com cara de segredo | — | [x] env mascarado (f33a35f) |
| R07-23 | BAIXO | `hub mcp` usa `includes('agents-hub')` como critério de "registrado" | — | [x] detecção estruturada (f33a35f) |
| R07-24 | BAIXO | Nome da worktree perde acentos | — | [x] transliteração (f33a35f) |
| R07-25 | BAIXO | `hub hooks` lê só o settings.json real e mostra "não instalado" com JSON inválido | 0.4 | [x] teste asserta hook instalado com JSONC/lixo (3d59db6, merge cli-pendencias) |

## R08 — 08-mcp-hooks.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R08-01 | ALTO | Path traversal no client: `hub_agent_cancel` com `../shutdown#` derruba o daemon | 0.6 | [x] |
| R08-02 | ALTO | Timeout do hook (10 s/20 s) < espera do gate (60 s): ação roda sem aprovação | 1.3 | [x] |
| R08-03 | ALTO | `mcp install opencode --write` gera config que o OpenCode rejeita por inteiro | 0.5 | [x] |
| R08-04 | ALTO | `mcp install codex --write` corrompe config.toml (chave duplicada) | 0.5 | [x] |
| R08-05 | ALTO | `hooks install claude --write` apaga config quando settings.json não é JSON estrito | 0.4 | [x] |
| R08-06 | MED | Sessão/tarefa fantasma quando a delegação falha ao iniciar | 2.3 | [x] |
| R08-07 | MED | `CallerIdentity` cacheia para sempre uma adoção que falhou | 2.8 | [x] |
| R08-08 | MED | `hub_agent_wait` ignora cancelamento/timeout do cliente e consulta para sempre | 2.8 | [x] |
| R08-09 | MED | Explicação de "negado por falta de resposta" descartada; `escalate` inválido no hook | 1.5 | [x] |
| R08-10 | MED | Gate aplica política do Hub ao Claude "normal" do usuário por casamento de `cwd` | — | [x] gate só p/ sessão viva do Hub (4fff125) |
| R08-11 | MED | Sem limite de tamanho em `hub_agent_call`; failover em cascata sem aviso | — | [x] fallback visível + erro do agente na tentativa (22beb13/226860e) |
| R08-12 | MED | `scripts/mcp-smoke.py` sempre aponta para 4747 e valida só 4 das 16 tools | — | [x] smoke MCP roda no job Linux do CI (merge 117e214) |
| R08-13 | MED | Raízes adotadas ficam `running` para sempre se o MCP é morto sem fechar stdin | 2.8 | [x] |
| R08-14 | MED | Sem escopo por fluxo: agente lê/cancela sessões de outros fluxos e projetos | — | [x] escopo por fluxo OUT_OF_FLOW (22beb13) |
| R08-15 | BAIXO | `hub_workflow_run`: erro sem motivo e leitura de arquivo arbitrário com eco | — | [x] yaml só no projeto, sem eco (22beb13) |
| R08-16 | BAIXO | Saídas e mensagens que custam tokens ou confundem o agente | — | [x] saídas enxutas (22beb13) |
| R08-17 | BAIXO | Detalhes de instalação/hook (`.bak`, `includes`, caminho absoluto, fail-open, 0,5 s) | 0.5 | [x] |

## R09 — 09-store-core.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R09-01 | ALTO | Policy: comando composto passa como `exec` se começar por item da allow list | 1.1 | [x] |
| R09-02 | ALTO | BudgetLedger conta a fatia do filho duas vezes e dispara `exhausted` falso | 3.2 | [x] |
| R09-03 | ALTO | Replay/`hub_context_fetch` usa os PRIMEIROS N eventos, não os últimos | 3.3 | [x] |
| R09-04 | MED | Padrões de "irreversível" e allow list com lacunas e falsos positivos | 1.1 | [x] |
| R09-05 | MED | "Deny list" não nega: vira `irreversible` e a decisão padrão é `approve` | 1.2 | [x] |
| R09-06 | MED | Não há backup/restauração do banco; copiar só o `.db` perde dados (WAL) | 5.6 | [x] |
| R09-07 | MED | Compactação de `raw_json` sem lotes, passada vazia O(N), espaço não devolvido | — | [x] auto_vacuum incremental + conversão medida na subida; 203→112 MB (merge de daemon-pendencias) |
| R09-08 | MED | Consultas agregadas por sessão/árvore escalam mal e bloqueiam o processo | — | [x] colunas geradas de custo, 70→6 ms (3e6d2ec) |
| R09-09 | MED | `mergePolicyLayer(clampToBase)` não trava budget/retries/timeouts/fallback | 0.7 | [x] |
| R09-10 | MED | Política de arquivos: leitura nunca protegida; lista de escrita sensível incompleta | 1.2 | [x] |
| R09-11 | MED | BudgetLedger aceita NaN/negativos e vaza reserva em `reserve` duplicado | 3.2 | [x] |
| R09-12 | BAIXO | Schemas de política aceitam valores sem sentido; risk parcial cai em fail-open | — | [x] schemas estritos (3e6d2ec) |
| R09-13 | BAIXO | Brief: validações frouxas (trim, tamanho, Infinity, `..` em artifacts) | — | [x] brief validado (3e6d2ec) |
| R09-14 | BAIXO | Pricing: variantes casam por prefixo com confiança `model`; itens não modelados | 3.4 | [x] |
| R09-15 | BAIXO | `combineCostEstimates`: rótulo de confiança incoerente | — | [x] confiança partial (559db1f) |
| R09-16 | BAIXO | `transaction()` não protege contra fn assíncrona nem usa SAVEPOINT | — | [x] SAVEPOINT, async recusado |
| R09-17 | BAIXO | Integridade e desempenho: lacunas de schema (FK, is_primary, path, índices) | — | [x] 1 pasta primária, trigger, índice (migração 10) |
| R09-18 | BAIXO | Workflow: teto de orçamento pessimista e sem limite de passos | — | [x] fatias proporcionais + máx 200 passos (4a20fe0) |
| R09-19 | BAIXO | Resiliência e CallGraph: retry de timeout, `pathKey` literal, ciclo de parent_id | — | [x] retry de timeout, hash, ciclo |

## R10 — 10-adapters-manifestos.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R10-01 | CRIT | Antigravity (`agy`) nunca recebe o prompt: agente 100% quebrado | 0.2 | [x] |
| R10-02 | CRIT | Injeção de comando via prompt nos agentes `.cmd` com prompt em argv | 0.3 | [x] |
| R10-03 | ALTO | Prompt por argv em `.cmd` truncado em quebra de linha, ~8 KB e sem Unicode | 0.3 | [x] |
| R10-04 | ALTO | `resolveBin` corrompe caminhos com acento (saída do `where` lida como UTF-8) | 4.1 | [x] |
| R10-05 | ALTO | Custo contado 2–3x (Claude, OpenClaude, Antigravity) | 3.1 | [x] |
| R10-06 | ALTO | OpenCode: modo do Hub não restringe nada; agente padrão com `allow *` | 4.2 | [x] |
| R10-07 | MED | `ctx.model` ignorado por 8 dos 9 agentes; providerID fixo no OpenCode | 4.3 | [x] OpenCode separa provider/model na primeira barra (1c12404) |
| R10-08 | MED | Kimi 2.0.0: mapper do formato antigo; supervised pode travar; existe `--plan` | 4.4 | [x] |
| R10-09 | MED | `resolveBin` cacheia `null` para sempre | 4.1 | [x] |
| R10-10 | MED | Mapper `generic-json` (mimo, cursor) não extrai texto, sessão nem custo | 4.4 | [x] |
| R10-11 | MED | Discovery do Antigravity lê o caminho errado | 4.4 | [x] |
| R10-12 | MED | `raw` do evento não é truncado: 5 MB persistidos por tool_result | 2.5 | [x] |
| R10-13 | MED | Cursor: manifesto 100% não verificado e binário ausente | 4.5 | [x] |
| R10-14 | BAIXO | OpenCode: `probe()` não devolve versão e afirma `authenticated:true` | — | [x] probe com --version, auth null (3fdc4a4) |
| R10-15 | BAIXO | Manifesto do Copilot cita duas versões que não batem com a instalada | 4.5 | [x] |
| R10-16 | BAIXO | Codex falha em diretório não-git (falta `--skip-git-repo-check`) | — | [x] contrato do manifesto exige --skip-git-repo-check no oneShot e resume (480c8c0) |
| R10-17 | BAIXO | Ruído `DEP0190` do Node; settings.json do Claude com conteúdo extra | 0.3 | [x] |

## R11 — 11-teste-real-clis.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R11-01 | ALTO | Antigravity totalmente quebrado com agy 1.2.6 (`-p` engole `--output-format`) | 0.2 | [x] |
| R11-02 | ALTO | Copilot: prompt multilinha truncado, saída não mapeada, custo/tokens zerados | 0.3, 3.1 | [x] |
| R11-03 | ALTO | Turno trivial de Claude estoura teto de US$ 0,10; dupla contagem de custo | 3.1 | [x] |
| R11-04 | MED | Sessão órfã `running` após recusa CODEX_GATE_NOT_GUARANTEED | 2.3 | [x] |
| R11-05 | MED | Codex supervised recusado; `send` em sessão concluída recusado (resume não validado) | — | [x] recusa supervised ensina hooks install codex; send em concluída → hub start --from (226860e/1600d9a) |
| R11-06 | MED | Supervised do Claude dispara aprovação por gravar plano em ~/.claude/plans | 1.7 | [x] |
| R11-07 | MED | `send` em sessão bloqueada e `approve` disparam turnos extras e aprovações duplicadas | 2.4, 2.10 | [x] |
| R11-08 | BAIXO | Saída do CLI/stream: eventos crus, linhas vazias e brief ecoado | 4.2 | [x] |
| R11-09 | BAIXO | Manifestos apontam versões verificadas diferentes das instaladas | 4.5 | [x] |

## R12 — 12-testes-ci.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R12-01 | MED | Sem LICENSE e sem campo `license` nos package.json | 7.3 | [x] |
| R12-02 | MED | Módulos relevantes sem teste (reaper, project-registry, hooks-install, client, web) | 7.1 | [x] |
| R12-03 | MED | Não há medição nem gate de cobertura | 7.2 | [x] npm run coverage + job CI (ab3a0af) |
| R12-04 | MED | Sem lint nem formatador | 7.2 | [x] ESLint (no-floating-promises) + Prettier + verify (merge 8f75671) |
| R12-05 | MED | Job Linux informativo (continue-on-error); portão só exige Windows | 7.2 | [ ] |
| R12-06 | BAIXO | `npm audit`: 1 vulnerabilidade moderada (qs), transitiva | 7.3 | [x] |
| R12-07 | BAIXO | Dependências com patch/minor pendentes; majors adiante | — | [x] patch/minor atualizados (67ff177, merge 8f75671) |
| R12-08 | BAIXO | Testes dependem de timers reais (risco latente de flakiness) | 7.3 | [x] sessão 2 (merges s2-waits-daemon + s2-waits-resto): esperas de sincronização viram esperarAte/esperar()/mock.timers em 33 arquivos; as que ficaram simulam comportamento ou provam ausência, com motivo na linha; teste de cancelamento do hub_agent_wait era vazio e foi refeito; mutação reproduzida pelo coordenador |
| R12-09 | BAIXO | `verify` não roda typecheck da web separado; `typecheck` duplica o build | — | [x] verify já checa tipos da web (79d8ec2) |

## R13 — 13-orquestracao-e2e.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R13-01 | ALTO | Workflow + fallback: passo reportado falho embora o substituto conclua | 2.9 | [x] |
| R13-02 | ALTO | `hub start`/`hub watch` terminam em silêncio quando a tarefa sofre fallback | 5.3 | [x] watch testado pelo caminho real (watchCommand); follow-task.ts removido como código morto (3f43d8d) |
| R13-03 | ALTO | Retry de CONCURRENCY_EXCEEDED do workflow nunca dispara via CLI (`instanceof`) | 2.9 | [x] |
| R13-04 | ALTO | Workflow em worktree não entrega o código do passo anterior, só o resumo | 2.9 | [x] |
| R13-05 | ALTO | Handoff nunca persiste o novo agente (`agent_id` fora do UPDATE) | 2.7 | [x] |
| R13-06 | ALTO | Vigilância/gate: comando encadeado passa como allow list | 1.1 | [x] |
| R13-07 | ALTO | `hub prune` nunca recolhe worktree com trabalho; branch `hub/<id>` sem o trabalho | 2.6 | [x] |
| R13-08 | MED | pause/interrupt no Windows destroem a sessão; pause não desce para os filhos | 2.2 | [x] |
| R13-09 | MED | cancel deixa sessão e task `failed` (nunca `canceled`) com erro de alta prioridade | 2.1 | [x] |
| R13-10 | MED | Config de projeto sem `policy:` gera aviso falso de "configuração inválida" | 5.5 | [x] |
| R13-11 | MED | Overrides de projeto (retries, fallback, watch, maxConcurrency) ignorados | 2.10 | [x] |
| R13-12 | MED | `--mode autonomous` da CLI limitado em silêncio ao padrão do manifesto | 2.10 | [x] |
| R13-13 | MED | `/api/tasks/:id/events` não segue o fallback, nunca fecha, ignora Last-Event-ID | 2.10 | [x] merge ddf6f54: id = cursor por sessão (`ses_a:12,ses_b:5`), replay a partir dele, malformado = 400, replay acima do teto pagina e fecha; sse-task-http.test (7) + sse.test; mutação reproduzida pelo coordenador |
| R13-14 | MED | Aprovar estouro de orçamento após turno concluído relança o agente | 2.10 | [x] |
| R13-15 | MED | Orçamento em `seconds` não aplicado durante a run; mensagem cita só USD | 2.10 | [x] |
| R13-16 | MED | Workflow bloqueado por aprovação não tem retomada | 2.9 | [x] |
| R13-17 | BAIXO | Aprovação da revisão por segundo agente não deixa registro | — | [x] review.approved registrado |
| R13-18 | BAIXO | `POST /projects`/folders aceitam caminho inexistente/arquivo; 8.3 duplica projeto | 5.5 | [x] |
| R13-19 | BAIXO | Códigos de erro imprecisos em aprovações; comentário desatualizado em budget.ts | — | [x] APPROVAL_NOT_FOUND 404 |

## R14 — 14-jornada-usuario-completude.md

| ID | Sev | Título | Item do GOAL | Estado |
|---|---|---|---|---|
| R14-01 | ALTO | Node 22.5–22.12 (piso de `engines`) não roda nem `hub help` | 5.1 | [x] |
| R14-02 | ALTO | Sem empacotamento/instalação fora do clone; caminhos presos ao repositório | 5.7 | [x] |
| R14-03 | ALTO | `hub watch <id-inexistente>` trava para sempre, sem erro | 5.2 | [x] |
| R14-04 | MED | `hub start` em subpasta de projeto registrado falha com PROJECT_FOLDER_CONFLICT | 5.3 | [x] |
| R14-05 | MED | Repositório git sem commits: erro cru do git | 5.3 | [x] |
| R14-06 | MED | Objetivo curto rejeitado (`min(8)`) e validação de agente vem depois | — | [x] agente validado antes; msg melhor (6f231e2); painel alinhado ao min(8) do daemon (OBJETIVO_MINIMO_BRIEF, sessão 2) |
| R14-07 | MED | `AGENTS_HUB_PORT` ignorada pelo cliente da CLI | 5.4 | [x] |
| R14-08 | MED | `ExperimentalWarning: SQLite` em todo comando, até `hub help` | 5.6 | [x] |
| R14-09 | MED | Sem onboarding (`hub init`); doctor, discover e painel não se conversam | 5.6 | [x] |
| R14-10 | MED | Sem `hub logs`, reinício/atualização nem autostart no login | 5.6 | [x] |
| R14-11 | MED | Default `semi` + `exec: allow` sem aviso de gate não instalado na 1ª execução | — | [x] aviso de gate ausente no hub start (f33a35f) |
| R14-12 | BAIXO | Aviso de "daemon" não orienta; README sem seção de requisitos | 8.4 | [x] README Requisitos + aviso do daemon (f46ce0e) |
| R14-13 | BAIXO | `hub doctor` marca opencode "versão desconhecida"; auth só via `--smoke` | 4.6 | [x] |
| R14-14 | BAIXO | Aprovação não é visível para quem não está olhando o terminal | — | [x] bipe/título na CLI + Notification no painel (1600d9a/7696f71) |

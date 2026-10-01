# 19 — Status da reescrita em C

> Estado de cada tarefa do [plano](17-plano-reescrita-c.md) e de cada pendência (DV/DA). Só o
> coordenador edita este arquivo; as tarefas entregam a evidência no relatório (plano, §0, tabela de
> donos). Uma marca só muda com evidência: commit, saída de teste ou medição citada (plano, §5;
> critério de pronto do `CONTRIBUTING.md`). Criado em 2026-09-30 só com a estrutura: nenhuma tarefa
> foi avaliada aqui.

## Legenda

| Marca | Significado (vocabulário do `CONTRIBUTING.md`) |
|---|---|
| `[x]` | passa nas linhas da definição de pronto (plano, §5.1) |
| `[~]` | existe e funciona, mas entrega menos do que a frase diz, ou tem DV/DA aberta no aceite; a coluna Evidência diz o quê |
| `🕳️` | código escrito, nunca exercitado fora do teste unitário |
| `[ ]` | não começou |

Colunas: **Commit** = hash do commit mesclado; **Evidência** = comando executado e saída, ou caminho do relatório.

## Tarefas

### F0 — Fundação (esqueleto, CI, plataforma, vendorização)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F0-01 | Esqueleto de build (CMake + Ninja) | `[ ]` | | |
| F0-02 | CI da reescrita | `[ ]` | | |
| F0-03 | Vendorização das bibliotecas do núcleo | `[ ]` | | |
| F0-04 | Padrões de código C | `[ ]` | | |
| F0-05 | Plataforma: texto, caminhos e arquivos | `[ ]` | | |
| F0-06 | Plataforma: tempo, aleatoriedade e ambiente | `[ ]` | | |
| F0-07 | Plataforma: processos (spawn, pipes, ambiente) | `[ ]` | | |
| F0-08 | Plataforma: árvore de processos e identidade de PID | `[ ]` | | |
| F0-09 | Plataforma: sockets loopback, laço de eventos, timers e threads | `[ ]` | | |
| F0-10 | Utilitários sem I/O: UTF-8, JSON, YAML, regex | `[ ]` | | |
| F0-11 | Runner de conformidade e utilitários de teste | `[ ]` | | |
| F0-12 | Vendorização da UI (SDL3, SDL_ttf, Clay) | `[ ]` | | |
| F0-13 | Corpus de conformidade gerado do TS | `[ ]` | | |
| F0-14 | Spike de UI e relatório | `[ ]` | | |
| F0-15 | Proposta do procedimento de medição | `[ ]` | | |

### F1 — Vertical fina (ADR 7.18)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F1-01 | Core: ids, tempo, erros e tipos de domínio | `[ ]` | | |
| F1-02 | Core: eventos e custo de turno | `[ ]` | | |
| F1-03 | Core: Brief | `[ ]` | | |
| F1-04 | Core: documento de política | `[ ]` | | |
| F1-05 | Core: caminhos sensíveis e leitura comum | `[ ]` | | |
| F1-06 | Core: livro-caixa de orçamento | `[ ]` | | |
| F1-07 | Configuração, variáveis de ambiente e token de operador | `[ ]` | | |
| F1-08 | Store: abertura, PRAGMAs e migrações 1 a 10 | `[ ]` | | |
| F1-09 | Store: projetos, pastas, sessões e tasks | `[ ]` | | |
| F1-10 | Store: eventos, aprovações, artefatos, orçamentos e auditoria | `[ ]` | | |
| F1-11 | Adapters: manifesto, registry mínimo e probe | `[ ]` | | |
| F1-12 | Adapters: resolução de binário e montagem do spawn | `[ ]` | | |
| F1-13 | Adapters: adapter genérico de processo | `[ ]` | | |
| F1-14 | Adapters: mapper do Claude | `[ ]` | | |
| F1-15 | Daemon: servidor HTTP, guarda e token | `[ ]` | | |
| F1-16 | Daemon: barramento, SSE comum e `GET /events` | `[ ]` | | |
| F1-17 | Daemon: worktree por sessão e settings do gate | `[ ]` | | |
| F1-18 | Daemon: gerenciador de sessões mínimo | `[ ]` | | |
| F1-19 | Daemon: rotas mínimas | `[ ]` | | |
| F1-20 | Cliente HTTP em C | `[ ]` | | |
| F1-21 | CLI mínima | `[ ]` | | |
| F1-22 | CLI: `hub hook` | `[ ]` | | |
| F1-23 | Ponta a ponta com agente falso | `[ ]` | | |
| F1-24 | Prova real com o Claude | `[ ]` | | |

### F2 — Núcleo completo (paridade com SPEC-04)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F2-01 | Core: tokenizador de shell | `[ ]` | | |
| F2-02 | Core: classificador, parte 1 | `[ ]` | | |
| F2-03 | Core: classificador, parte 2 | `[ ]` | | |
| F2-04 | Core: motor de política | `[ ]` | | |
| F2-05 | Core: edição de política, pastas e conversa de replay | `[ ]` | | |
| F2-06 | Core: grafo e resiliência | `[ ]` | | |
| F2-07 | Core: workflow | `[ ]` | | |
| F2-08 | Core: preços e custo | `[ ]` | | |
| F2-09 | Core: ambiente do agente e auditoria | `[ ]` | | |
| F2-10 | Daemon: config do projeto, confiança e política efetiva | `[ ]` | | |
| F2-11 | Daemon: delegação e máquina de estados completa | `[ ]` | | |
| F2-12 | Daemon: orçamento do fluxo | `[ ]` | | |
| F2-13 | Daemon: retry, fallback, validação e revisão | `[ ]` | | |
| F2-14 | Daemon: gate pré-execução | `[ ]` | | |
| F2-15 | Daemon: vigilância reativa e aprovações | `[ ]` | | |
| F2-16 | Daemon: send, interrupt, pause, handoff e adoção | `[ ]` | | |
| F2-17 | Daemon: retenção, compactação, espaço do banco e reaper | `[ ]` | | |
| F2-18 | Daemon: captura de diff e artefatos | `[ ]` | | |
| F2-19 | Levantamento de DV-13 no código TS | `[ ]` | | |

### F3 — Os 9 adapters e o gate (ADR 7.8)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F3-01 | Codex: mapper e injeção do gate | `[ ]` | | |
| F3-02 | Copilot: mapper | `[ ]` | | |
| F3-03 | Kimi: mapper | `[ ]` | | |
| F3-04 | Antigravity: mapper | `[ ]` | | |
| F3-05 | Mappers genéricos (mimo, cursor, opencode por processo) | `[ ]` | | |
| F3-06 | OpenCode: servidor, sessão, prompt e fim de turno | `[ ]` | | |
| F3-07 | OpenCode: eventos e permissões | `[ ]` | | |
| F3-08 | Registry completo | `[ ]` | | |
| F3-09 | Descoberta e absorção | `[ ]` | | |
| F3-10 | Integração dos 9 no serviço e cobertura do gate | `[ ]` | | |
| F3-11 | Prova real por agente | `[ ]` | | |

### F4 — API HTTP completa (58 rotas, SSE) e MCP (16 tools)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F4-01 | Rotas de saúde, agentes e descoberta; comportamento fora da tabela | `[ ]` | | |
| F4-02 | API REST de tasks e SSE de task | `[ ]` | | |
| F4-03 | Rotas de projetos | `[ ]` | | |
| F4-04 | Rotas de sessões e tasks | `[ ]` | | |
| F4-05 | Aprovações e manutenção | `[ ]` | | |
| F4-06 | Política e auditoria | `[ ]` | | |
| F4-07 | Orçamento, workflows e grafo | `[ ]` | | |
| F4-08 | Integrações (gate e MCP nas configs dos agentes) | `[ ]` | | |
| F4-09 | Conformidade da tabela de rotas | `[ ]` | | |
| F4-10 | MCP: transporte e ciclo de vida | `[ ]` | | |
| F4-11 | MCP: identidade, adoção, escopo e erros | `[ ]` | | |
| F4-12 | MCP: tools 1 a 8 | `[ ]` | | |
| F4-13 | MCP: tools 9 a 16 | `[ ]` | | |
| F4-14 | Levantamento dos erros de domínio por rota | `[ ]` | | |

### F5 — CLI completa (46 comandos)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F5-01 | Parser, ajuda, erros e `--json` | `[ ]` | | |
| F5-02 | Ciclo de vida do serviço | `[ ]` | | |
| F5-03 | Backup e restauração | `[ ]` | | |
| F5-04 | `hooks` e `mcp` (configuração offline) | `[ ]` | | |
| F5-05 | Agentes, doctor, descoberta e importação | `[ ]` | | |
| F5-06 | Projetos | `[ ]` | | |
| F5-07 | Sessões e acompanhamento | `[ ]` | | |
| F5-08 | Delegação, resultado e custo | `[ ]` | | |
| F5-09 | `merge` e `apply` | `[ ]` | | |
| F5-10 | Aprovações, manutenção, política e auditoria | `[ ]` | | |
| F5-11 | Workflows | `[ ]` | | |
| F5-12 | `init`, `open`, `autostart` e `update` | `[ ]` | | |
| F5-13 | Conformidade dos 46 comandos | `[ ]` | | |

### F6 — UI nativa (SDL3 + SDL_ttf + Clay) e bandeja

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F6-01 | Base da janela | `[ ]` | | |
| F6-02 | Widgets próprios | `[ ]` | | |
| F6-03 | Foco, teclado, diálogos e gavetas | `[ ]` | | |
| F6-04 | Toasts, estados de tela, ocupado e formatação | `[ ]` | | |
| F6-05 | Estado ao vivo | `[ ]` | | |
| F6-06 | Timeline | `[ ]` | | |
| F6-07 | Topbar, abas, menu e paleta | `[ ]` | | |
| F6-08 | Fila de aprovações, boas-vindas e notificação | `[ ]` | | |
| F6-09 | Aba Timeline: fluxos, centro e compositor | `[ ]` | | |
| F6-10 | Painel direito | `[ ]` | | |
| F6-11 | Swarm, Grafo DAG e Telemetria | `[ ]` | | |
| F6-12 | Operação: Sessão e Workflow | `[ ]` | | |
| F6-13 | Operação: Projeto, Saúde e Manutenção | `[ ]` | | |
| F6-14 | Segurança: Política e Confiança | `[ ]` | | |
| F6-15 | Segurança: Gate e MCP, Aprovações e Auditoria | `[ ]` | | |
| F6-16 | Configurações e Agentes detectados | `[ ]` | | |
| F6-17 | Modais e confirmações | `[ ]` | | |
| F6-18 | Bandeja e ciclo de vida | `[ ]` | | |
| F6-19 | Conformidade dos 198 controles e acessibilidade | `[ ]` | | |

### F7 — Migração de dados e cofre do SO

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F7-01 | Proposta de desenho: migração e cofre | `[ ]` | | |
| F7-02 | Migração do banco na primeira execução | `[ ]` | | |
| F7-03 | Cofre no Windows | `[ ]` | | |
| F7-04 | Cofre no Linux | `[ ]` | | |
| F7-05 | Env por projeto no cofre | `[ ]` | | |
| F7-06 | Auditoria de segurança do cofre e da migração | `[ ]` | | |

### F8 — Instalador, atualizador e AppImage

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F8-01 | Layout de instalação | `[ ]` | | |
| F8-02 | Instalador Windows | `[ ]` | | |
| F8-03 | AppImage | `[ ]` | | |
| F8-04 | Proposta do esquema de chave e manifesto de atualização | `[ ]` | | |
| F8-05 | Chave de assinatura e assinatura da release | `[ ]` | | |
| F8-06 | Atualizador | `[ ]` | | |
| F8-07 | Pipeline de release | `[ ]` | | |
| F8-08 | Auditoria do instalador e do atualizador | `[ ]` | | |

### F9 — Desempenho, prova real e corte do TS

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F9-01 | Harness de medição | `[ ]` | | |
| F9-02 | Serviço: RAM, CPU parado, início e vazão | `[ ]` | | |
| F9-03 | Hook do gate e MCP server | `[ ]` | | |
| F9-04 | Tamanho instalado | `[ ]` | | |
| F9-05 | Matriz final de conformidade | `[ ]` | | |
| F9-06 | Prova real final | `[ ]` | | |
| F9-07 | Auditoria de segurança final | `[ ]` | | |
| F9-08 | Corte do TS | `[ ]` | | |

## Pendências DV e DA

Descrição, fonte e tarefas bloqueadas ficam no plano (§2 e §3). Aqui fica só a decisão do dono e a
data. Estado: `aberta` ou `decidida`.

| ID | Estado | Decisão do dono | Data | Tarefas destravadas |
|---|---|---|---|---|
| DV-01 | aberta | | | |
| DV-02 | aberta | | | |
| DV-03 | aberta | | | |
| DV-04 | aberta | | | |
| DV-05 | aberta | | | |
| DV-06 | aberta | | | |
| DV-07 | aberta | | | |
| DV-08 | aberta | | | |
| DV-09 | aberta | | | |
| DV-10 | aberta | | | |
| DV-11 | aberta | | | |
| DV-12 | aberta | | | |
| DV-13 | aberta | | | |
| DV-14 | aberta | | | |
| DV-15 | aberta | | | |
| DV-16 | aberta | | | |
| DV-17 | aberta | | | |
| DV-18 | aberta | | | |
| DV-19 | aberta | | | |
| DV-20 | aberta | | | |
| DV-21 | aberta | | | |
| DV-22 | aberta | | | |
| DV-23 | aberta | | | |
| DV-24 | aberta | | | |
| DV-25 | aberta | | | |
| DV-26 | aberta | | | |
| DV-27 | aberta | | | |
| DV-28 | aberta | | | |
| DV-29 | aberta | | | |
| DV-30 | aberta | | | |
| DV-31 | aberta | | | |
| DV-32 | aberta | | | |
| DV-33 | aberta | | | |
| DV-34 | aberta | | | |
| DV-35 | aberta | | | |
| DV-36 | aberta | | | |
| DV-37 | aberta | | | |
| DV-38 | aberta | | | |
| DV-39 | aberta | | | |
| DV-40 | aberta | | | |
| DV-41 | aberta | | | |
| DV-42 | aberta | | | |
| DV-43 | aberta | | | |
| DV-44 | aberta | | | |
| DV-45 | aberta | | | |
| DA-01 | aberta | | | |
| DA-02 | aberta | | | |
| DA-03 | aberta | | | |
| DA-04 | aberta | | | |
| DA-05 | aberta | | | |
| DA-06 | aberta | | | |
| DA-07 | aberta | | | |
| DA-08 | aberta | | | |
| DA-09 | aberta | | | |
| DA-10 | aberta | | | |
| DA-11 | aberta | | | |
| DA-12 | aberta | | | |
| DA-13 | aberta | | | |
| DA-14 | aberta | | | |
| DA-15 | aberta | | | |
| DA-16 | aberta | | | |
| DA-17 | aberta | | | |
| DA-18 | aberta | | | |
| DA-19 | aberta | | | |
| DA-20 | aberta | | | |
| DA-21 | aberta | | | |
| DA-22 | aberta | | | |
| DA-23 | aberta | | | |
| DA-24 | aberta | | | |
| DA-25 | aberta | | | |
| DA-26 | aberta | | | |
| DA-27 | aberta | | | |
| DA-28 | aberta | | | |
| DA-29 | aberta | | | |

## Registros

Resultados que não são de uma tarefa só (relatório do spike F0-14, medições, provas reais), com data e
caminho.

| Data | O quê | Onde |
|---|---|---|
